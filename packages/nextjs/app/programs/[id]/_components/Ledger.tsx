"use client";

import type { ProgramContext } from "./useProgramContext";
import { useQuery } from "@tanstack/react-query";
import { type Address, type Hex, hexToString, isAddressEqual, verifyMessage } from "viem";
import { useReadContracts } from "wagmi";
import { Amount, Card, Check, ExternalLink, formatAmount } from "~~/components/earmark/primitives";
import { HederaAddress } from "~~/components/scaffold-hbar";
import { useChainId, useEnvelopes, useHederaWrite, useProgramEvents } from "~~/hooks/earmark";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { GAS, htsTokenAbi } from "~~/utils/earmark/abis";
import { type Receipt, documentHash } from "~~/utils/earmark/messages";
import { hashscanTxUrl, hashscanUrl, topicIdFor } from "~~/utils/earmark/network";

export function Merchants({ ctx }: { ctx: ProgramContext }) {
  const { targetNetwork } = useTargetNetwork();
  const { write, isPending } = useHederaWrite();
  const program = ctx.program!;
  const canRemove = ctx.role.isFunder && ctx.status === "Active";

  const { data } = useReadContracts({
    contracts: ctx.merchants.flatMap(m => [
      { ...ctx.earmark!, functionName: "merchants", args: [ctx.id, m] },
      { address: program.voucher, abi: htsTokenAbi, functionName: "balanceOf", args: [m] },
    ]),
    query: { enabled: Boolean(ctx.earmark) && ctx.merchants.length > 0, refetchInterval: 5_000 },
  });

  return (
    <Card title={`Merchants (${ctx.merchants.length})`}>
      {ctx.merchants.length === 0 ? (
        <p className="text-sm opacity-60 m-0">
          {ctx.status === "Closed" ? "All merchants were settled and removed." : "No merchants approved yet."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-base-300 m-0 p-0 list-none">
          {ctx.merchants.map((m, i) => {
            const category = (data?.[i * 2]?.result as readonly [boolean, Hex] | undefined)?.[1];
            const balance = data?.[i * 2 + 1]?.result as bigint | undefined;
            return (
              <li key={m} className="flex items-center justify-between gap-3 py-2 flex-wrap">
                <div className="flex items-center gap-3">
                  {category && (
                    <span className="badge badge-sm badge-outline">{hexToString(category, { size: 32 })}</span>
                  )}
                  <HederaAddress address={m} chain={targetNetwork} />
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className="opacity-70">
                    holds <Amount value={balance} decimals={ctx.decimals} symbol={ctx.symbol} />
                  </span>
                  {canRemove && (
                    <button
                      className="btn btn-xs btn-ghost"
                      disabled={isPending}
                      onClick={() =>
                        write({
                          ...ctx.earmark!,
                          functionName: "removeMerchant",
                          args: [ctx.id, m],
                          gas: GAS.removeMerchant,
                        })
                      }
                    >
                      Pay out &amp; remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/**
 * Receipts anchored on HCS for this program. Each is checked twice in the browser: its signature must recover
 * the merchant it names, and its hash must appear in a Redeemed event of the contract.
 */
export function Receipts({ ctx }: { ctx: ProgramContext }) {
  const chainId = useChainId();
  const { data: envelopes } = useEnvelopes();
  const { data: events } = useProgramEvents(ctx.id);
  const earmark = ctx.earmark?.address;

  const receipts = (envelopes ?? []).filter(
    e =>
      e.envelope.type === "receipt" &&
      e.envelope.body.programId === ctx.id.toString() &&
      earmark &&
      isAddressEqual((e.envelope.body as Receipt).earmark, earmark),
  );

  const redemptions = (events ?? []).filter(e => e.eventName === "Redeemed");
  // receiptHash is caller-supplied, so a redemption only counts if the same merchant redeemed the receipt's total.
  const redemptionFor = (receipt: Receipt) => {
    const hash = documentHash(receipt).toLowerCase();
    return redemptions.find(
      e =>
        String(e.args.receiptHash).toLowerCase() === hash &&
        isAddressEqual(e.args.merchant as Address, receipt.merchant) &&
        (e.args.amount as bigint) === BigInt(receipt.total),
    )?.transactionHash;
  };

  const { data: signatures } = useQuery({
    queryKey: ["earmark", "receipt-sigs", receipts.map(r => r.sequenceNumber).join(",")],
    queryFn: () =>
      Promise.all(
        receipts.map(r =>
          verifyMessage({
            address: (r.envelope.body as Receipt).merchant,
            message: { raw: documentHash(r.envelope.body) },
            signature: r.envelope.signature as Hex,
          }),
        ),
      ),
    enabled: receipts.length > 0,
  });

  return (
    <Card
      title="Itemised receipts"
      actions={
        <span className="text-xs opacity-70">
          <ExternalLink href={hashscanUrl(chainId, "topic", topicIdFor(chainId) ?? "")}>HCS topic</ExternalLink>
        </span>
      }
    >
      {receipts.length === 0 ? (
        <p className="text-sm opacity-60 m-0">No receipts anchored yet.</p>
      ) : (
        <ul className="flex flex-col gap-3 m-0 p-0 list-none">
          {receipts.map((r, i) => {
            const body = r.envelope.body as Receipt;
            const redemptionTx = redemptionFor(body);
            return (
              <li key={r.sequenceNumber} className="bg-base-200 rounded-xl p-4 flex flex-col gap-2">
                <div className="flex justify-between gap-2 flex-wrap text-sm">
                  <span className="font-mono opacity-70">
                    #{r.sequenceNumber} · {body.merchant.slice(0, 8)}…{body.merchant.slice(-6)}
                  </span>
                  <span className="opacity-60">{new Date(body.issuedAt).toLocaleString()}</span>
                </div>
                <table className="table table-xs">
                  <tbody>
                    {body.items.map((item, j) => (
                      <tr key={j}>
                        <td>{item.description}</td>
                        <td className="text-right">× {item.quantity}</td>
                        <td className="text-right tabular-nums">
                          {formatAmount(BigInt(item.unitPrice) * BigInt(item.quantity), ctx.decimals)}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td colSpan={2}>Total</td>
                      <td className="text-right">
                        <Amount value={BigInt(body.total)} decimals={ctx.decimals} symbol={ctx.backingSymbol} />
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="flex gap-4 flex-wrap items-center">
                  {signatures && <Check ok={signatures[i]} label="Signed by merchant" />}
                  <Check ok={Boolean(redemptionTx)} label={redemptionTx ? "Redeemed on-chain" : "Not redeemed yet"} />
                  {redemptionTx && (
                    <span className="text-xs">
                      <ExternalLink href={hashscanTxUrl(chainId, redemptionTx)}>redemption tx</ExternalLink>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

const EVENT_LABELS: Record<string, (args: Record<string, unknown>, ctx: ProgramContext) => string> = {
  ProgramCreated: (a, c) =>
    `Escrowed ${formatAmount(a.amount as bigint, c.decimals)} ${c.backingSymbol} and created the voucher`,
  SettlementScheduled: a => `Scheduled settlement for ${new Date(Number(a.executeAt) * 1000).toLocaleString()}`,
  SettlementScheduleFailed: () => "Could not schedule the next settlement batch — anyone can call settle()",
  SettlementCapacityExhausted: () => "No schedule capacity for the next batch — anyone can call settle()",
  MerchantSettlementSkipped: a => `Could not settle ${short(a.merchant)}; its vouchers were voided`,
  ExpiryExtended: a => `Extended expiry to ${new Date(Number(a.newExpiry) * 1000).toLocaleString()}`,
  Allocated: (a, c) => `Allocated ${formatAmount(a.amount as bigint, c.decimals)} to ${short(a.beneficiary)}`,
  Deallocated: (a, c) =>
    `Withdrew ${formatAmount(a.amount as bigint, c.decimals)} allocation from ${short(a.beneficiary)}`,
  Claimed: (a, c) => `${short(a.beneficiary)} claimed ${formatAmount(a.amount as bigint, c.decimals)}`,
  MerchantApproved: a => `Approved merchant ${short(a.merchant)}`,
  MerchantRemoved: a => `Removed merchant ${short(a.merchant)}`,
  Redeemed: (a, c) =>
    `${short(a.merchant)} redeemed ${formatAmount(a.amount as bigint, c.decimals)}${
      /^0x0+$/.test(String(a.receiptHash)) ? " at settlement" : " with a receipt"
    }`,
  PayoutDeferred: (a, c) =>
    `Payout of ${formatAmount(a.amount as bigint, c.decimals)} to ${short(a.account)} parked as owed`,
  OwedWithdrawn: (a, c) => `${short(a.account)} withdrew ${formatAmount(a.amount as bigint, c.decimals)} owed`,
  SettlementProgress: a => `Settled ${a.processed}/${a.total} merchants`,
  ProgramClosed: (a, c) =>
    `Closed: refunded ${formatAmount(a.refunded as bigint, c.decimals)} ${c.backingSymbol} to the funder`,
};

export function Activity({ ctx }: { ctx: ProgramContext }) {
  const chainId = useChainId();
  const { data: events, isLoading } = useProgramEvents(ctx.id);

  return (
    <Card title="On-chain activity">
      {isLoading ? (
        <div className="skeleton h-24 w-full" />
      ) : !events?.length ? (
        <p className="text-sm opacity-60 m-0">No events indexed yet.</p>
      ) : (
        <ol className="flex flex-col gap-2 m-0 p-0 list-none text-sm">
          {events.map((e, i) => (
            <li key={`${e.transactionHash}-${i}`} className="flex justify-between gap-3 flex-wrap">
              <span>{EVENT_LABELS[e.eventName]?.(e.args, ctx) ?? e.eventName}</span>
              <span className="opacity-60 text-xs">
                <ExternalLink href={hashscanTxUrl(chainId, e.transactionHash)}>
                  {new Date(Number(e.timestamp) * 1000).toLocaleTimeString()}
                </ExternalLink>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function short(value: unknown) {
  const address = value as Address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
