"use client";

import type { ProgramContext } from "./useProgramContext";
import { useQuery } from "@tanstack/react-query";
import { type Address, type Hex, verifyMessage, zeroAddress } from "viem";
import { Amount, Card, Check, Countdown, ExternalLink, Stat, StatusBadge } from "~~/components/earmark/primitives";
import { HederaAddress } from "~~/components/scaffold-hbar";
import { useChainId, useHederaWrite, useProgramEvents, useSchedule } from "~~/hooks/earmark";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";
import { GAS } from "~~/utils/earmark/abis";
import { type Charter, documentHash } from "~~/utils/earmark/messages";
import { entityIdFromAddress, hashscanUrl, topicIdFor } from "~~/utils/earmark/network";

export function Overview({ ctx }: { ctx: ProgramContext }) {
  const { targetNetwork } = useTargetNetwork();
  const { program, status, name, symbol, decimals, backingSymbol, charter } = ctx;
  const chainId = useChainId();
  const charterBody = charter?.envelope.body as Charter | undefined;

  const { data: charterSigned } = useQuery({
    queryKey: ["earmark", "charter-sig", charter?.sequenceNumber],
    queryFn: () =>
      verifyMessage({
        address: charterBody!.funder,
        message: { raw: documentHash(charterBody!) },
        signature: charter!.envelope.signature as Hex,
      }),
    enabled: Boolean(charter && charterBody),
  });

  if (!program) return null;
  const outstanding = program.funded - program.redeemed - program.refunded;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-bold m-0">{name ?? "…"}</h1>
          <StatusBadge status={status} />
        </div>
        <div className="flex items-center gap-2 text-sm flex-wrap opacity-80">
          <span>Program #{ctx.id.toString()} funded by</span>
          <HederaAddress address={program.funder} chain={targetNetwork} />
        </div>
        {charterBody ? (
          <div className="bg-base-200 rounded-xl p-4 flex flex-col gap-2">
            <p className="m-0">{charterBody.purpose}</p>
            <div className="flex gap-2 flex-wrap items-center">
              {charterBody.categories.map(c => (
                <span key={c} className="badge badge-outline badge-sm">
                  {c}
                </span>
              ))}
              {charterSigned !== undefined && <Check ok={charterSigned} label="Signed by funder" />}
              <Check ok label="Hash matches contract" />
              <span className="text-xs opacity-70">
                <ExternalLink href={hashscanUrl(chainId, "topic", topicIdFor(chainId) ?? "")}>
                  HCS message #{charter?.sequenceNumber}
                </ExternalLink>
              </span>
            </div>
          </div>
        ) : (
          <p className="text-sm opacity-60 m-0">No charter found on this deployment&apos;s HCS topic.</p>
        )}
      </header>

      <Card>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-6">
          <Stat label="Escrowed">
            <Amount value={program.funded} decimals={decimals} symbol={backingSymbol} />
          </Stat>
          <Stat label="Allocated">
            <Amount value={program.allocated} decimals={decimals} />
          </Stat>
          <Stat label="Claimed">
            <Amount value={program.claimed} decimals={decimals} />
          </Stat>
          <Stat label="Redeemed" hint="Paid to merchants">
            <Amount value={program.redeemed} decimals={decimals} />
          </Stat>
          <Stat label={status === "Closed" ? "Refunded" : "In circulation"} hint={`${symbol ?? ""} backed 1:1`}>
            <Amount value={status === "Closed" ? program.refunded : outstanding} decimals={decimals} />
          </Stat>
        </div>
        <FlowBar ctx={ctx} />
      </Card>

      <Settlement ctx={ctx} />
    </div>
  );
}

function FlowBar({ ctx }: { ctx: ProgramContext }) {
  const program = ctx.program!;
  if (program.funded === 0n) return null;
  const pct = (v: bigint) => Number((v * 10_000n) / program.funded) / 100;
  const redeemed = pct(program.redeemed);
  const refunded = pct(program.refunded);
  const claimedUnspent = Math.max(0, pct(program.claimed) - redeemed);

  return (
    <div className="mt-6 flex flex-col gap-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-base-300">
        <div className="bg-primary" style={{ width: `${redeemed}%` }} title="Redeemed by merchants" />
        <div className="bg-secondary/60" style={{ width: `${claimedUnspent}%` }} title="Held by beneficiaries" />
        <div className="bg-success/70" style={{ width: `${refunded}%` }} title="Refunded to funder" />
      </div>
      <div className="flex gap-4 text-xs opacity-70 flex-wrap">
        <Legend className="bg-primary" label="Redeemed by merchants" />
        <Legend className="bg-secondary/60" label="Held by beneficiaries" />
        <Legend className="bg-success/70" label="Refunded to funder" />
        <Legend className="bg-base-300" label="Escrowed, unclaimed" />
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${className}`} />
      {label}
    </span>
  );
}

function Settlement({ ctx }: { ctx: ProgramContext }) {
  const chainId = useChainId();
  const { write, isPending } = useHederaWrite();
  const program = ctx.program!;
  const { data: events } = useProgramEvents(ctx.id);
  // settle() clears program.schedule, so after closing fall back to the last schedule the contract created.
  const lastScheduled = events?.find(e => e.eventName === "SettlementScheduled")?.args.schedule as Address | undefined;
  const { data: schedule } = useSchedule(program.schedule !== zeroAddress ? program.schedule : lastScheduled);
  const expiry = Number(program.expiry);
  const expired = Date.now() / 1000 >= expiry;
  const voucherId = entityIdFromAddress(program.voucher);

  const settle = () =>
    ctx.earmark && write({ ...ctx.earmark, functionName: "settle", args: [ctx.id], gas: GAS.settle });

  return (
    <Card title="Self-settlement">
      <div className="grid gap-4 sm:grid-cols-3 text-sm">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider opacity-60">Spending window</span>
          {ctx.status === "Active" && !expired ? (
            <span className="text-xl font-semibold">
              closes in <Countdown to={expiry} />
            </span>
          ) : (
            <span className="text-xl font-semibold">closed</span>
          )}
          <span className="opacity-60">{new Date(expiry * 1000).toLocaleString()}</span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider opacity-60">Hedera schedule</span>
          {schedule ? (
            <>
              <ExternalLink href={hashscanUrl(chainId, "schedule", schedule.scheduleId)}>
                {schedule.scheduleId}
              </ExternalLink>
              <span className="opacity-70">
                {schedule.executedAt
                  ? `Executed by the network ${new Date(schedule.executedAt * 1000).toLocaleTimeString()}`
                  : schedule.deleted
                    ? "Replaced (expiry extended)"
                    : `Fires at ${new Date(schedule.executesAt * 1000).toLocaleTimeString()}`}
              </span>
            </>
          ) : (
            <span className="opacity-70">Waiting for mirror node…</span>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider opacity-60">Voucher token</span>
          <ExternalLink href={hashscanUrl(chainId, "token", voucherId)}>
            {voucherId} · {ctx.symbol}
          </ExternalLink>
          <span className="opacity-70">
            {ctx.status === "Closed" ? "Paused: leftover vouchers are void" : "KYC-gated, contract-controlled keys"}
          </span>
        </div>
      </div>

      {expired && ctx.status !== "Closed" && (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <p className="text-sm opacity-70 m-0">
            The network runs settlement on its own. If the schedule could not run, anyone can finish it:
          </p>
          <button className="btn btn-sm btn-outline" onClick={settle} disabled={isPending}>
            Settle now
          </button>
        </div>
      )}
    </Card>
  );
}
