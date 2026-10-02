"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { type Address, getAddress, isAddress, parseEther, parseEventLogs, parseUnits, zeroAddress } from "viem";
import { useAccount, usePublicClient, useReadContracts, useSignMessage } from "wagmi";
import { Amount, Card } from "~~/components/earmark/primitives";
import { useAnchoringStatus, useChainId, useHederaWrite } from "~~/hooks/earmark";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-hbar";
import { GAS, htsTokenAbi } from "~~/utils/earmark/abis";
import { type Charter, documentHash } from "~~/utils/earmark/messages";
import { addressFromEntityId } from "~~/utils/earmark/network";
import { notification } from "~~/utils/scaffold-hbar";

const UNIT_SECONDS = { minutes: 60, hours: 3600, days: 86_400 } as const;
type Unit = keyof typeof UNIT_SECONDS;

type Step = "idle" | "charter" | "approve" | "create";
const STEP_LABEL: Record<Step, string> = {
  idle: "Create program",
  charter: "Signing & anchoring charter…",
  approve: "Approving escrow…",
  create: "Creating voucher & schedule…",
};

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

  const [title, setTitle] = useState("Neighbourhood food fund");
  const [symbol, setSymbol] = useState("eFOOD");
  const [purpose, setPurpose] = useState("Groceries for enrolled households at approved local shops.");
  const [categories, setCategories] = useState("GROCERIES, PRODUCE");
  const [amount, setAmount] = useState("100");
  const [duration, setDuration] = useState("10");
  const [unit, setUnit] = useState<Unit>("minutes");
  const [customBacking, setCustomBacking] = useState("");
  const [hbarForFees, setHbarForFees] = useState("30");
  const [step, setStep] = useState<Step>("idle");

  const backing = resolveBacking(customBacking) ?? (dusd && dusd !== zeroAddress ? dusd : undefined);
  const usingDemoDollar = Boolean(backing && dusd && backing === dusd);

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

  const amountUnits = safeParseUnits(amount, decimals);
  const seconds = Math.round(Number(duration) * UNIT_SECONDS[unit]);
  const categoryList = categories
    .split(",")
    .map(c => c.trim().toUpperCase())
    .filter(Boolean);

  const problems = [
    !funder && "Connect a wallet",
    !backing && "Choose a backing token",
    amountUnits === null || amountUnits === 0n ? "Enter an amount" : null,
    amountUnits !== null && amountUnits > balance && `Not enough ${backingSymbol || "backing"} in your wallet`,
    (seconds < 60 || seconds > 60 * 86_400) && "Duration must be between 1 minute and 60 days",
    categoryList.length === 0 && "Add at least one category",
  ].filter(Boolean) as string[];

  const drip = async () => {
    if (!demoDollar) return;
    await write({ address: demoDollar.address, abi: demoDollar.abi, functionName: "drip", gas: GAS.drip });
    await refetchBacking();
  };

  const submit = async () => {
    if (!funder || !backing || !earmark || !publicClient || amountUnits === null || problems.length) return;
    try {
      setStep("charter");
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

      if (allowance < amountUnits) {
        setStep("approve");
        await write({
          address: backing,
          abi: htsTokenAbi,
          functionName: "approve",
          args: [earmark.address, amountUnits],
          gas: GAS.approve,
        });
      }

      setStep("create");
      const expiry = BigInt(Math.floor(Date.now() / 1000) + seconds);
      const hash = await write({
        address: earmark.address,
        abi: earmark.abi,
        functionName: "createProgram",
        args: [{ backing, amount: amountUnits, expiry, name: title, symbol, charterHash }],
        value: parseEther(hbarForFees || "0"),
        gas: GAS.createProgram,
      });
      if (!hash) return;

      const receipt = await publicClient.getTransactionReceipt({ hash });
      const created = parseEventLogs({ abi: earmark.abi, logs: receipt.logs, eventName: "ProgramCreated" })[0];
      if (created) router.push(`/programs/${created.args.id}`);
    } catch (e) {
      notification.error(e instanceof Error ? e.message.split("\n")[0] : "Something went wrong");
    } finally {
      setStep("idle");
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card title="Charter">
        <div className="grid gap-4">
          <Field label="Title" hint="Also the voucher token's name">
            <input className="input w-full" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Voucher symbol">
              <input
                className="input w-full"
                value={symbol}
                maxLength={12}
                onChange={e => setSymbol(e.target.value.toUpperCase())}
              />
            </Field>
            <Field label="Merchant categories" hint="Comma separated">
              <input className="input w-full" value={categories} onChange={e => setCategories(e.target.value)} />
            </Field>
          </div>
          <Field label="Purpose" hint="Published on HCS and hashed into the contract">
            <textarea
              className="textarea w-full"
              rows={3}
              maxLength={280}
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Amount to escrow${backingSymbol ? ` (${backingSymbol})` : ""}`}>
              <input
                className="input w-full"
                inputMode="decimal"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Spending window" hint="Settlement runs automatically when it ends">
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
              <Field label="Backing token" hint="Any HTS fungible token: 0.0.x id or EVM address. Defaults to dUSD.">
                <input
                  className="input w-full"
                  placeholder="e.g. 0.0.429274 (Circle USDC on testnet)"
                  value={customBacking}
                  onChange={e => setCustomBacking(e.target.value.trim())}
                />
              </Field>
              <Field
                label="HBAR for network fees"
                hint="Pays voucher creation (~12 HBAR) and settlement; the rest is refunded at close"
              >
                <input
                  className="input w-full"
                  inputMode="decimal"
                  value={hbarForFees}
                  onChange={e => setHbarForFees(e.target.value)}
                />
              </Field>
            </div>
          </details>

          {problems.length > 0 && funder && <p className="text-sm text-warning m-0">{problems[0]}</p>}
          <button className="btn btn-primary" disabled={step !== "idle" || problems.length > 0} onClick={submit}>
            {step !== "idle" && <span className="loading loading-spinner loading-sm" />}
            {STEP_LABEL[step]}
          </button>
          {anchoring && !anchoring.anchoring && (
            <p className="text-xs opacity-70 m-0">
              HCS anchoring is off on this server (no operator configured). The charter hash still goes on-chain.
            </p>
          )}
        </div>
      </Card>

      <aside className="flex flex-col gap-4">
        <Card title="Your escrow">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <span className="opacity-70">Balance</span>
              <Amount value={balance} decimals={decimals} symbol={backingSymbol} />
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">Approved to Earmark</span>
              <Amount value={allowance} decimals={decimals} symbol={backingSymbol} />
            </div>
            {usingDemoDollar && (
              <button className="btn btn-sm btn-outline" onClick={drip} disabled={!funder}>
                Get 1,000 dUSD (testnet faucet)
              </button>
            )}
          </div>
        </Card>
        <Card title="What happens">
          <ol className="list-decimal list-inside text-sm flex flex-col gap-2 m-0 p-0 opacity-80">
            <li>You sign the charter; its hash is anchored on HCS.</li>
            <li>Earmark pulls your escrow and mints a voucher token it controls (KYC, wipe, pause keys).</li>
            <li>In the same transaction it schedules its own settlement with the Hedera Schedule Service.</li>
            <li>You enrol beneficiaries and approve merchants from the program page.</li>
          </ol>
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
