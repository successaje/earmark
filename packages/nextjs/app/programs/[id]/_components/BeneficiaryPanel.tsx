"use client";

import { useState } from "react";
import { AssociateStep } from "./AssociateStep";
import type { ProgramContext } from "./useProgramContext";
import { getAddress, hexToString, isAddress, parseUnits } from "viem";
import { useReadContracts } from "wagmi";
import { Amount, Card } from "~~/components/earmark/primitives";
import { useHederaWrite, useTokenRelationship } from "~~/hooks/earmark";
import { GAS, htsTokenAbi } from "~~/utils/earmark/abis";

export function BeneficiaryPanel({ ctx }: { ctx: ProgramContext }) {
  const { write, isPending } = useHederaWrite();
  const program = ctx.program!;
  const me = ctx.me!;
  const { data: relationship } = useTokenRelationship(program.voucher, me);
  const balance = relationship?.balance ?? 0n;
  const open = ctx.status === "Active" && Date.now() / 1000 < Number(program.expiry);

  return (
    <Card title="Beneficiary">
      <div className="flex flex-col gap-4">
        <div className="flex gap-8 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider opacity-60 m-0">Your allocation</p>
            <Amount
              value={ctx.role.allocation}
              decimals={ctx.decimals}
              symbol={ctx.symbol}
              className="text-xl font-semibold"
            />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider opacity-60 m-0">Voucher balance</p>
            <Amount value={balance} decimals={ctx.decimals} symbol={ctx.symbol} className="text-xl font-semibold" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider opacity-60 m-0">KYC on voucher</p>
            <p className="text-xl font-semibold m-0">{relationship?.kyc ?? "—"}</p>
          </div>
        </div>

        {open && !ctx.role.claimed && (
          <>
            <AssociateStep token={program.voucher} account={me} symbol={ctx.symbol} />
            <button
              className="btn btn-primary"
              disabled={!relationship?.associated || isPending}
              onClick={() => write({ ...ctx.earmark!, functionName: "claim", args: [ctx.id], gas: GAS.claim })}
            >
              Claim my vouchers
            </button>
          </>
        )}

        {ctx.role.claimed && ctx.status === "Active" && balance > 0n && <Spend ctx={ctx} balance={balance} />}
        {ctx.status === "Closed" && balance > 0n && (
          <p className="text-sm opacity-70 m-0">
            The program has settled. Your remaining vouchers are paused and their backing went back to the funder.
          </p>
        )}
      </div>
    </Card>
  );
}

function Spend({ ctx, balance }: { ctx: ProgramContext; balance: bigint }) {
  const { write, isPending } = useHederaWrite();
  const [to, setTo] = useState(ctx.merchants[0] ?? "");
  const [amount, setAmount] = useState("");
  const [outsider, setOutsider] = useState("");

  const { data: categories } = useReadContracts({
    contracts: ctx.merchants.map(m => ({ ...ctx.earmark!, functionName: "merchants", args: [ctx.id, m] })),
    query: { enabled: ctx.merchants.length > 0 },
  });

  let units: bigint | null = null;
  try {
    units = amount ? parseUnits(amount, ctx.decimals) : null;
  } catch {
    units = null;
  }

  const transfer = (recipient: string, value: bigint) =>
    write({
      address: ctx.program!.voucher,
      abi: htsTokenAbi,
      functionName: "transfer",
      args: [getAddress(recipient), value],
      gas: GAS.transfer,
    });

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <h3 className="font-semibold m-0">Pay a merchant</h3>
        <select className="select select-sm w-full font-mono" value={to} onChange={e => setTo(e.target.value)}>
          {ctx.merchants.map((m, i) => {
            const category = (categories?.[i]?.result as readonly [boolean, `0x${string}`] | undefined)?.[1];
            return (
              <option key={m} value={m}>
                {category ? `${hexToString(category, { size: 32 })} · ` : ""}
                {m.slice(0, 8)}…{m.slice(-6)}
              </option>
            );
          })}
        </select>
        <input
          className="input input-sm w-full"
          inputMode="decimal"
          placeholder={`Amount in ${ctx.symbol}`}
          value={amount}
          onChange={e => setAmount(e.target.value)}
        />
        <button
          className="btn btn-sm btn-primary"
          disabled={!to || !units || units > balance || isPending}
          onClick={() => units && transfer(to, units)}
        >
          Pay
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="font-semibold m-0">Try to send it elsewhere</h3>
        <p className="text-xs opacity-70 m-0">
          Send one voucher to any account outside the program. The app will not stop you — Hedera will, with
          ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN.
        </p>
        <input
          className="input input-sm w-full font-mono"
          placeholder="0xAnyAddress"
          value={outsider}
          onChange={e => setOutsider(e.target.value.trim())}
        />
        <button
          className="btn btn-sm btn-outline btn-error"
          disabled={!isAddress(outsider) || isPending}
          onClick={() => transfer(outsider, parseUnits("1", ctx.decimals))}
        >
          Send 1 {ctx.symbol}
        </button>
      </div>
    </div>
  );
}
