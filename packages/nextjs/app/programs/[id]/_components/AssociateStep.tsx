"use client";

import type { Address } from "viem";
import { useHederaWrite, useTokenRelationship } from "~~/hooks/earmark";
import { GAS, htsTokenAbi } from "~~/utils/earmark/abis";

/**
 * HTS accounts must opt in to a token before holding it. With HIP-719 the account does that by calling
 * `associate()` on the token address from its own wallet; Earmark can only grant KYC after that.
 */
export function AssociateStep({ token, account, symbol }: { token: Address; account: Address; symbol?: string }) {
  const { data: relationship, isLoading } = useTokenRelationship(token, account);
  const { write, isPending } = useHederaWrite();

  if (isLoading) return <div className="skeleton h-10 w-full" />;
  if (relationship?.associated) return null;

  return (
    <div className="alert alert-info flex flex-col sm:flex-row items-start sm:items-center gap-3">
      <p className="m-0 text-sm grow">
        Your account is not associated with {symbol ?? "the voucher"} yet. Hedera accounts opt in to each token they
        hold.
      </p>
      <button
        className="btn btn-sm btn-primary"
        disabled={isPending}
        onClick={() => write({ address: token, abi: htsTokenAbi, functionName: "associate", gas: GAS.associate })}
      >
        Associate {symbol}
      </button>
    </div>
  );
}
