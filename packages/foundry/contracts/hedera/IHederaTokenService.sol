// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The subset of the Hedera Token Service system contract (0x167) that Earmark uses.
/// @dev Signatures match hashgraph/hedera-smart-contracts so selectors resolve on the real network.
interface IHederaTokenService {
    struct KeyValue {
        bool inheritAccountKey;
        address contractId;
        bytes ed25519;
        bytes ECDSA_secp256k1;
        address delegatableContractId;
    }

    /// @dev keyType is a bit mask: 1 admin, 2 kyc, 4 freeze, 8 wipe, 16 supply, 32 fee schedule, 64 pause.
    struct TokenKey {
        uint256 keyType;
        KeyValue key;
    }

    struct Expiry {
        int64 second;
        address autoRenewAccount;
        int64 autoRenewPeriod;
    }

    struct HederaToken {
        string name;
        string symbol;
        address treasury;
        string memo;
        bool tokenSupplyType;
        int64 maxSupply;
        bool freezeDefault;
        TokenKey[] tokenKeys;
        Expiry expiry;
    }

    function createFungibleToken(HederaToken memory token, int64 initialTotalSupply, int32 decimals)
        external
        payable
        returns (int64 responseCode, address tokenAddress);

    function associateToken(address account, address token) external returns (int64 responseCode);

    function transferToken(address token, address sender, address recipient, int64 amount)
        external
        returns (int64 responseCode);

    function transferFrom(address token, address from, address to, uint256 amount)
        external
        returns (int64 responseCode);

    function grantTokenKyc(address token, address account) external returns (int64 responseCode);

    function revokeTokenKyc(address token, address account) external returns (int64 responseCode);

    function wipeTokenAccount(address token, address account, int64 amount) external returns (int64 responseCode);

    function pauseToken(address token) external returns (int64 responseCode);
}
