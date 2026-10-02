"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type Abi, type Address, type Hex, zeroAddress } from "viem";
import { useReadContracts, useWriteContract } from "wagmi";
import {
  useDeployedContractInfo,
  useScaffoldReadContract,
  useTargetNetwork,
  useTransactor,
} from "~~/hooks/scaffold-hbar";
import { htsTokenAbi } from "~~/utils/earmark/abis";
import { PROGRAM_STATUS } from "~~/utils/earmark/contracts";
import { fetchContractEvents, fetchEnvelopes, fetchSchedule, fetchTokenRelationship } from "~~/utils/earmark/mirror";
import { topicIdFor } from "~~/utils/earmark/network";

const POLL_MS = 5_000;

export function useChainId() {
  return useTargetNetwork().targetNetwork.id;
}

/** The program struct plus the names and decimals of its voucher and backing tokens. */
export function useProgram(id: bigint) {
  const program = useScaffoldReadContract({
    contractName: "Earmark",
    functionName: "getProgram",
    args: [id],
    query: { refetchInterval: POLL_MS },
  });
  const data = program.data;
  const voucher = data?.voucher ?? zeroAddress;
  const backing = data?.backing ?? zeroAddress;

  const tokens = useReadContracts({
    contracts: [
      { address: voucher, abi: htsTokenAbi, functionName: "name" },
      { address: voucher, abi: htsTokenAbi, functionName: "symbol" },
      { address: voucher, abi: htsTokenAbi, functionName: "decimals" },
      { address: backing, abi: htsTokenAbi, functionName: "symbol" },
    ],
    query: { enabled: voucher !== zeroAddress, staleTime: Infinity },
  });
  const [name, symbol, decimals, backingSymbol] = tokens.data?.map(r => r.result) ?? [];

  return {
    program: data && data.status !== 0 ? data : undefined,
    status: data ? PROGRAM_STATUS[data.status] : undefined,
    name: name as string | undefined,
    symbol: symbol as string | undefined,
    decimals: (decimals as number | undefined) ?? 6,
    backingSymbol: (backingSymbol as string | undefined) ?? "",
    isLoading: program.isLoading,
    refetch: program.refetch,
  };
}

/** HTS association, KYC status and balance for one account and token, from the mirror node. */
export function useTokenRelationship(token: Address | undefined, account: Address | undefined) {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["earmark", "relationship", chainId, token, account],
    queryFn: () => fetchTokenRelationship(chainId, account!, token!),
    enabled: Boolean(token && account && token !== zeroAddress),
    refetchInterval: POLL_MS,
  });
}

export function useSchedule(schedule: Address | undefined) {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["earmark", "schedule", chainId, schedule],
    queryFn: () => fetchSchedule(chainId, schedule!),
    enabled: Boolean(schedule && schedule !== zeroAddress),
    refetchInterval: POLL_MS,
  });
}

/** Charters and receipts on this deployment's HCS topic. */
export function useEnvelopes() {
  const chainId = useChainId();
  const topicId = topicIdFor(chainId);
  return useQuery({
    queryKey: ["earmark", "envelopes", chainId, topicId],
    queryFn: () => fetchEnvelopes(chainId, topicId!),
    enabled: Boolean(topicId),
    refetchInterval: POLL_MS * 2,
  });
}

/** Earmark events for one program, decoded from mirror-node logs. */
export function useProgramEvents(id: bigint) {
  const chainId = useChainId();
  const { data: earmark } = useDeployedContractInfo({ contractName: "Earmark" });
  return useQuery({
    queryKey: ["earmark", "events", chainId, earmark?.address, id.toString()],
    queryFn: () => fetchContractEvents(chainId, earmark!.address, earmark!.abi as Abi, id),
    enabled: Boolean(earmark),
    refetchInterval: POLL_MS * 2,
  });
}

export function useAnchoringStatus() {
  const chainId = useChainId();
  return useQuery({
    queryKey: ["earmark", "anchoring", chainId],
    queryFn: async () => {
      const res = await fetch(`/api/hcs?chainId=${chainId}`);
      return (await res.json()) as { topicId: string | null; anchoring: boolean };
    },
    staleTime: Infinity,
  });
}

type HederaWrite = {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas: bigint;
};

/**
 * Sends a contract write with an explicit gas limit (see GAS in utils/earmark/abis) through the scaffold
 * transactor, then refreshes every Earmark query so the dashboard reflects the new state.
 */
export function useHederaWrite() {
  const { writeContractAsync, isPending } = useWriteContract();
  const transactor = useTransactor();
  const queryClient = useQueryClient();

  const write = async (call: HederaWrite): Promise<Hex | undefined> => {
    const hash = await transactor(() => writeContractAsync(call as Parameters<typeof writeContractAsync>[0]), {
      blockConfirmations: 1,
    });
    await queryClient.invalidateQueries();
    return hash;
  };

  return { write, isPending };
}
