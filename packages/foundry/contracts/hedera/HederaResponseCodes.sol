// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Response codes returned by Hedera system contracts that Earmark checks explicitly.
/// @dev Full list: https://github.com/hashgraph/hedera-protobufs/blob/main/services/response_code.proto
library HederaResponseCodes {
    int64 internal constant SUCCESS = 22;
    int64 internal constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;
}
