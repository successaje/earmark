"use client";

import type { ProgramContext } from "./useProgramContext";
import { useReadContracts } from "wagmi";
import { Amount, Card, ExternalLink } from "~~/components/earmark/primitives";
import { useChainId, useTokenInfo } from "~~/hooks/earmark";
import { htsTokenAbi } from "~~/utils/earmark/abis";
import { entityIdFromAddress, hashscanUrl, topicIdFor } from "~~/utils/earmark/network";

/**
 * The protocol's promises, checked live rather than asserted: backing read from the contract and the token, token
 * keys and pause state read from the mirror node.
 */
export function Guarantees({ ctx }: { ctx: ProgramContext }) {
  const program = ctx.program!;
  const { data: token } = useTokenInfo(program.voucher);
  const { data: reads } = useReadContracts({
    contracts: [
      { address: program.voucher, abi: htsTokenAbi, functionName: "totalSupply" },
      { ...ctx.earmark!, functionName: "escrowOf", args: [ctx.id] },
    ],
    query: { enabled: Boolean(ctx.earmark), refetchInterval: 5_000 },
  });
  const supply = reads?.[0]?.result as bigint | undefined;
  const escrow = reads?.[1]?.result as bigint | undefined;
  const closed = ctx.status === "Closed";
  const backed = supply !== undefined && escrow !== undefined && (closed || supply === escrow);

  const rows: { label: string; ok: boolean | undefined; detail: React.ReactNode }[] = [
    {
      label: "Fully backed",
      ok: supply === undefined ? undefined : backed,
      detail: closed ? (
        "Closed: remaining vouchers are paused and backed by nothing"
      ) : (
        <>
          <Amount value={supply} decimals={ctx.decimals} symbol={ctx.symbol} /> in circulation ={" "}
          <Amount value={escrow} decimals={ctx.decimals} symbol={ctx.backingSymbol} /> in escrow
        </>
      ),
    },
    {
      label: "Nobody can mint more",
      ok: token ? !token.keys.supply && !token.keys.admin : undefined,
      detail: "The voucher has no supply key and no admin key — not even Earmark can add vouchers",
    },
    {
      label: "The network enforces where it goes",
      ok: token?.keys.kyc,
      detail: "KYC key held by the Earmark contract; transfers to anyone it has not approved are rejected by Hedera",
    },
    {
      label: closed ? "Leftovers voided" : "Settles itself",
      ok: closed ? token?.paused : ctx.status === "Settling" || !isZero(program.schedule),
      detail: closed
        ? "Voucher paused by the settlement the network ran"
        : "A Hedera schedule will close the program — no keeper, cron job or admin",
    },
  ];

  return (
    <Card title="Guarantees">
      <ul className="flex flex-col gap-3 m-0 p-0 list-none">
        {rows.map(row => (
          <li key={row.label} className="flex gap-3 items-start">
            <span
              className={`mt-0.5 h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${
                row.ok === undefined
                  ? "bg-base-300"
                  : row.ok
                    ? "bg-success text-success-content"
                    : "bg-error text-error-content"
              }`}
            >
              {row.ok === undefined ? "…" : row.ok ? "✓" : "!"}
            </span>
            <div>
              <p className="m-0 font-medium text-sm">{row.label}</p>
              <p className="m-0 text-xs opacity-70">{row.detail}</p>
            </div>
          </li>
        ))}
      </ul>
      {token && <KeyTable keys={token.keys} />}
    </Card>
  );
}

function KeyTable({ keys }: { keys: Record<string, boolean> }) {
  const rows = [
    ["KYC", keys.kyc],
    ["Wipe", keys.wipe],
    ["Pause", keys.pause],
    ["Supply", keys.supply],
    ["Admin", keys.admin],
    ["Freeze", keys.freeze],
  ] as const;
  return (
    <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
      {rows.map(([name, present]) => (
        <div key={name} className="bg-base-200 rounded-lg px-2 py-1.5 flex flex-col">
          <span className="opacity-60">{name} key</span>
          <span className="font-semibold">{present ? "Earmark" : "None"}</span>
        </div>
      ))}
    </div>
  );
}

/** Every Hedera entity behind the program, for developers following along on HashScan. */
export function DeveloperPanel({ ctx }: { ctx: ProgramContext }) {
  const chainId = useChainId();
  const program = ctx.program!;
  const topicId = topicIdFor(chainId);
  const entities: [string, string, "contract" | "token" | "schedule" | "topic" | "account" | null][] = [
    ["Earmark contract", ctx.earmark ? entityIdFromAddress(ctx.earmark.address) : "—", "contract"],
    ["Voucher token (HTS)", entityIdFromAddress(program.voucher), "token"],
    ["Backing token (HTS)", entityIdFromAddress(program.backing), "token"],
    ["Pending schedule (HSS)", isZero(program.schedule) ? "none" : entityIdFromAddress(program.schedule), "schedule"],
    ["Evidence topic (HCS)", topicId ?? "—", "topic"],
    ["Funder", program.funder, "account"],
    ["Charter hash", program.charterHash, null],
  ];

  return (
    <details className="collapse collapse-arrow bg-base-100 border border-base-300 rounded-2xl">
      <summary className="collapse-title font-semibold">Developer view: Hedera entities behind this program</summary>
      <div className="collapse-content">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm m-0">
          {entities.map(([label, id, kind]) => (
            <div key={label} className="contents">
              <dt className="opacity-60">{label}</dt>
              <dd className="m-0 font-mono text-xs break-all">
                {kind && id !== "none" && id !== "—" ? (
                  <ExternalLink href={hashscanUrl(chainId, kind, id)}>{id}</ExternalLink>
                ) : (
                  id
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

function isZero(address: string) {
  return /^0x0+$/.test(address);
}
