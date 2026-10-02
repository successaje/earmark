import { type Address, getAddress } from "viem";
import { hedera, hederaTestnet } from "viem/chains";

type HederaNetwork = {
  name: "testnet" | "mainnet";
  mirrorNode: string;
  hashscan: string;
  /** Public topic this deployment anchors charters and receipts to (created by `yarn earmark:setup`). */
  defaultTopicId?: string;
};

const NETWORKS: Record<number, HederaNetwork> = {
  [hederaTestnet.id]: {
    name: "testnet",
    mirrorNode: process.env.NEXT_PUBLIC_HEDERA_TESTNET_MIRROR_URL || "https://testnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/testnet",
    defaultTopicId: "0.0.10828988",
  },
  [hedera.id]: {
    name: "mainnet",
    mirrorNode: process.env.NEXT_PUBLIC_HEDERA_MAINNET_MIRROR_URL || "https://mainnet.mirrornode.hedera.com",
    hashscan: "https://hashscan.io/mainnet",
  },
};

export function hederaNetwork(chainId: number): HederaNetwork {
  return NETWORKS[chainId] ?? NETWORKS[hederaTestnet.id];
}

export function topicIdFor(chainId: number): string | undefined {
  return process.env.NEXT_PUBLIC_EARMARK_TOPIC_ID || hederaNetwork(chainId).defaultTopicId;
}

/**
 * Hedera entities (tokens, schedules, contracts created by system contracts) are addressed in the EVM by their
 * "long-zero" address: the entity number left-padded to 20 bytes. Converts it back to `0.0.num`.
 */
export function entityIdFromAddress(address: Address): string {
  return `0.0.${BigInt(address)}`;
}

export function addressFromEntityId(entityId: string): Address {
  const num = BigInt(entityId.split(".").pop() ?? "0");
  return getAddress(`0x${num.toString(16).padStart(40, "0")}`);
}

export function hashscanUrl(
  chainId: number,
  kind: "token" | "schedule" | "topic" | "account" | "contract",
  id: string,
) {
  return `${hederaNetwork(chainId).hashscan}/${kind}/${id}`;
}

export function hashscanTxUrl(chainId: number, hash: string) {
  return `${hederaNetwork(chainId).hashscan}/tx/${hash}`;
}
