import {
  chain,
  deployment,
  heading,
  operatorAccount,
  operatorSdkClient,
  publicClient,
  requireOperator,
  send,
} from "./lib";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEther, zeroAddress } from "viem";
import { createTopic } from "~~/services/earmark/hcs";
import { entityIdFromAddress, hashscanUrl } from "~~/utils/earmark/network";

/**
 * One-time setup after `yarn foundry:deploy`: creates the DemoDollar HTS token and the HCS topic Earmark anchors to.
 * Safe to re-run; finished steps are skipped.
 */

const ENV_FILE = join(process.cwd(), ".env.local");
const DEMO_DOLLAR_CREATE_VALUE = parseEther("25"); // HBAR; HTS keeps the creation fee and DemoDollar refunds the rest

async function main() {
  const config = requireOperator();
  const account = operatorAccount(config);
  const { demoDollar } = deployment();

  heading(`Earmark setup on Hedera ${chain.name} as ${config.operatorId}`);

  let token = await publicClient.readContract({ ...demoDollar, functionName: "token" });
  if (token === zeroAddress) {
    await send({
      label: "Create the DemoDollar (dUSD) HTS token",
      account,
      ...demoDollar,
      functionName: "initialize",
      value: DEMO_DOLLAR_CREATE_VALUE,
      gas: 1_000_000n,
    });
    token = await publicClient.readContract({ ...demoDollar, functionName: "token" });
  }
  console.log(
    `  ✓ dUSD token ${entityIdFromAddress(token)}  ${hashscanUrl(chain.id, "token", entityIdFromAddress(token))}`,
  );

  let topicId = process.env.NEXT_PUBLIC_EARMARK_TOPIC_ID;
  if (!topicId) {
    const client = operatorSdkClient(config);
    topicId = await createTopic(client, "Earmark: program charters and merchant receipts");
    client.close();
    upsertEnv("NEXT_PUBLIC_EARMARK_TOPIC_ID", topicId);
    console.log(`  ✓ Created HCS topic and saved it to .env.local`);
  }
  console.log(`  ✓ HCS topic ${topicId}  ${hashscanUrl(chain.id, "topic", topicId)}`);

  heading("Done. Start the app with `yarn start` and connect a wallet on Hedera testnet.");
}

function upsertEnv(key: string, value: string) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
  const rest = lines.filter(line => !line.startsWith(`${key}=`) && line !== "");
  writeFileSync(ENV_FILE, [...rest, `${key}=${value}`, ""].join("\n"));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
