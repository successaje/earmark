import { loadEnvConfig } from "@next/env";
import { type Abi, type Address, type Hex, createWalletClient, http, parseEventLogs } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { hedera, hederaTestnet } from "viem/chains";
import { type HcsConfig, createOperatorClient, readHcsConfig } from "~~/services/earmark/hcs";
import { earmarkDeployment, hederaPublicClient } from "~~/utils/earmark/contracts";
import { hederaNetwork } from "~~/utils/earmark/network";
import { describeResponseCode, responseCodeFromRevertData } from "~~/utils/earmark/responseCodes";

/** Shared plumbing for the CLI scripts: env loading, operator clients, and transaction helpers that print proof. */

loadEnvConfig(process.cwd());

export function requireOperator(): HcsConfig {
  const config = readHcsConfig();
  if (!config) {
    fail("Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY (an ECDSA key) in packages/nextjs/.env.local first.");
  }
  return config;
}

export const chain = process.env.HEDERA_NETWORK === "mainnet" ? hedera : hederaTestnet;
export const publicClient = hederaPublicClient(chain.id);

export function deployment() {
  const found = earmarkDeployment(chain.id);
  if (!found)
    fail(`No Earmark deployment for chain ${chain.id}. Run \`yarn foundry:deploy --network hedera_testnet\`.`);
  return found;
}

export function walletFor(account: PrivateKeyAccount) {
  return createWalletClient({ account, chain, transport: http(publicClient.transport.url) });
}

export function operatorAccount(config: HcsConfig) {
  return privateKeyToAccount(`0x${config.operatorKey.replace(/^0x/, "")}` as Hex);
}

export function operatorSdkClient(config: HcsConfig) {
  return createOperatorClient(config);
}

type Write = {
  label: string;
  account: PrivateKeyAccount;
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** HTS and HSS system-contract work is priced in gas, so estimates from a plain EVM simulation run short. */
  gas: bigint;
  expectRevert?: boolean;
};

/** Sends a transaction, waits for it, and prints a HashScan link. Returns the receipt's decoded events. */
export async function send(write: Write) {
  const hash = await walletFor(write.account).writeContract({
    address: write.address,
    abi: write.abi,
    functionName: write.functionName,
    args: write.args ?? [],
    value: write.value,
    gas: write.gas,
    chain,
    account: write.account,
  } as Parameters<ReturnType<typeof walletFor>["writeContract"]>[0]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const reverted = receipt.status === "reverted";

  if (reverted && !write.expectRevert) fail(`${write.label} reverted: ${await txUrl(hash)}`);
  const marker = reverted ? "✗ rejected" : "✓";
  console.log(`  ${marker} ${write.label}\n      ${await txUrl(hash)}`);
  if (reverted) console.log(`      reason: ${await mirrorError(hash)}`);

  return { hash, reverted, events: parseEventLogs({ abi: write.abi, logs: receipt.logs }) };
}

/** HashScan links by consensus timestamp, resolved through the mirror node (which can lag a few seconds). */
export async function txUrl(hash: Hex): Promise<string> {
  const network = hederaNetwork(chain.id);
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${network.mirrorNode}/api/v1/contracts/results/${hash}`);
    if (res.ok) {
      const { timestamp } = (await res.json()) as { timestamp: string };
      return `${network.hashscan}/transaction/${timestamp}`;
    }
    await sleep(1500);
  }
  return `${network.hashscan}/tx/${hash}`;
}

async function mirrorError(hash: Hex): Promise<string> {
  const res = await fetch(`${hederaNetwork(chain.id).mirrorNode}/api/v1/contracts/results/${hash}/actions`);
  if (!res.ok) return "unknown";
  const { actions } = (await res.json()) as { actions: { result_data_type: string; result_data: string }[] };
  const failure = actions.find(a => a.result_data_type !== "OUTPUT");
  if (!failure) return "contract reverted";
  const code = responseCodeFromRevertData(failure.result_data);
  return code === null ? Buffer.from(failure.result_data.slice(2), "hex").toString("utf8") : describeResponseCode(code);
}

export function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

export function heading(text: string) {
  console.log(`\n${text}`);
}
