/**
 * Hedera response codes Earmark users actually run into, with what to do about them. HTS system-contract calls
 * revert with the bare code (a 32-byte integer) and Earmark wraps it in `HtsFailed(op, code)`.
 * Full list: https://github.com/hashgraph/hedera-protobufs/blob/main/services/response_code.proto
 */
export const RESPONSE_CODES: Record<number, { name: string; hint: string }> = {
  7: { name: "INVALID_SIGNATURE", hint: "The account's key did not authorise this operation." },
  167: { name: "TOKEN_WAS_DELETED", hint: "The token no longer exists." },
  176: {
    name: "ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN",
    hint: "The recipient is not part of this program, so the network refuses the transfer.",
  },
  178: { name: "INSUFFICIENT_TOKEN_BALANCE", hint: "Not enough tokens for this amount." },
  184: {
    name: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
    hint: "Associate the account with the token first (HIP-719 associate()).",
  },
  194: { name: "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT", hint: "Already associated; nothing to do." },
  292: { name: "SPENDER_DOES_NOT_HAVE_ALLOWANCE", hint: "Approve Earmark on the backing token first." },
  315: { name: "TOKEN_IS_PAUSED", hint: "The program has settled; its vouchers are void." },
};

export function describeResponseCode(code: number | bigint): string {
  const known = RESPONSE_CODES[Number(code)];
  return known ? `${known.name}: ${known.hint}` : `Hedera response code ${code}`;
}

/** Decodes the bare 32-byte response code HTS reverts with, if that is what `data` is. */
export function responseCodeFromRevertData(data: string): number | null {
  return /^0x[0-9a-fA-F]{64}$/.test(data) ? Number(BigInt(data)) : null;
}
