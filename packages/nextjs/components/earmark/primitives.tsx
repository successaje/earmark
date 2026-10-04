"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { ArrowTopRightOnSquareIcon, CheckBadgeIcon, XCircleIcon } from "@heroicons/react/24/outline";
import type { EarmarkStatus } from "~~/utils/earmark/contracts";

export function formatAmount(value: bigint | number | undefined, decimals: number) {
  if (value === undefined) return "—";
  const [whole, fraction = ""] = formatUnits(BigInt(value), decimals).split(".");
  const trimmed = fraction.slice(0, 2).replace(/0+$/, "");
  return `${Number(whole).toLocaleString()}${trimmed ? `.${trimmed}` : ""}`;
}

export function Amount({
  value,
  decimals,
  symbol,
  className = "",
}: {
  value: bigint | number | undefined;
  decimals: number;
  symbol?: string;
  className?: string;
}) {
  return (
    <span className={`tabular-nums ${className}`}>
      {formatAmount(value, decimals)}
      {symbol ? <span className="opacity-90 font-normal"> {symbol}</span> : null}
    </span>
  );
}

const STATUS_STYLES: Record<EarmarkStatus, string> = {
  None: "badge-ghost",
  Active: "badge-success",
  Settling: "badge-warning",
  Closed: "badge-neutral",
};

export function StatusBadge({ status }: { status: EarmarkStatus | undefined }) {
  if (!status) return null;
  return <span className={`badge badge-sm ${STATUS_STYLES[status]}`}>{status}</span>;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function formatDuration(seconds: number) {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pair = (a: number, aUnit: string, b: number, bUnit: string) =>
    b > 0 ? `${a}${aUnit} ${b}${bUnit}` : `${a}${aUnit}`;
  if (d > 0) return pair(d, "d", h, "h");
  if (h > 0) return pair(h, "h", m, "m");
  if (m > 0) return pair(m, "m", s, "s");
  return `${s}s`;
}

export function Countdown({ to }: { to: number }) {
  const now = useNow();
  const remaining = to - now;
  return <span className="tabular-nums">{remaining > 0 ? formatDuration(remaining) : "now"}</span>;
}

export function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link link-hover inline-flex items-center gap-1">
      {children}
      <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 shrink-0" />
    </a>
  );
}

export function Check({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CheckBadgeIcon : XCircleIcon;
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${ok ? "text-success" : "text-error"}`}>
      <Icon className="h-4 w-4" />
      {label}
    </span>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="bg-base-100 rounded-2xl border border-base-300 p-6">
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 mb-4">
          {title && <h2 className="text-lg font-semibold m-0">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider opacity-60">{label}</span>
      <span className="text-xl font-semibold">{children}</span>
      {hint && <span className="text-xs opacity-60">{hint}</span>}
    </div>
  );
}
