import { NextResponse } from "next/server";
import { type Hex, isAddressEqual, verifyMessage } from "viem";
import { createOperatorClient, readHcsConfig, submitMessage } from "~~/services/earmark/hcs";
import { earmarkDeployment, hederaPublicClient } from "~~/utils/earmark/contracts";
import {
  type Envelope,
  MAX_HCS_MESSAGE_BYTES,
  documentHash,
  encodeEnvelope,
  envelopeSchema,
  envelopeSize,
  receiptTotal,
} from "~~/utils/earmark/messages";
import { topicIdFor } from "~~/utils/earmark/network";

/**
 * Anchors wallet-signed Earmark documents on HCS.
 *
 * GET  → which topic is in use and whether this server can anchor (an operator is configured).
 * POST → { type, body, signature }. The route checks the signature against the document's author, and for receipts
 *        that the author is an approved merchant of the program, before paying to submit the message.
 */

export async function GET(req: Request) {
  const chainId = Number(new URL(req.url).searchParams.get("chainId") ?? 296);
  return NextResponse.json({ topicId: topicIdFor(chainId) ?? null, anchoring: readHcsConfig() !== null });
}

export async function POST(req: Request) {
  const config = readHcsConfig();
  if (!config) {
    return NextResponse.json(
      { error: "HCS anchoring is off: set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in packages/nextjs/.env.local" },
      { status: 503 },
    );
  }

  const parsed = envelopeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid document", issues: parsed.error.issues }, { status: 400 });
  }
  const envelope = parsed.data;

  const topicId = topicIdFor(envelope.body.chainId);
  if (!topicId) return NextResponse.json({ error: "No HCS topic configured for this network" }, { status: 503 });

  if (envelopeSize(envelope) > MAX_HCS_MESSAGE_BYTES) {
    return NextResponse.json({ error: `Document exceeds ${MAX_HCS_MESSAGE_BYTES} bytes` }, { status: 413 });
  }

  const rejection = await validate(envelope);
  if (rejection) return NextResponse.json({ error: rejection }, { status: 422 });

  const client = createOperatorClient(config);
  try {
    const anchored = await submitMessage(client, topicId, encodeEnvelope(envelope));
    return NextResponse.json({ topicId, hash: documentHash(envelope.body), ...anchored });
  } catch (e) {
    console.error("[api/hcs]", e);
    return NextResponse.json({ error: "HCS submission failed" }, { status: 502 });
  } finally {
    client.close();
  }
}

async function validate(envelope: Envelope): Promise<string | null> {
  const { body } = envelope;
  const deployment = earmarkDeployment(body.chainId);
  if (!deployment || !isAddressEqual(body.earmark, deployment.earmark.address)) {
    return "Document does not reference this deployment's Earmark contract";
  }

  const author = envelope.type === "charter" ? envelope.body.funder : envelope.body.merchant;
  const signed = await verifyMessage({
    address: author,
    message: { raw: documentHash(body) },
    signature: envelope.signature as Hex,
  });
  if (!signed) return "Signature does not match the document's author";

  if (envelope.type === "receipt") {
    if (receiptTotal(envelope.body.items) !== BigInt(envelope.body.total)) return "Receipt total does not match items";

    const [approved] = await hederaPublicClient(body.chainId).readContract({
      address: deployment.earmark.address,
      abi: deployment.earmark.abi,
      functionName: "merchants",
      args: [BigInt(envelope.body.programId), envelope.body.merchant],
    });
    if (!approved) return "Signer is not an approved merchant of this program";
  }
  return null;
}
