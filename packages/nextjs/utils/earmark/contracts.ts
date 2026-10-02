import { type Chain, createPublicClient, http } from "viem";
import { hedera, hederaTestnet } from "viem/chains";
import deployedContracts from "~~/contracts/deployedContracts";
import scaffoldConfig from "~~/scaffold.config";

type Deployments = typeof deployedContracts;
type DeployedChainId = keyof Deployments;

export type EarmarkStatus = "None" | "Active" | "Settling" | "Closed";
export const PROGRAM_STATUS: readonly EarmarkStatus[] = ["None", "Active", "Settling", "Closed"];

const CHAINS: Record<number, Chain> = { [hederaTestnet.id]: hederaTestnet, [hedera.id]: hedera };

export function earmarkDeployment(chainId: number) {
  const contracts = (deployedContracts as Partial<Deployments>)[chainId as DeployedChainId];
  return contracts ? { earmark: contracts.Earmark, demoDollar: contracts.DemoDollar } : undefined;
}

/** A read-only client for server routes and scripts, using the same RPC endpoints as the frontend. */
export function hederaPublicClient(chainId: number) {
  const chain = CHAINS[chainId] ?? hederaTestnet;
  const rpcOverrides: Record<number, string | undefined> = scaffoldConfig.rpcOverrides;
  return createPublicClient({ chain, transport: http(rpcOverrides[chain.id]) });
}
