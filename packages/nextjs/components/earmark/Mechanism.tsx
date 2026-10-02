import { ArrowDownIcon } from "@heroicons/react/24/outline";

const REJECTED_TX = "https://hashscan.io/testnet/transaction/1790969589.044793104";

/** The whole primitive on one card: fund, give, spend, a transfer Hedera refuses, and the automatic return. */
export function Mechanism() {
  return (
    <div className="bg-white/10 backdrop-blur rounded-2xl p-5 text-sm text-white flex flex-col items-center gap-2 w-full max-w-sm">
      <Node title="100 USDC" note="escrowed by the contract" />
      <Arrow />
      <Node title="Food program" note="mints 100 eFOOD, schedules its own close" strong />
      <Arrow />
      <Node title="Alice · 50 eFOOD" note="activated by the funder" />
      <div className="grid grid-cols-2 gap-2 w-full mt-1">
        <div className="rounded-xl bg-success/90 text-success-content p-2 text-center">
          <p className="m-0 font-semibold">→ Grocer ✓</p>
          <p className="m-0 text-xs">approved merchant</p>
        </div>
        <a
          href={REJECTED_TX}
          target="_blank"
          rel="noreferrer"
          className="rounded-xl bg-error/90 text-error-content p-2 text-center no-underline hover:brightness-110"
        >
          <p className="m-0 font-semibold">→ Any wallet ✕</p>
          <p className="m-0 text-xs">Hedera rejects it ↗</p>
        </a>
      </div>
      <Arrow />
      <Node title="Expiry" note="the network settles: merchants paid, rest returned" />
    </div>
  );
}

function Node({ title, note, strong }: { title: string; note: string; strong?: boolean }) {
  return (
    <div className={`w-full rounded-xl p-2 text-center ${strong ? "bg-white text-hedera-indigo" : "bg-white/15"}`}>
      <p className="m-0 font-semibold">{title}</p>
      <p className={`m-0 text-xs ${strong ? "opacity-70" : "text-white/70"}`}>{note}</p>
    </div>
  );
}

function Arrow() {
  return <ArrowDownIcon className="h-4 w-4 text-white/60" />;
}
