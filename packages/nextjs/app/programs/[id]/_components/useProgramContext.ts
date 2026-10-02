"use client";

import { useMemo } from "react";
import { type Address, isAddressEqual, zeroAddress } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { useEnvelopes, useProgram } from "~~/hooks/earmark";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-hbar";
import { type Charter, documentHash } from "~~/utils/earmark/messages";

/** Everything the dashboard needs about one program and the connected wallet's place in it. */
export function useProgramContext(id: bigint) {
  const { address: me } = useAccount();
  const programState = useProgram(id);
  const { data: earmark } = useDeployedContractInfo({ contractName: "Earmark" });
  const { data: merchantList } = useScaffoldReadContract({
    contractName: "Earmark",
    functionName: "getMerchants",
    args: [id],
    query: { refetchInterval: 5_000 },
  });

  const account = me ?? zeroAddress;
  const { data: roleData, refetch: refetchRole } = useReadContracts({
    contracts: earmark
      ? [
          { ...earmark, functionName: "allocationOf", args: [id, account] },
          { ...earmark, functionName: "hasClaimed", args: [id, account] },
          { ...earmark, functionName: "merchants", args: [id, account] },
          { ...earmark, functionName: "owed", args: [id, account] },
        ]
      : [],
    query: { enabled: Boolean(earmark && me), refetchInterval: 5_000 },
  });

  const allocation = (roleData?.[0]?.result as bigint | undefined) ?? 0n;
  const claimed = (roleData?.[1]?.result as boolean | undefined) ?? false;
  const merchant = roleData?.[2]?.result as readonly [boolean, `0x${string}`] | undefined;
  const owed = (roleData?.[3]?.result as bigint | undefined) ?? 0n;

  const { data: envelopes } = useEnvelopes();
  const charterHash = programState.program?.charterHash;
  const charter = useMemo(() => {
    if (!envelopes || !charterHash) return undefined;
    const expected = charterHash.toLowerCase();
    return envelopes.find(
      e => e.envelope.type === "charter" && documentHash(e.envelope.body as Charter).toLowerCase() === expected,
    );
  }, [envelopes, charterHash]);

  const funder = programState.program?.funder;
  return {
    ...programState,
    id,
    me,
    earmark,
    merchants: (merchantList ?? []) as readonly Address[],
    charter,
    role: {
      isFunder: Boolean(me && funder && isAddressEqual(me, funder)),
      isMerchant: Boolean(merchant?.[0]),
      isBeneficiary: allocation > 0n,
      allocation,
      claimed,
      owed,
    },
    refetchRole,
  };
}

export type ProgramContext = ReturnType<typeof useProgramContext>;
