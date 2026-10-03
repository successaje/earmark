"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { type Address, getAddress, isAddress, parseEther, parseEventLogs, parseUnits, zeroAddress } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useReadContracts, useSignMessage } from "wagmi";
import { Amount, Card, formatAmount, formatDuration } from "~~/components/earmark/primitives";
import { useAnchoringStatus, useChainId, useHederaWrite } from "~~/hooks/earmark";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-hbar";
import { GAS, htsTokenAbi, saucerSwapRouterAbi } from "~~/utils/earmark/abis";
import { type Charter, documentHash } from "~~/utils/earmark/messages";
import { fetchHbarUsd } from "~~/utils/earmark/mirror";
import { addressFromEntityId, hederaNetwork } from "~~/utils/earmark/network";
import { notification } from "~~/utils/scaffold-hbar";

const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86_400 } as const;
type Unit = keyof typeof UNIT_SECONDS;

/**
 * Voucher creation costs about $1 of HBAR and each scheduled settlement run a few cents; whatever the program does
 * not use is refunded at close, so the recommendation errs high.
 */
const RESERVE_USD = 2.5;
const SLIPPAGE_BPS = 100;
const FALLBACK_RESERVE_HBAR = 30;

type Preset = {
  name: string;
  title: string;
  purpose: string;
  categories: string;
  duration: string;
  unit: Unit;
};

const PRESETS: Preset[] = [
  {
    name: "Food assistance",
    title: "Neighbourhood food fund",
    purpose: "Groceries for enrolled households at approved local shops.",
    categories: "GROCERIES, PRODUCE",
    duration: "10",
    unit: "minutes",
  },
  {
    name: "Employee allowance",
    title: "Team lunch allowance",
    purpose: "Weekday lunches for the team at partner restaurants. Unused allowance returns to the company.",
    categories: "RESTAURANTS",
    duration: "30",
    unit: "days",
  },
  {
    name: "Scholarship",
    title: "STEM bursary 2026",
    purpose: "Course fees, books and lab equipment for bursary holders at approved institutions and bookshops.",
    categories: "TUITION, BOOKS, EQUIPMENT",
    duration: "60",
    unit: "days",
  },
  {
    name: "Event credit",
    title: "Festival food credit",
    purpose: "Food and drink credit for festival volunteers, valid at accredited vendors for the weekend.",
    categories: "FOOD, DRINKS",
    duration: "3",
    unit: "days",
  },
];

type Step = "charter" | "approve" | "create";
const STEPS: { key: Step; label: string }[] = [
  { key: "charter", label: "Sign the charter (and anchor it on HCS)" },
  { key: "approve", label: "Approve Earmark to pull the escrow" },
  { key: "create", label: "Create the program: escrow, mint credit, schedule settlement" },
];

export function CreateProgramForm() {
  const router = useRouter();
  const chainId = useChainId();
  const { address: funder } = useAccount();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const { write } = useHederaWrite();
  const { data: anchoring } = useAnchoringStatus();
  const { data: earmark } = useDeployedContractInfo({ contractName: "Earmark" });
  const { data: demoDollar } = useDeployedContractInfo({ contractName: "DemoDollar" });
  const { data: dusd } = useScaffoldReadContract({ contractName: "DemoDollar", functionName: "token" });
  const { data: hbarUsd } = useQuery({
    queryKey: ["earmark", "hbar-usd", chainId],
    queryFn: () => fetchHbarUsd(chainId),
    staleTime: 10 * 60_000,
  });

  const [preset, setPreset] = useState(PRESETS[0].name);
  const [title, setTitle] = useState(PRESETS[0].title);
  const [symbolOverride, setSymbolOverride] = useState("");
  const [purpose, setPurpose] = useState(PRESETS[0].purpose);
  const [categories, setCategories] = useState(PRESETS[0].categories);
  const [amount, setAmount] = useState("100");
  const [duration, setDuration] = useState(PRESETS[0].duration);
  const [unit, setUnit] = useState<Unit>(PRESETS[0].unit);
  const [customBacking, setCustomBacking] = useState("");
  const [reserveOverride, setReserveOverride] = useState("");
  const [fundWith, setFundWith] = useState<"token" | "hbar">("token");
  const [hbarAmount, setHbarAmount] = useState("20");
  const [reviewing, setReviewing] = useState(false);
  const [progress, setProgress] = useState<Step | "done" | null>(null);

  const recommendedReserve = hbarUsd ? Math.ceil(RESERVE_USD / hbarUsd / 5) * 5 : FALLBACK_RESERVE_HBAR;
  const reserve = reserveOverride || String(recommendedReserve);
  const symbol = symbolOverride || symbolFrom(title);

  // Funding with HBAR: Earmark swaps through SaucerSwap into this network's swap stablecoin.
  const swapTokenId = hederaNetwork(chainId).swapBackingTokenId;
  const swapBacking = swapTokenId ? addressFromEntityId(swapTokenId) : undefined;
  const { data: dex } = useReadContracts({
    contracts: earmark
      ? [
          { ...earmark, functionName: "SWAP_ROUTER" },
          { ...earmark, functionName: "WHBAR" },
        ]
      : [],
    query: { enabled: Boolean(earmark), staleTime: Infinity },
  });
  const swapRouter = dex?.[0]?.result as Address | undefined;
  const whbar = dex?.[1]?.result as Address | undefined;
  const swapAvailable = Boolean(swapBacking && swapRouter && swapRouter !== zeroAddress && whbar);
  const viaHbar = fundWith === "hbar" && swapAvailable;
  const hbarIn = safeParseUnits(hbarAmount, 8); // tinybars
  const { data: quote } = useReadContract({
    address: swapRouter,
    abi: saucerSwapRouterAbi,
    functionName: "getAmountsOut",
    args: [hbarIn ?? 0n, [whbar ?? zeroAddress, swapBacking ?? zeroAddress]],
    query: { enabled: viaHbar && Boolean(hbarIn), refetchInterval: 15_000 },
  });
  const quotedOut = quote?.[1];
  const minOut = quotedOut === undefined ? undefined : (quotedOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const { data: hbarBalance } = useBalance({ address: funder, query: { enabled: viaHbar } });

  const backing = viaHbar
    ? swapBacking
    : (resolveBacking(customBacking) ?? (dusd && dusd !== zeroAddress ? dusd : undefined));
  const usingDemoDollar = !viaHbar && Boolean(backing && dusd && backing === dusd);

  const { data: backingState, refetch: refetchBacking } = useReadContracts({
    contracts: [
      { address: backing ?? zeroAddress, abi: htsTokenAbi, functionName: "decimals" },
      { address: backing ?? zeroAddress, abi: htsTokenAbi, functionName: "symbol" },
      { address: backing ?? zeroAddress, abi: htsTokenAbi, functionName: "balanceOf", args: [funder ?? zeroAddress] },
      {
        address: backing ?? zeroAddress,
        abi: htsTokenAbi,
        functionName: "allowance",
        args: [funder ?? zeroAddress, earmark?.address ?? zeroAddress],
      },
    ],
    query: { enabled: Boolean(backing && funder && earmark) },
  });
  const decimals = (backingState?.[0].result as number | undefined) ?? 6;
  const backingSymbol = (backingState?.[1].result as string | undefined) ?? "";
  const balance = (backingState?.[2].result as bigint | undefined) ?? 0n;
  const allowance = (backingState?.[3].result as bigint | undefined) ?? 0n;

  const amountUnits = viaHbar ? (quotedOut ?? null) : safeParseUnits(amount, decimals);
  const seconds = Math.round(Number(duration) * UNIT_SECONDS[unit]);
  const categoryList = categories
    .split(",")
    .map(c => c.trim().toUpperCase())
    .filter(Boolean);
  const needsApproval = !viaHbar && amountUnits !== null && allowance < amountUnits;
  const hbarNeeded = parseEther(String(Number(hbarAmount || "0") + Number(reserve || "0")));
  const busy = progress !== null && progress !== "done";

  const problems = [
    !funder && "Connect a wallet",
    !backing && "Choose a funding asset",
    amountUnits === null || amountUnits === 0n
      ? viaHbar
        ? "Waiting for a SaucerSwap quote"
        : "Enter an amount"
      : null,
    !viaHbar &&
      amountUnits !== null &&
      amountUnits > balance &&
      `Not enough ${backingSymbol || "funds"} in your wallet`,
    viaHbar && hbarBalance && hbarBalance.value < hbarNeeded && "Not enough HBAR for the swap plus the network reserve",
    (seconds < 60 || seconds > 60 * 86_400) && "The spending window must be between 1 minute and 60 days",
    categoryList.length === 0 && "Add at least one category",
    !title.trim() && "Give the program a name",
  ].filter(Boolean) as string[];

  const applyPreset = (p: Preset) => {
    setPreset(p.name);
    setTitle(p.title);
    setPurpose(p.purpose);
    setCategories(p.categories);
    setDuration(p.duration);
    setUnit(p.unit);
    setSymbolOverride("");
    setReviewing(false);
  };

  const drip = async () => {
    if (!demoDollar) return;
    await write({ address: demoDollar.address, abi: demoDollar.abi, functionName: "drip", gas: GAS.drip });
    await refetchBacking();
  };

  const submit = async () => {
    if (!funder || !backing || !earmark || !publicClient || amountUnits === null || problems.length) return;
    try {
      setProgress("charter");
      const charter: Charter = {
        kind: "earmark.charter",
        version: 1,
        chainId,
        earmark: getAddress(earmark.address),
        funder,
        title,
        purpose,
        categories: categoryList,
        issuedAt: new Date().toISOString(),
      };
      const charterHash = documentHash(charter);
      const signature = await signMessageAsync({ message: { raw: charterHash } });
      if (anchoring?.anchoring) {
        const res = await fetch("/api/hcs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "charter", body: charter, signature }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not anchor the charter");
      }

      setProgress("approve");
      if (needsApproval) {
        await write({
          address: backing,
          abi: htsTokenAbi,
          functionName: "approve",
          args: [earmark.address, amountUnits],
          gas: GAS.approve,
        });
      }

      setProgress("create");
      const expiry = BigInt(Math.floor(Date.now() / 1000) + seconds);
      const hash = viaHbar
        ? await write({
            address: earmark.address,
            abi: earmark.abi,
            functionName: "createProgramWithHbar",
            args: [{ backing, amount: 0n, expiry, name: title, symbol, charterHash }, hbarIn, minOut],
            value: hbarNeeded,
            gas: GAS.createProgramWithHbar,
          })
        : await write({
            address: earmark.address,
            abi: earmark.abi,
            functionName: "createProgram",
            args: [{ backing, amount: amountUnits, expiry, name: title, symbol, charterHash }],
            value: parseEther(reserve || "0"),
            gas: GAS.createProgram,
          });
      if (!hash) {
        setProgress(null);
        return;
      }

      setProgress("done");
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const created = parseEventLogs({ abi: earmark.abi, logs: receipt.logs, eventName: "ProgramCreated" })[0];
      if (created) router.push(`/programs/${created.args.id}`);
    } catch (e) {
      notification.error(e instanceof Error ? e.message.split("\n")[0] : "Something went wrong");
      setProgress(null);
    }
  };

  const policy = [
    viaHbar
      ? `Be backed 1:1 by the ${backingSymbol || "stablecoin"} that ${hbarAmount || "0"} HBAR buys on SaucerSwap (at least ${formatAmount(minOut, decimals)}), held in escrow by the contract`
      : `Be backed 1:1 by ${amount || "0"} ${backingSymbol || "of the funding asset"}, held in escrow by the contract`,
    "Only reach recipients you give it to and merchants you approve",
    `Be spendable for ${formatDuration(seconds)}, then stop`,
    "Ask merchants for signed, itemised receipts as proof of spend",
    "Return everything unspent to you automatically, with no administrator",
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-6">
        <Card title="Start from a template">
          <div className="flex flex-wrap gap-2">
            {PRESETS.map(p => (
              <button
                key={p.name}
                className={`btn btn-sm ${preset === p.name ? "btn-primary" : "btn-outline"}`}
                onClick={() => applyPreset(p)}
                disabled={busy}
              >
                {p.name}
              </button>
            ))}
          </div>
        </Card>

        <Card title="Program">
          <fieldset className="grid gap-4" disabled={busy}>
            <Field label="Name">
              <input className="input w-full" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} />
            </Field>
            <Field
              label="What is this money for?"
              hint="Published as the program's charter and hashed into the contract"
            >
              <textarea
                className="textarea w-full"
                rows={3}
                maxLength={280}
                value={purpose}
                onChange={e => setPurpose(e.target.value)}
              />
            </Field>
            <Field
              label="Merchant categories"
              hint="Comma separated. Labels for recipients and auditors; you approve each merchant individually."
            >
              <input className="input w-full" value={categories} onChange={e => setCategories(e.target.value)} />
            </Field>
            {swapAvailable && (
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">Fund with</span>
                <div role="tablist" className="tabs tabs-box w-fit">
                  <button
                    type="button"
                    role="tab"
                    className={`tab ${fundWith === "token" ? "tab-active" : ""}`}
                    onClick={() => setFundWith("token")}
                  >
                    A stablecoin I hold
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`tab ${fundWith === "hbar" ? "tab-active" : ""}`}
                    onClick={() => setFundWith("hbar")}
                  >
                    HBAR, swapped on SaucerSwap
                  </button>
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {viaHbar ? (
                <Field
                  label="HBAR to convert"
                  hint={
                    quotedOut === undefined
                      ? "Getting a SaucerSwap quote…"
                      : `≈ ${formatAmount(quotedOut, decimals)} ${backingSymbol} via SaucerSwap, at least ${formatAmount(minOut, decimals)} (${SLIPPAGE_BPS / 100}% slippage)`
                  }
                >
                  <input
                    className="input w-full"
                    inputMode="decimal"
                    value={hbarAmount}
                    onChange={e => setHbarAmount(e.target.value)}
                  />
                </Field>
              ) : (
                <Field label={`Budget${backingSymbol ? ` (${backingSymbol})` : ""}`}>
                  <input
                    className="input w-full"
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                </Field>
              )}
              <Field label="Can be spent for" hint="It closes itself when this ends">
                <div className="join w-full">
                  <input
                    className="input join-item w-full"
                    inputMode="decimal"
                    value={duration}
                    onChange={e => setDuration(e.target.value)}
                  />
                  <select className="select join-item" value={unit} onChange={e => setUnit(e.target.value as Unit)}>
                    {Object.keys(UNIT_SECONDS).map(u => (
                      <option key={u}>{u}</option>
                    ))}
                  </select>
                </div>
              </Field>
            </div>

            <details className="collapse collapse-arrow bg-base-200">
              <summary className="collapse-title text-sm font-medium">Advanced</summary>
              <div className="collapse-content grid gap-4">
                <Field
                  label="Credit symbol"
                  hint={`The HTS token symbol. Generated from the name: ${symbolFrom(title)}`}
                >
                  <input
                    className="input w-full"
                    placeholder={symbolFrom(title)}
                    value={symbolOverride}
                    maxLength={12}
                    onChange={e => setSymbolOverride(e.target.value.toUpperCase())}
                  />
                </Field>
                <Field
                  label="Funding asset"
                  hint="Any fee-free HTS fungible token, as 0.0.x or an EVM address. Defaults to dUSD."
                >
                  <input
                    className="input w-full"
                    placeholder="e.g. 0.0.429274 (Circle USDC on testnet)"
                    value={customBacking}
                    onChange={e => setCustomBacking(e.target.value.trim())}
                  />
                </Field>
                <Field
                  label="Network reserve (HBAR)"
                  hint={`Recommended ${recommendedReserve} HBAR (~$${RESERVE_USD}): pays credit creation and the scheduled settlement. Unused reserve is returned at close.`}
                >
                  <input
                    className="input w-full"
                    inputMode="decimal"
                    placeholder={String(recommendedReserve)}
                    value={reserveOverride}
                    onChange={e => setReserveOverride(e.target.value)}
                  />
                </Field>
              </div>
            </details>
          </fieldset>
        </Card>

        {anchoring && !anchoring.anchoring && (
          <div className="alert alert-warning text-sm">
            <span>
              <strong>Local-only evidence mode.</strong> Charters and receipts are still signed and their hashes go
              on-chain, but they are not published to HCS, so others cannot read them. Set HEDERA_OPERATOR_ID and
              HEDERA_OPERATOR_KEY in packages/nextjs/.env.local to enable anchoring.
            </span>
          </div>
        )}

        {!reviewing ? (
          <div className="flex flex-col gap-2">
            {problems.length > 0 && funder && <p className="text-sm text-warning m-0">{problems[0]}</p>}
            <button className="btn btn-primary" disabled={problems.length > 0} onClick={() => setReviewing(true)}>
              Review program
            </button>
          </div>
        ) : (
          <Card title="Review">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm m-0">
              <dt className="opacity-60">Program</dt>
              <dd className="m-0 font-medium">
                {title} <span className="opacity-60">({symbol})</span>
              </dd>
              <dt className="opacity-60">Budget</dt>
              <dd className="m-0">
                <Amount value={amountUnits ?? 0n} decimals={decimals} symbol={backingSymbol} />
              </dd>
              <dt className="opacity-60">Spendable for</dt>
              <dd className="m-0">{formatDuration(seconds)}, then closes automatically</dd>
              <dt className="opacity-60">Categories</dt>
              <dd className="m-0">{categoryList.join(", ")}</dd>
              <dt className="opacity-60">Network reserve</dt>
              <dd className="m-0">{reserve} HBAR, unused part returned at close</dd>
            </dl>

            <ol className="flex flex-col gap-2 mt-4 mb-0 p-0 list-none text-sm">
              {STEPS.filter(s => s.key !== "approve" || needsApproval).map((s, i) => {
                const order = STEPS.findIndex(x => x.key === s.key);
                const current = progress === "done" ? STEPS.length : STEPS.findIndex(x => x.key === progress);
                const state =
                  progress === null ? "todo" : order < current ? "done" : order === current ? "now" : "todo";
                return (
                  <li key={s.key} className="flex items-center gap-2">
                    {state === "done" ? (
                      <span className="text-success">✓</span>
                    ) : state === "now" ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <span className="opacity-40">{i + 1}.</span>
                    )}
                    <span className={state === "todo" ? "opacity-70" : ""}>{s.label}</span>
                  </li>
                );
              })}
            </ol>

            <div className="flex gap-2 mt-4">
              <button className="btn btn-ghost" disabled={busy} onClick={() => setReviewing(false)}>
                Back
              </button>
              <button className="btn btn-primary grow" disabled={busy || problems.length > 0} onClick={submit}>
                {busy ? "Waiting for your wallet…" : "Create program"}
              </button>
            </div>
          </Card>
        )}
      </div>

      <aside className="flex flex-col gap-4">
        <Card title="This money will">
          <ul className="flex flex-col gap-2 m-0 p-0 list-none text-sm">
            {policy.map(line => (
              <li key={line} className="flex gap-2">
                <span className="text-success">✓</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium">How Hedera enforces this</summary>
            <ul className="mt-2 flex flex-col gap-2 pl-4 opacity-80">
              <li>
                <strong>Token Service:</strong> the credit is an HTS token whose KYC key belongs to the contract, so
                transfers to unapproved accounts are rejected by the network.
              </li>
              <li>
                <strong>Schedule Service:</strong> the contract schedules its own settlement (HIP-1215) in the same
                transaction that creates the program.
              </li>
              <li>
                <strong>Consensus Service:</strong> the charter and merchants&apos; receipts are signed and anchored on
                an HCS topic; their hashes are recorded on-chain.
              </li>
            </ul>
          </details>
        </Card>
        <Card title="Your funds">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <span className="opacity-70">Balance</span>
              <Amount value={balance} decimals={decimals} symbol={backingSymbol} />
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Already approved</span>
              <Amount value={allowance} decimals={decimals} symbol={backingSymbol} />
            </div>
            {viaHbar && (
              <div className="flex justify-between">
                <span className="opacity-70">HBAR balance</span>
                <Amount value={hbarBalance?.value} decimals={18} symbol="HBAR" />
              </div>
            )}
            {usingDemoDollar && (
              <button className="btn btn-sm btn-outline" onClick={drip} disabled={!funder}>
                Get 1,000 dUSD (testnet faucet)
              </button>
            )}
          </div>
        </Card>
      </aside>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs opacity-60">{hint}</span>}
    </label>
  );
}

/** "Neighbourhood food fund" → "NFF"; single words keep their first letters ("Scholarship" → "SCHOL"). */
function symbolFrom(title: string): string {
  const words = title.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (words.length === 0) return "EARMARK";
  if (words.length === 1) return words[0].slice(0, 5);
  return words
    .map(w => w[0])
    .join("")
    .slice(0, 6);
}

function resolveBacking(input: string): Address | undefined {
  if (!input) return undefined;
  if (isAddress(input)) return getAddress(input);
  if (/^0\.0\.\d+$/.test(input)) return addressFromEntityId(input);
  return undefined;
}

function safeParseUnits(value: string, decimals: number): bigint | null {
  try {
    return parseUnits(value || "0", decimals);
  } catch {
    return null;
  }
}
