"use client";

import type { ProgramContext } from "./useProgramContext";
import { useReadContracts } from "wagmi";
import { Amount, Card } from "~~/components/earmark/primitives";
import { htsTokenAbi } from "~~/utils/earmark/abis";

/**
 * Where the money is, stage by stage. "Reached merchants" and "Paid out" are different states: a beneficiary paying
 * a merchant moves vouchers, and only redemption (or settlement) moves the backing.
 */
export function MoneyFlow({ ctx }: { ctx: ProgramContext }) {
  const program = ctx.program!;
  const { data: balances } = useReadContracts({
    contracts: ctx.merchants.map(m => ({
      address: program.voucher,
      abi: htsTokenAbi,
      functionName: "balanceOf",
      args: [m],
    })),
    query: { enabled: ctx.merchants.length > 0, refetchInterval: 5_000 },
  });
  const heldByMerchants = (balances ?? []).reduce((sum, b) => sum + ((b.result as bigint | undefined) ?? 0n), 0n);
  const reachedMerchants = program.redeemed + heldByMerchants;

  const stages = [
    { label: "Funded", value: program.funded, leak: undefined },
    {
      label: "Given to recipients",
      value: program.allocated,
      leak: ["not yet given", program.funded - program.allocated],
    },
    {
      label: "Activated by recipients",
      value: program.claimed,
      leak: ["not yet activated", program.allocated - program.claimed],
    },
    {
      label: "Spent at merchants",
      value: reachedMerchants,
      leak: ["still with recipients", program.claimed - reachedMerchants],
    },
    { label: "Paid out to merchants", value: program.redeemed, leak: ["awaiting merchant payout", heldByMerchants] },
  ] as const;

  return (
    <Card title="Money flow">
      <ol className="flex flex-col gap-3 m-0 p-0 list-none">
        {stages.map(({ label, value, leak }) => (
          <li key={label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 items-center">
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-sm">
                <span className="font-medium">{label}</span>
                {leak && (leak[1] as bigint) > 0n && (
                  <span className="text-xs opacity-60">
                    <Amount value={leak[1] as bigint} decimals={ctx.decimals} /> {leak[0] as string}
                  </span>
                )}
              </div>
              <progress
                className="progress progress-primary w-full"
                value={program.funded > 0n ? Number((value * 1000n) / program.funded) : 0}
                max={1000}
              />
            </div>
            <Amount value={value} decimals={ctx.decimals} symbol={ctx.backingSymbol} className="font-semibold" />
          </li>
        ))}
      </ol>
      {ctx.status === "Closed" && (
        <p className="text-sm mt-4 mb-0">
          Closed. <Amount value={program.refunded} decimals={ctx.decimals} symbol={ctx.backingSymbol} /> went back to
          the funder automatically; recipients&apos; unspent balance was voided.
        </p>
      )}
    </Card>
  );
}
