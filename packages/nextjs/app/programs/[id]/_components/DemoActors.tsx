"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProgramContext } from "./useProgramContext";
import {
  type Abi,
  type Address,
  type Hex,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  parseUnits,
  stringToHex,
} from "viem";
import { type PrivateKeyAccount, generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { usePublicClient, useSendTransaction } from "wagmi";
import { Card, ExternalLink } from "~~/components/earmark/primitives";
import { useAnchoringStatus, useChainId, useHederaWrite } from "~~/hooks/earmark";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { GAS, htsTokenAbi } from "~~/utils/earmark/abis";
import { type Receipt, documentHash, receiptTotal } from "~~/utils/earmark/messages";
import { fetchRevertReason } from "~~/utils/earmark/mirror";
import { hashscanTxUrl } from "~~/utils/earmark/network";

/**
 * Lets one wallet play the whole story. Two throwaway testnet accounts — a recipient and a shop — are created in this
 * browser, funded with a little HBAR from the funder's wallet, and act through buttons. Their keys never leave the
 * browser; only use this on testnet.
 */

const ACTOR_FUNDING = parseEther("10"); // HBAR each: covers association, claim, transfers and redemption gas
const ALLOWANCE = "20";
const BLOCKED_PAYMENT = "5";
const PAYMENT = "15";
const RECEIPT_ITEMS = [
  { description: "Rice, 5 kg", quantity: 1, unitPrice: "6" },
  { description: "Cooking oil, 1 L", quantity: 1, unitPrice: "4" },
];

type Actors = { recipient: Hex; shop: Hex };
type LogLine = { text: string; hash?: Hex; ok: boolean };
type StepId = "fund" | "activate" | "allow" | "claim" | "blocked" | "approve" | "pay" | "redeem";

const STEPS: { id: StepId; who: string; label: string }[] = [
  { id: "fund", who: "You", label: "Create a test recipient and shop (sends 10 HBAR to each)" },
  { id: "activate", who: "Recipient + shop", label: "Activate their wallets for the program credit" },
  { id: "allow", who: "You", label: `Give the recipient an allowance of ${ALLOWANCE}` },
  { id: "claim", who: "Recipient", label: "Activate funds" },
  { id: "blocked", who: "Recipient", label: `Pay the shop ${BLOCKED_PAYMENT} before it is approved` },
  { id: "approve", who: "You", label: "Approve the shop" },
  { id: "pay", who: "Recipient", label: `Pay the shop ${PAYMENT}` },
  { id: "redeem", who: "Shop", label: "Sign an itemised receipt and get paid for 10" },
];

export function DemoActors({ ctx }: { ctx: ProgramContext }) {
  const chainId = useChainId();
  const { targetNetwork } = useTargetNetwork();
  const publicClient = usePublicClient();
  const { sendTransactionAsync } = useSendTransaction();
  const { write } = useHederaWrite();
  const { data: anchoring } = useAnchoringStatus();

  const storageKey = `earmark-demo:${chainId}:${ctx.earmark?.address}:${ctx.id}`;
  const [actors, setActors] = useState<Actors | null>(null);
  const [done, setDone] = useState<StepId[]>([]);
  const [running, setRunning] = useState<StepId | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved) as { actors: Actors; done: StepId[] };
        setActors(parsed.actors);
        setDone(parsed.done);
      }
    } catch {
      // Storage unavailable (private mode): the demo still works for this page view.
    }
  }, [storageKey]);

  const persist = (nextActors: Actors | null, nextDone: StepId[]) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ actors: nextActors, done: nextDone }));
    } catch {
      // Ignore: persistence is a convenience.
    }
  };

  const accounts = useMemo(
    () =>
      actors ? { recipient: privateKeyToAccount(actors.recipient), shop: privateKeyToAccount(actors.shop) } : null,
    [actors],
  );

  const program = ctx.program!;
  const decimals = ctx.decimals;
  const units = (value: string) => parseUnits(value, decimals);

  const actAs = async (
    account: PrivateKeyAccount,
    call: { address: string; abi: Abi | readonly unknown[]; functionName: string; args?: readonly unknown[] },
    gas: bigint,
  ) => {
    const wallet = createWalletClient({ account, chain: targetNetwork, transport: http(publicClient!.transport.url) });
    const hash = await wallet.writeContract({
      ...call,
      address: call.address as Address,
      gas,
      account,
      chain: targetNetwork,
    } as Parameters<typeof wallet.writeContract>[0]);
    const receipt = await publicClient!.waitForTransactionReceipt({ hash });
    return { hash, ok: receipt.status === "success" };
  };

  const note = (line: LogLine) => setLog(current => [...current, line]);

  const steps: Record<StepId, () => Promise<void>> = {
    fund: async () => {
      const next = { recipient: generatePrivateKey(), shop: generatePrivateKey() };
      for (const key of [next.recipient, next.shop]) {
        const hash = await sendTransactionAsync({ to: privateKeyToAccount(key).address, value: ACTOR_FUNDING });
        await publicClient!.waitForTransactionReceipt({ hash });
        note({ text: `Funded ${privateKeyToAccount(key).address.slice(0, 10)}…`, hash, ok: true });
      }
      setActors(next);
      persist(next, ["fund"]);
    },
    activate: async () => {
      for (const [name, account] of Object.entries(accounts!)) {
        const tx = await actAs(
          account,
          { address: program.voucher, abi: htsTokenAbi, functionName: "associate" },
          GAS.associate,
        );
        note({ text: `${name} activated its wallet (HIP-719 association)`, ...tx });
      }
    },
    allow: async () => {
      const hash = await write({
        ...ctx.earmark!,
        functionName: "allocate",
        args: [ctx.id, [accounts!.recipient.address], [units(ALLOWANCE)]],
        gas: GAS.allocate,
      });
      note({ text: `Gave the recipient ${ALLOWANCE} ${ctx.symbol}`, hash, ok: Boolean(hash) });
    },
    claim: async () => {
      const tx = await actAs(
        accounts!.recipient,
        { ...ctx.earmark!, functionName: "claim", args: [ctx.id] },
        GAS.claim,
      );
      note({ text: "Recipient activated its funds (KYC granted + credit received)", ...tx });
    },
    blocked: async () => {
      const tx = await actAs(
        accounts!.recipient,
        {
          address: program.voucher,
          abi: htsTokenAbi,
          functionName: "transfer",
          args: [accounts!.shop.address, units(BLOCKED_PAYMENT)],
        },
        GAS.transfer,
      );
      const reason = tx.ok ? "unexpectedly accepted" : await fetchRevertReason(chainId, tx.hash);
      note({ text: `Hedera rejected the payment: ${reason}`, hash: tx.hash, ok: !tx.ok });
    },
    approve: async () => {
      const hash = await write({
        ...ctx.earmark!,
        functionName: "approveMerchant",
        args: [ctx.id, accounts!.shop.address, stringToHex("GROCERIES", { size: 32 })],
        gas: GAS.approveMerchant,
      });
      note({ text: "Approved the shop (KYC granted)", hash, ok: Boolean(hash) });
    },
    pay: async () => {
      const tx = await actAs(
        accounts!.recipient,
        {
          address: program.voucher,
          abi: htsTokenAbi,
          functionName: "transfer",
          args: [accounts!.shop.address, units(PAYMENT)],
        },
        GAS.transfer,
      );
      note({ text: `Recipient paid the shop ${PAYMENT} ${ctx.symbol}`, ...tx });
    },
    redeem: async () => {
      const shop = accounts!.shop;
      const items: Receipt["items"] = RECEIPT_ITEMS.map(i => ({ ...i, unitPrice: units(i.unitPrice).toString() }));
      const receipt: Receipt = {
        kind: "earmark.receipt",
        version: 1,
        chainId,
        earmark: getAddress(ctx.earmark!.address),
        programId: ctx.id.toString(),
        merchant: shop.address,
        items,
        total: receiptTotal(items).toString(),
        issuedAt: new Date().toISOString(),
      };
      const receiptHash = documentHash(receipt);
      const signature = await shop.signMessage({ message: { raw: receiptHash } });
      if (anchoring?.anchoring) {
        const res = await fetch("/api/hcs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "receipt", body: receipt, signature }),
        });
        note({ text: res.ok ? "Shop's signed receipt anchored on HCS" : "Receipt anchoring failed", ok: res.ok });
      }
      const tx = await actAs(
        shop,
        { ...ctx.earmark!, functionName: "redeem", args: [ctx.id, BigInt(receipt.total), receiptHash] },
        GAS.redeem,
      );
      note({
        text: `Shop was paid ${ctx.backingSymbol} for the receipt; the other 5 settle automatically at expiry`,
        ...tx,
      });
    },
  };

  const run = async (id: StepId) => {
    setRunning(id);
    try {
      await steps[id]();
      const next = [...done.filter(d => d !== id), id];
      setDone(next);
      // The fund step saves the freshly created actors itself; `actors` here is still the previous render's value.
      if (id !== "fund") persist(actors, next);
    } catch (e) {
      note({ text: e instanceof Error ? e.message.split("\n")[0] : "Step failed", ok: false });
    } finally {
      setRunning(null);
    }
  };

  const nextStep = STEPS.find(s => !done.includes(s.id));

  return (
    <Card
      title="Play every role from one wallet"
      actions={<span className="badge badge-outline badge-sm">testnet demo</span>}
    >
      <p className="text-sm opacity-80 mt-0">
        Creates a throwaway recipient and shop in this browser, funded from your wallet, and walks through the whole
        story. You confirm the funder&apos;s steps in your wallet; the others sign with keys stored only in this
        browser.
      </p>
      <ol className="flex flex-col gap-2 m-0 p-0 list-none">
        {STEPS.map(step => {
          const isDone = done.includes(step.id);
          const isNext = nextStep?.id === step.id;
          return (
            <li key={step.id} className="flex items-center gap-3 text-sm">
              <span className={`w-5 text-center ${isDone ? "text-success" : "opacity-40"}`}>{isDone ? "✓" : "•"}</span>
              <span className="badge badge-ghost badge-sm w-28 justify-center">{step.who}</span>
              <span className={`grow ${isDone ? "opacity-60" : ""}`}>{step.label}</span>
              {isNext && (
                <button className="btn btn-xs btn-primary" disabled={running !== null} onClick={() => run(step.id)}>
                  {running === step.id ? <span className="loading loading-spinner loading-xs" /> : "Run"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {log.length > 0 && (
        <ul className="mt-4 mb-0 p-3 bg-base-200 rounded-xl flex flex-col gap-1 list-none text-xs">
          {log.map((line, i) => (
            <li key={i} className={line.ok ? "" : "text-error"}>
              {line.ok ? "✓" : "✕"} {line.text}{" "}
              {line.hash && <ExternalLink href={hashscanTxUrl(chainId, line.hash)}>tx</ExternalLink>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
