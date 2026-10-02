"use client";

import { useState } from "react";
import type { ProgramContext } from "./useProgramContext";
import { getAddress, parseUnits } from "viem";
import { useSignMessage } from "wagmi";
import { Amount, Card, formatAmount } from "~~/components/earmark/primitives";
import { useAnchoringStatus, useChainId, useHederaWrite, useTokenRelationship } from "~~/hooks/earmark";
import { GAS } from "~~/utils/earmark/abis";
import { type Receipt, documentHash, receiptTotal } from "~~/utils/earmark/messages";
import { notification } from "~~/utils/scaffold-hbar";

type Line = { description: string; quantity: string; unitPrice: string };
const EMPTY_LINE: Line = { description: "", quantity: "1", unitPrice: "" };
const MAX_LINES = 5;

export function MerchantPanel({ ctx }: { ctx: ProgramContext }) {
  const { write, isPending } = useHederaWrite();
  const program = ctx.program!;
  const { data: relationship } = useTokenRelationship(program.voucher, ctx.me);
  const balance = relationship?.balance ?? 0n;
  const redeemable = ctx.role.isMerchant && (ctx.status === "Active" || ctx.status === "Settling");

  return (
    <Card title="Accept payments">
      <div className="flex flex-col gap-4">
        <div className="flex gap-8 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider opacity-60 m-0">Received</p>
            <Amount value={balance} decimals={ctx.decimals} symbol={ctx.symbol} className="text-xl font-semibold" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider opacity-60 m-0">You will be paid</p>
            <Amount
              value={balance}
              decimals={ctx.decimals}
              symbol={ctx.backingSymbol}
              className="text-xl font-semibold"
            />
          </div>
        </div>

        {redeemable && balance > 0n && <ReceiptBuilder ctx={ctx} balance={balance} />}

        {ctx.role.owed > 0n && (
          <div className="alert alert-warning flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            <p className="m-0 text-sm grow">
              Settlement could not pay you {formatAmount(ctx.role.owed, ctx.decimals)} {ctx.backingSymbol} automatically
              (usually because your account is not associated with {ctx.backingSymbol}). Associate it, then withdraw.
            </p>
            <button
              className="btn btn-sm"
              disabled={isPending}
              onClick={() =>
                write({ ...ctx.earmark!, functionName: "withdrawOwed", args: [ctx.id], gas: GAS.withdrawOwed })
              }
            >
              Withdraw
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function ReceiptBuilder({ ctx, balance }: { ctx: ProgramContext; balance: bigint }) {
  const chainId = useChainId();
  const { write, isPending } = useHederaWrite();
  const { signMessageAsync } = useSignMessage();
  const { data: anchoring } = useAnchoringStatus();
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }]);
  const [busy, setBusy] = useState(false);

  const items = lines.flatMap(line => {
    try {
      const quantity = Number(line.quantity);
      if (!line.description.trim() || !Number.isInteger(quantity) || quantity <= 0 || !line.unitPrice) return [];
      return [
        {
          description: line.description.trim().slice(0, 48),
          quantity,
          unitPrice: parseUnits(line.unitPrice, ctx.decimals).toString(),
        },
      ];
    } catch {
      return [];
    }
  });
  const complete = items.length === lines.length && items.length > 0;
  const total = complete ? receiptTotal(items) : 0n;

  const update = (index: number, patch: Partial<Line>) =>
    setLines(current => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const redeem = async () => {
    if (!ctx.me || !ctx.earmark) return;
    setBusy(true);
    try {
      const receipt: Receipt = {
        kind: "earmark.receipt",
        version: 1,
        chainId,
        earmark: getAddress(ctx.earmark.address),
        programId: ctx.id.toString(),
        merchant: ctx.me,
        items,
        total: total.toString(),
        issuedAt: new Date().toISOString(),
      };
      const receiptHash = documentHash(receipt);
      const signature = await signMessageAsync({ message: { raw: receiptHash } });

      if (anchoring?.anchoring) {
        const res = await fetch("/api/hcs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "receipt", body: receipt, signature }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Could not anchor the receipt");
      }

      await write({
        ...ctx.earmark,
        functionName: "redeem",
        args: [ctx.id, total, receiptHash],
        gas: GAS.redeem,
      });
      setLines([{ ...EMPTY_LINE }]);
    } catch (e) {
      notification.error(e instanceof Error ? e.message.split("\n")[0] : "Redeem failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold m-0">Proof of spend → get paid</h3>
      <p className="text-xs opacity-70 m-0">
        You sign the receipt with your wallet, it is anchored on HCS, and its hash is recorded with the redemption so
        anyone can tie this payout to what was sold.
      </p>
      {lines.map((line, i) => (
        <div key={i} className="grid grid-cols-[1fr_70px_110px] gap-2">
          <input
            className="input input-sm"
            placeholder="Item"
            maxLength={48}
            value={line.description}
            onChange={e => update(i, { description: e.target.value })}
          />
          <input
            className="input input-sm"
            inputMode="numeric"
            value={line.quantity}
            onChange={e => update(i, { quantity: e.target.value })}
          />
          <input
            className="input input-sm"
            inputMode="decimal"
            placeholder="Unit price"
            value={line.unitPrice}
            onChange={e => update(i, { unitPrice: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button
          className="btn btn-xs btn-ghost"
          disabled={lines.length >= MAX_LINES}
          onClick={() => setLines(current => [...current, { ...EMPTY_LINE }])}
        >
          + Add line
        </button>
        <span className="text-sm">
          Total <Amount value={total} decimals={ctx.decimals} symbol={ctx.symbol} className="font-semibold" />
        </span>
      </div>
      <button
        className="btn btn-sm btn-primary"
        disabled={!complete || total === 0n || total > balance || busy || isPending}
        onClick={redeem}
      >
        {busy && <span className="loading loading-spinner loading-xs" />}
        Sign receipt &amp; get paid
      </button>
      {total > balance && <p className="text-xs text-warning m-0">Total exceeds the vouchers you hold.</p>}
    </div>
  );
}
