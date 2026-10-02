"use client";

import Link from "next/link";
import { AssociateStep } from "./AssociateStep";
import { BeneficiaryPanel } from "./BeneficiaryPanel";
import { FunderPanel } from "./FunderPanel";
import { Activity, Merchants, Receipts } from "./Ledger";
import { MerchantPanel } from "./MerchantPanel";
import { Overview } from "./Overview";
import { type ProgramContext, useProgramContext } from "./useProgramContext";
import { Card } from "~~/components/earmark/primitives";
import { HederaAddress } from "~~/components/scaffold-hbar";
import { useTokenRelationship } from "~~/hooks/earmark";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";

export function ProgramDashboard({ id }: { id: bigint }) {
  const ctx = useProgramContext(id);

  if (ctx.isLoading) return <div className="skeleton h-96 w-full" />;
  if (ctx.isError) {
    return (
      <div className="text-center py-16 flex flex-col items-center gap-3">
        <p className="opacity-70 m-0">Could not reach the Hedera JSON-RPC relay.</p>
        <button className="btn btn-sm" onClick={() => ctx.refetch()}>
          Retry
        </button>
      </div>
    );
  }
  if (!ctx.program) {
    return (
      <div className="text-center py-16 flex flex-col items-center gap-3">
        <p className="opacity-70 m-0">Program #{id.toString()} does not exist on this network.</p>
        <Link href="/" className="btn btn-sm">
          Back to programs
        </Link>
      </div>
    );
  }

  const { role } = ctx;
  const hasRole = role.isFunder || role.isBeneficiary || role.isMerchant || role.owed > 0n;

  return (
    <div className="flex flex-col gap-6">
      <Overview ctx={ctx} />
      {ctx.me && role.isFunder && <FunderPanel ctx={ctx} />}
      {ctx.me && role.isBeneficiary && <BeneficiaryPanel ctx={ctx} />}
      {ctx.me && (role.isMerchant || role.owed > 0n) && <MerchantPanel ctx={ctx} />}
      {ctx.me && !hasRole && ctx.status === "Active" && <Join ctx={ctx} />}
      {!ctx.me && <p className="text-sm opacity-70 text-center m-0">Connect a wallet to act in this program.</p>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Receipts ctx={ctx} />
        <div className="flex flex-col gap-6">
          <Merchants ctx={ctx} />
          <Activity ctx={ctx} />
        </div>
      </div>
    </div>
  );
}

/** For a wallet with no role yet: associate with the voucher so the funder can enrol or approve it. */
function Join({ ctx }: { ctx: ProgramContext }) {
  const { targetNetwork } = useTargetNetwork();
  const { data: relationship } = useTokenRelationship(ctx.program!.voucher, ctx.me);

  return (
    <Card title="Join this program">
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0 opacity-80">
          This wallet has no role here yet. Beneficiaries and merchants first associate with the {ctx.symbol} voucher,
          then send their address to the funder, who enrols them on-chain.
        </p>
        {ctx.me && <AssociateStep token={ctx.program!.voucher} account={ctx.me} symbol={ctx.symbol} />}
        {relationship?.associated && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="opacity-70">Associated. Share this address with the funder:</span>
            <HederaAddress address={ctx.me} chain={targetNetwork} format="long" />
          </div>
        )}
      </div>
    </Card>
  );
}
