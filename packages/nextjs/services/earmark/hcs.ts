import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
} from "@hiero-ledger/sdk";

/**
 * Hedera client for the Consensus Service, used by API routes and the CLI scripts — never by browser code. It
 * reads HEDERA_OPERATOR_KEY, which has no NEXT_PUBLIC_ prefix and so is never bundled for the client. The operator
 * pays the HCS fees for messages that users' wallets signed in the browser.
 */

export type HcsConfig = { operatorId: string; operatorKey: string; network: "testnet" | "mainnet" };

export function readHcsConfig(env: NodeJS.ProcessEnv = process.env): HcsConfig | null {
  const operatorId = env.HEDERA_OPERATOR_ID?.trim();
  const operatorKey = env.HEDERA_OPERATOR_KEY?.trim();
  if (!operatorId || !operatorKey) return null;
  return { operatorId, operatorKey, network: env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet" };
}

export function createOperatorClient(config: HcsConfig): Client {
  const client = config.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(config.operatorId), parseOperatorKey(config.operatorKey));
  return client;
}

/** Accepts the hex ECDSA keys the Hedera Portal hands out, with or without a 0x prefix, and DER-encoded keys. */
export function parseOperatorKey(key: string): PrivateKey {
  const hex = key.replace(/^0x/, "");
  return hex.length === 64 ? PrivateKey.fromStringECDSA(hex) : PrivateKey.fromStringDer(hex);
}

export async function submitMessage(client: Client, topicId: string, message: string) {
  const response = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message).execute(client);
  const receipt = await response.getReceipt(client);
  const record = await response.getRecord(client);
  return {
    transactionId: response.transactionId.toString(),
    sequenceNumber: Number(receipt.topicSequenceNumber),
    consensusTimestamp: record.consensusTimestamp.toString(),
  };
}

/**
 * Creates the public topic Earmark anchors to. It has no submit key on purpose: every message carries its author's
 * wallet signature, so readers verify authorship themselves and nobody needs permission to post.
 */
export async function createTopic(client: Client, memo: string): Promise<string> {
  const response = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
  const receipt = await response.getReceipt(client);
  if (!receipt.topicId) throw new Error("Topic creation returned no topic id");
  return receipt.topicId.toString();
}
