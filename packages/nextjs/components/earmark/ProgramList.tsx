"use client";

import Link from "next/link";
import { Amount, Countdown, StatusBadge } from "~~/components/earmark/primitives";
import { useProgram } from "~~/hooks/earmark";
import { useScaffoldReadContract } from "~~/hooks/scaffold-hbar";

const PAGE_SIZE = 12;

export function ProgramList() {
  const { data: count, isLoading } = useScaffoldReadContract({
    contractName: "Earmark",
    functionName: "programCount",
    query: { refetchInterval: 10_000 },
  });

  if (isLoading) return <div className="skeleton h-32 w-full" />;
  if (!count) {
    return (
      <div className="text-center py-12 border border-dashed border-base-300 rounded-2xl">
        <p className="opacity-70">No programs yet.</p>
        <Link href="/programs/new" className="btn btn-primary btn-sm">
          Create the first one
        </Link>
      </div>
    );
  }

  const ids = Array.from({ length: Math.min(Number(count), PAGE_SIZE) }, (_, i) => count - BigInt(i));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {ids.map(id => (
        <ProgramCard key={id.toString()} id={id} />
      ))}
    </div>
  );
}

function ProgramCard({ id }: { id: bigint }) {
  const { program, status, name, symbol, decimals, backingSymbol } = useProgram(id);
  if (!program) return <div className="skeleton h-40" />;

  const spentShare = program.funded > 0n ? Number((program.redeemed * 100n) / program.funded) : 0;

  return (
    <Link
      href={`/programs/${id}`}
      className="group bg-base-100 border border-base-300 rounded-2xl p-5 flex flex-col gap-3 hover:border-primary transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs opacity-60 m-0">
            #{id.toString()} · {symbol}
          </p>
          <h3 className="font-semibold m-0 group-hover:text-primary">{name ?? "…"}</h3>
        </div>
        <StatusBadge status={status} />
      </div>
      <Amount value={program.funded} decimals={decimals} symbol={backingSymbol} className="text-2xl font-semibold" />
      <div>
        <progress className="progress progress-primary w-full" value={spentShare} max={100} />
        <p className="text-xs opacity-60 m-0">{spentShare}% redeemed by merchants</p>
      </div>
      <p className="text-xs opacity-70 m-0">
        {status === "Active" ? (
          <>
            Settles itself in <Countdown to={Number(program.expiry)} />
          </>
        ) : status === "Closed" ? (
          "Settled by the network"
        ) : (
          "Settlement in progress"
        )}
      </p>
    </Link>
  );
}
