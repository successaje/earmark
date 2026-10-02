"use client";

import { useState } from "react";
import type { ProgramContext } from "./useProgramContext";
import { type Address, getAddress, isAddress, parseUnits, stringToHex } from "viem";
import { Card, formatAmount } from "~~/components/earmark/primitives";
import { useHederaWrite, useTokenRelationship } from "~~/hooks/earmark";
import { GAS } from "~~/utils/earmark/abis";
import type { Charter } from "~~/utils/earmark/messages";

export function FunderPanel({ ctx }: { ctx: ProgramContext }) {
  const open = ctx.status === "Active" && Date.now() / 1000 < Number(ctx.program!.expiry);
  if (!open) return null;

  return (
    <Card title="Funder">
      <div className="grid gap-6 md:grid-cols-2">
        <Allocate ctx={ctx} />
        <ApproveMerchant ctx={ctx} />
        <ExtendExpiry ctx={ctx} />
      </div>
    </Card>
  );
}

function Allocate({ ctx }: { ctx: ProgramContext }) {
  const { write, isPending } = useHederaWrite();
  const [lines, setLines] = useState("");
  const program = ctx.program!;
  const available = program.funded - program.allocated;

  const parsed = lines
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [who, amount] = line.split(/[,\s]+/);
      try {
        return isAddress(who ?? "") && amount
          ? { who: getAddress(who), amount: parseUnits(amount, ctx.decimals) }
          : null;
      } catch {
        return null;
      }
    });
  const valid = parsed.length > 0 && parsed.every(Boolean);
  const total = parsed.reduce((sum, p) => sum + (p?.amount ?? 0n), 0n);

  const submit = async () => {
    const entries = parsed.filter((p): p is { who: Address; amount: bigint } => p !== null);
    await write({
      ...ctx.earmark!,
      functionName: "allocate",
      args: [ctx.id, entries.map(e => e.who), entries.map(e => e.amount)],
      gas: GAS.allocate + BigInt(entries.length) * 50_000n,
    });
    setLines("");
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold m-0">Enrol beneficiaries</h3>
      <p className="text-xs opacity-70 m-0">
        One per line: <code>0xAddress, amount</code>. {formatAmount(available, ctx.decimals)} {ctx.backingSymbol} left
        to allocate. Beneficiaries then claim from this page.
      </p>
      <textarea
        className="textarea w-full font-mono text-xs"
        rows={4}
        placeholder="0x1234…abcd, 25"
        value={lines}
        onChange={e => setLines(e.target.value)}
      />
      <button className="btn btn-sm btn-primary" disabled={!valid || total > available || isPending} onClick={submit}>
        Allocate {valid ? formatAmount(total, ctx.decimals) : ""}
      </button>
    </div>
  );
}

function ApproveMerchant({ ctx }: { ctx: ProgramContext }) {
  const { write, isPending } = useHederaWrite();
  const categories = (ctx.charter?.envelope.body as Charter | undefined)?.categories ?? ["GENERAL"];
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState(categories[0]);
  const merchantAddress = isAddress(merchant) ? getAddress(merchant) : undefined;
  const { data: relationship } = useTokenRelationship(ctx.program!.voucher, merchantAddress);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold m-0">Approve a merchant</h3>
      <p className="text-xs opacity-70 m-0">
        Grants the merchant KYC on the voucher so it can receive and redeem. It must associate first, from the
        &quot;Join&quot; card on this page.
      </p>
      <input
        className="input input-sm w-full font-mono"
        placeholder="0xMerchant"
        value={merchant}
        onChange={e => setMerchant(e.target.value.trim())}
      />
      <select className="select select-sm w-full" value={category} onChange={e => setCategory(e.target.value)}>
        {categories.map(c => (
          <option key={c}>{c}</option>
        ))}
      </select>
      {merchantAddress && relationship && !relationship.associated && (
        <p className="text-xs text-warning m-0">Not associated with the voucher yet.</p>
      )}
      <button
        className="btn btn-sm btn-primary"
        disabled={!merchantAddress || !relationship?.associated || isPending}
        onClick={() =>
          write({
            ...ctx.earmark!,
            functionName: "approveMerchant",
            args: [ctx.id, merchantAddress, stringToHex(category, { size: 32 })],
            gas: GAS.approveMerchant,
          })
        }
      >
        Approve merchant
      </button>
    </div>
  );
}

function ExtendExpiry({ ctx }: { ctx: ProgramContext }) {
  const { write, isPending } = useHederaWrite();
  const [minutes, setMinutes] = useState("60");
  const extra = Math.round(Number(minutes) * 60);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold m-0">Extend the spending window</h3>
      <p className="text-xs opacity-70 m-0">
        Deletes the pending Hedera schedule and creates a new one. Expiry can only move later, never earlier.
      </p>
      <div className="join">
        <input
          className="input input-sm join-item w-full"
          inputMode="numeric"
          value={minutes}
          onChange={e => setMinutes(e.target.value)}
        />
        <span className="join-item btn btn-sm btn-disabled">minutes</span>
      </div>
      <button
        className="btn btn-sm btn-outline"
        disabled={!(extra > 0) || isPending}
        onClick={() =>
          write({
            ...ctx.earmark!,
            functionName: "extendExpiry",
            args: [ctx.id, ctx.program!.expiry + BigInt(extra)],
            gas: GAS.extendExpiry,
          })
        }
      >
        Extend
      </button>
    </div>
  );
}
