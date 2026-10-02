import { type Address, type Hex, isAddress, keccak256, toBytes } from "viem";
import { z } from "zod";

/**
 * Off-chain documents Earmark anchors on HCS. Each one is signed by the wallet it speaks for (the funder for a
 * charter, the merchant for a receipt), so anyone reading the topic can check who wrote it without trusting the
 * server that paid to submit it. The keccak256 of the canonical JSON is also what goes on-chain
 * (`charterHash` in createProgram, `receiptHash` in redeem), tying each HCS message to a contract event.
 */

/** HCS caps a single message chunk at 1024 bytes. Staying under it keeps every message one mirror-node record. */
export const MAX_HCS_MESSAGE_BYTES = 1024;

const address = z.string().refine(isAddress, "Invalid address") as unknown as z.ZodType<Address>;
const baseUnits = z.string().regex(/^\d+$/, "Expected an integer amount in base units");

export const charterSchema = z.object({
  kind: z.literal("earmark.charter"),
  version: z.literal(1),
  chainId: z.number().int(),
  earmark: address,
  funder: address,
  title: z.string().min(1).max(60),
  purpose: z.string().min(1).max(280),
  categories: z.array(z.string().min(1).max(24)).min(1).max(6),
  issuedAt: z.string().datetime(),
});

export const receiptSchema = z.object({
  kind: z.literal("earmark.receipt"),
  version: z.literal(1),
  chainId: z.number().int(),
  earmark: address,
  programId: z.string().regex(/^\d+$/),
  merchant: address,
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(48),
        quantity: z.number().int().positive().max(10_000),
        unitPrice: baseUnits,
      }),
    )
    .min(1)
    .max(5),
  total: baseUnits,
  issuedAt: z.string().datetime(),
});

export type Charter = z.infer<typeof charterSchema>;
export type Receipt = z.infer<typeof receiptSchema>;

export const envelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("charter"), body: charterSchema, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  z.object({ type: z.literal("receipt"), body: receiptSchema, signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
]);

export type Envelope = z.infer<typeof envelopeSchema>;

/** JSON with object keys sorted at every level, so the same document always hashes the same. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function documentHash(document: Charter | Receipt): Hex {
  return keccak256(toBytes(canonicalize(document)));
}

/** A receipt's total must match its line items, so the anchored amount cannot drift from what was itemised. */
export function receiptTotal(items: Receipt["items"]): bigint {
  return items.reduce((sum, item) => sum + BigInt(item.unitPrice) * BigInt(item.quantity), 0n);
}

export function encodeEnvelope(envelope: Envelope): string {
  return canonicalize(envelope);
}

export function envelopeSize(envelope: Envelope): number {
  return new TextEncoder().encode(encodeEnvelope(envelope)).length;
}
