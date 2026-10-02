import { type Abi, type Address, type Hex, decodeEventLog } from "viem";
import { type Envelope, envelopeSchema } from "~~/utils/earmark/messages";
import { entityIdFromAddress, hederaNetwork } from "~~/utils/earmark/network";

/**
 * Read-only access to the Hedera mirror node. Everything the dashboard shows about token relationships (association,
 * KYC), schedules and HCS messages comes from here: those are native Hedera state with no EVM view function.
 */

const MAX_LOG_PAGES = 10;

async function mirrorGet<T>(chainId: number, path: string): Promise<T | null> {
  const url = path.startsWith("http") ? path : `${hederaNetwork(chainId).mirrorNode}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mirror node ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export type TokenRelationship = {
  associated: boolean;
  kyc: "GRANTED" | "REVOKED" | "NOT_APPLICABLE" | null;
  balance: bigint;
};

/** Whether `account` is associated with `token`, and its KYC status — the two gates HTS checks on every transfer. */
export async function fetchTokenRelationship(
  chainId: number,
  account: Address,
  token: Address,
): Promise<TokenRelationship> {
  const data = await mirrorGet<{ tokens: { balance: number; kyc_status: TokenRelationship["kyc"] }[] }>(
    chainId,
    `/api/v1/accounts/${account}/tokens?token.id=${entityIdFromAddress(token)}`,
  );
  const relationship = data?.tokens[0];
  if (!relationship) return { associated: false, kyc: null, balance: 0n };
  return { associated: true, kyc: relationship.kyc_status, balance: BigInt(relationship.balance) };
}

export type ScheduleInfo = {
  scheduleId: string;
  executesAt: number;
  executedAt: number | null;
  deleted: boolean;
};

export async function fetchSchedule(chainId: number, schedule: Address): Promise<ScheduleInfo | null> {
  const data = await mirrorGet<{
    schedule_id: string;
    expiration_time: string;
    executed_timestamp: string | null;
    deleted: boolean;
  }>(chainId, `/api/v1/schedules/${entityIdFromAddress(schedule)}`);
  if (!data) return null;
  return {
    scheduleId: data.schedule_id,
    executesAt: Number(data.expiration_time),
    executedAt: data.executed_timestamp ? Number(data.executed_timestamp) : null,
    deleted: data.deleted,
  };
}

export type AnchoredEnvelope = {
  envelope: Envelope;
  sequenceNumber: number;
  consensusTimestamp: string;
};

/** Earmark messages on the topic, newest first. Messages that do not parse as an Earmark envelope are skipped. */
export async function fetchEnvelopes(chainId: number, topicId: string, limit = 100): Promise<AnchoredEnvelope[]> {
  const data = await mirrorGet<{
    messages: { message: string; sequence_number: number; consensus_timestamp: string }[];
  }>(chainId, `/api/v1/topics/${topicId}/messages?order=desc&limit=${limit}`);
  if (!data) return [];

  return data.messages.flatMap(m => {
    try {
      const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m.message), c => c.charCodeAt(0))));
      const parsed = envelopeSchema.safeParse(json);
      if (!parsed.success) return [];
      return [{ envelope: parsed.data, sequenceNumber: m.sequence_number, consensusTimestamp: m.consensus_timestamp }];
    } catch {
      return [];
    }
  });
}

export type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
  transactionHash: Hex;
  timestamp: string;
};

/**
 * Decoded events of a contract, newest first, optionally narrowed to one program id (the first indexed topic of
 * every Earmark event). The mirror node only filters by topic within a timestamp range, so this pages through the
 * contract's logs and filters locally.
 */
export async function fetchContractEvents(
  chainId: number,
  contract: Address,
  abi: Abi,
  programId?: bigint,
): Promise<DecodedLog[]> {
  const topic1 = programId === undefined ? undefined : `0x${programId.toString(16).padStart(64, "0")}`;
  const events: DecodedLog[] = [];
  let next: string | null = `/api/v1/contracts/${contract}/results/logs?order=desc&limit=100`;

  for (let page = 0; next && page < MAX_LOG_PAGES; page++) {
    const data: {
      logs: { topics: Hex[]; data: Hex; transaction_hash: Hex; timestamp: string }[];
      links: { next: string | null };
    } | null = await mirrorGet(chainId, next);
    if (!data) break;

    for (const log of data.logs) {
      if (topic1 && log.topics[1]?.toLowerCase() !== topic1) continue;
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] }) as unknown as {
          eventName: string;
          args: Record<string, unknown>;
        };
        events.push({
          eventName: decoded.eventName,
          args: decoded.args,
          transactionHash: log.transaction_hash,
          timestamp: log.timestamp,
        });
      } catch {
        // Not an event from this ABI.
      }
    }
    next = data.links.next ? `${hederaNetwork(chainId).mirrorNode}${data.links.next}` : null;
  }
  return events;
}
