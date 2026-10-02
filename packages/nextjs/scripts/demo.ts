import {
  chain,
  deployment,
  fail,
  heading,
  operatorAccount,
  operatorSdkClient,
  publicClient,
  requireOperator,
  send,
  sleep,
} from "./lib";
import { AccountId, Hbar, TransferTransaction } from "@hiero-ledger/sdk";
import { type Address, formatUnits, getAddress, parseEther, stringToHex, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { submitMessage } from "~~/services/earmark/hcs";
import { GAS, htsTokenAbi } from "~~/utils/earmark/abis";
import { type Charter, type Receipt, documentHash, encodeEnvelope, receiptTotal } from "~~/utils/earmark/messages";
import { fetchSchedule } from "~~/utils/earmark/mirror";
import { entityIdFromAddress, hashscanUrl, hederaNetwork, topicIdFor } from "~~/utils/earmark/network";

/**
 * Runs one Earmark program end to end on Hedera testnet and prints a HashScan link for every step:
 * charter on HCS → escrow + voucher creation + self-scheduled settlement → enrolment → a transfer the network
 * refuses → a merchant sale with an itemised receipt on HCS → settlement executed by the network at expiry.
 *
 * The operator account acts as the funder; a beneficiary and a merchant are created fresh for each run.
 */

const DECIMALS = 6;
const units = (amount: number) => BigInt(Math.round(amount * 10 ** DECIMALS));
const show = (amount: bigint) => `${formatUnits(amount, DECIMALS)} dUSD`;

const FUND = units(100);
const ALLOCATION = units(50);
const SPEND = units(30);
const PROGRAM_SECONDS = 300;
const CREATE_PROGRAM_VALUE = parseEther("30"); // HBAR: token creation fee + settlement reserve, remainder refunded

async function main() {
  const config = requireOperator();
  const funder = operatorAccount(config);
  const { earmark, demoDollar } = deployment();
  const topicId = topicIdFor(chain.id) ?? fail("No HCS topic. Run `yarn earmark:setup` first.");
  const dusd = await publicClient.readContract({ ...demoDollar, functionName: "token" });
  if (dusd === zeroAddress) fail("DemoDollar is not initialised. Run `yarn earmark:setup` first.");
  const sdk = operatorSdkClient(config);

  heading("1 · Create a beneficiary and a merchant account");
  const beneficiary = privateKeyToAccount(generatePrivateKey());
  const merchant = privateKeyToAccount(generatePrivateKey());
  await (
    await new TransferTransaction()
      .addHbarTransfer(config.operatorId, new Hbar(-30))
      .addHbarTransfer(AccountId.fromEvmAddress(0, 0, beneficiary.address), new Hbar(15))
      .addHbarTransfer(AccountId.fromEvmAddress(0, 0, merchant.address), new Hbar(15))
      .execute(sdk)
  ).getReceipt(sdk);
  console.log(`  ✓ beneficiary ${hashscanUrl(chain.id, "account", beneficiary.address)}`);
  console.log(`  ✓ merchant    ${hashscanUrl(chain.id, "account", merchant.address)}`);

  heading("2 · Funder anchors a charter on HCS and escrows 100 dUSD");
  const funderBalance = await publicClient.readContract({
    address: dusd,
    abi: htsTokenAbi,
    functionName: "balanceOf",
    args: [funder.address],
  });
  if (funderBalance < FUND) {
    await send({
      label: "Drip 1,000 dUSD from the faucet",
      account: funder,
      ...demoDollar,
      functionName: "drip",
      gas: GAS.drip,
    });
  }

  const charter: Charter = {
    kind: "earmark.charter",
    version: 1,
    chainId: chain.id,
    earmark: getAddress(earmark.address),
    funder: funder.address,
    title: "Demo food assistance",
    purpose: "Groceries for enrolled households. Unspent funds return to the funder at expiry.",
    categories: ["GROCERIES"],
    issuedAt: new Date().toISOString(),
  };
  const charterHash = documentHash(charter);
  const charterSignature = await funder.signMessage({ message: { raw: charterHash } });
  const anchoredCharter = await submitMessage(
    sdk,
    topicId,
    encodeEnvelope({ type: "charter", body: charter, signature: charterSignature }),
  );
  console.log(`  ✓ Charter anchored as message #${anchoredCharter.sequenceNumber} on topic ${topicId}`);
  console.log(`      ${hashscanUrl(chain.id, "topic", topicId)}`);

  await send({
    label: "Approve Earmark to pull 100 dUSD",
    account: funder,
    address: dusd,
    abi: htsTokenAbi,
    functionName: "approve",
    args: [earmark.address, FUND],
    gas: GAS.approve,
  });

  const expiry = BigInt(Math.floor(Date.now() / 1000) + PROGRAM_SECONDS);
  const created = await send({
    label: "createProgram: escrow, create the voucher token, schedule its own settlement",
    account: funder,
    ...earmark,
    functionName: "createProgram",
    args: [{ backing: dusd, amount: FUND, expiry, name: "Earmark Demo Groceries", symbol: "eGROC", charterHash }],
    value: CREATE_PROGRAM_VALUE,
    gas: GAS.createProgram,
  });
  const programEvent = created.events.find(e => e.eventName === "ProgramCreated");
  const scheduleEvent = created.events.find(e => e.eventName === "SettlementScheduled");
  if (!programEvent || !scheduleEvent) fail("createProgram emitted no ProgramCreated/SettlementScheduled event");
  const { id, voucher } = programEvent.args as { id: bigint; voucher: Address };
  const { schedule, executeAt } = scheduleEvent.args as { schedule: Address; executeAt: bigint };
  console.log(`  ✓ Program #${id} voucher token  ${hashscanUrl(chain.id, "token", entityIdFromAddress(voucher))}`);
  console.log(`  ✓ Settlement schedule          ${hashscanUrl(chain.id, "schedule", entityIdFromAddress(schedule))}`);
  console.log(`      the network will call settle(${id}) at ${new Date(Number(executeAt) * 1000).toISOString()}`);

  heading("3 · Enrol the beneficiary and approve the merchant");
  await send({
    label: "Allocate 50 to the beneficiary",
    account: funder,
    ...earmark,
    functionName: "allocate",
    args: [id, [beneficiary.address], [ALLOCATION]],
    gas: GAS.allocate,
  });
  const voucherToken = { address: voucher, abi: htsTokenAbi } as const;
  await send({
    label: "Beneficiary associates with the voucher (HIP-719)",
    account: beneficiary,
    ...voucherToken,
    functionName: "associate",
    gas: GAS.associate,
  });
  await send({
    label: "Beneficiary claims: KYC granted + 50 vouchers",
    account: beneficiary,
    ...earmark,
    functionName: "claim",
    args: [id],
    gas: GAS.claim,
  });
  await send({
    label: "Merchant associates with the voucher",
    account: merchant,
    ...voucherToken,
    functionName: "associate",
    gas: GAS.associate,
  });
  await send({
    label: "Approve the merchant (KYC grant)",
    account: funder,
    ...earmark,
    functionName: "approveMerchant",
    args: [id, merchant.address, stringToHex("GROCERIES", { size: 32 })],
    gas: GAS.approveMerchant,
  });

  heading("4 · The network, not the app, enforces the purpose");
  await send({
    label: "An outsider associates with the voucher (no KYC)",
    account: funder,
    ...voucherToken,
    functionName: "associate",
    gas: GAS.associate,
  });
  await send({
    label: "Beneficiary tries to send 5 vouchers to the outsider",
    account: beneficiary,
    ...voucherToken,
    functionName: "transfer",
    args: [funder.address, units(5)],
    gas: GAS.transfer,
    expectRevert: true,
  });
  await send({
    label: "Beneficiary pays the merchant 30 vouchers",
    account: beneficiary,
    ...voucherToken,
    functionName: "transfer",
    args: [merchant.address, SPEND],
    gas: GAS.transfer,
  });

  heading("5 · Merchant anchors an itemised receipt and redeems 20");
  const items: Receipt["items"] = [
    { description: "Rice, 5 kg", quantity: 2, unitPrice: units(6).toString() },
    { description: "Black beans, 2 kg", quantity: 1, unitPrice: units(8).toString() },
  ];
  const receipt: Receipt = {
    kind: "earmark.receipt",
    version: 1,
    chainId: chain.id,
    earmark: getAddress(earmark.address),
    programId: id.toString(),
    merchant: merchant.address,
    items,
    total: receiptTotal(items).toString(),
    issuedAt: new Date().toISOString(),
  };
  const receiptHash = documentHash(receipt);
  const receiptSignature = await merchant.signMessage({ message: { raw: receiptHash } });
  const anchoredReceipt = await submitMessage(
    sdk,
    topicId,
    encodeEnvelope({ type: "receipt", body: receipt, signature: receiptSignature }),
  );
  console.log(`  ✓ Receipt anchored as message #${anchoredReceipt.sequenceNumber} (${show(BigInt(receipt.total))})`);
  await send({
    label: "Redeem 20 vouchers for dUSD, citing the receipt hash",
    account: merchant,
    ...earmark,
    functionName: "redeem",
    args: [id, BigInt(receipt.total), receiptHash],
    gas: GAS.redeem,
  });

  heading("6 · Hands off. Waiting for the network to run the scheduled settlement…");
  const deadline = Date.now() + (PROGRAM_SECONDS + 180) * 1000;
  let program = await publicClient.readContract({ ...earmark, functionName: "getProgram", args: [id] });
  while (program.status !== 3) {
    if (Date.now() > deadline) fail("Settlement did not run in time; anyone can call settle() to finish it.");
    await sleep(5000);
    process.stdout.write(".");
    program = await publicClient.readContract({ ...earmark, functionName: "getProgram", args: [id] });
  }
  console.log("");

  const executed = await fetchSchedule(chain.id, schedule);
  const merchantDusd = await publicClient.readContract({
    address: dusd,
    abi: htsTokenAbi,
    functionName: "balanceOf",
    args: [merchant.address],
  });
  const voucherInfo = await fetch(
    `${hederaNetwork(chain.id).mirrorNode}/api/v1/tokens/${entityIdFromAddress(voucher)}`,
  ).then(r => r.json());

  console.log(
    `  ✓ Schedule ${executed?.scheduleId} executed at ${executed?.executedAt ? new Date(executed.executedAt * 1000).toISOString() : "?"}`,
  );
  console.log(`  ✓ Merchant holds ${show(merchantDusd)} (20 redeemed by hand + 10 settled automatically)`);
  console.log(`  ✓ Funder refunded ${show(program.refunded)} (unallocated + unspent)`);
  console.log(`  ✓ Voucher token is ${voucherInfo.pause_status}: the beneficiary's 20 unspent vouchers are void`);
  sdk.close();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
