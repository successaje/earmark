// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaTokenService } from "../../contracts/hedera/IHederaTokenService.sol";

/// @notice ERC-20 facade for a MockHTS token, mirroring how real HTS tokens expose ERC-20 at their address.
contract MockHtsToken {
    MockHTS internal immutable HTS;
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    constructor(MockHTS hts, string memory name_, string memory symbol_, uint8 decimals_) {
        HTS = hts;
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function totalSupply() external view returns (uint256) {
        return HTS.totalSupplyOf(address(this));
    }

    function balanceOf(address account) external view returns (uint256) {
        return HTS.balanceOf(address(this), account);
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return HTS.allowanceOf(address(this), owner, spender);
    }

    /// @dev Real HTS facades revert when the network rejects the transfer; the mock does the same.
    function transfer(address to, uint256 amount) external returns (bool) {
        int64 rc = HTS.facadeTransfer(address(this), msg.sender, to, amount);
        if (rc != 22) revert MockHTS.HtsRejected(rc);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        HTS.facadeApprove(address(this), msg.sender, spender, amount);
        return true;
    }

    /// @dev HIP-719 association called by the account itself.
    function associate() external returns (int64) {
        return HTS.facadeAssociate(address(this), msg.sender);
    }
}

contract Refund {
    constructor(address payable to) payable {
        selfdestruct(to);
    }
}

/**
 * @notice In-memory emulation of the HTS behaviour Earmark depends on: association, KYC enforcement on both sides of
 *         a transfer, key-gated KYC/wipe/pause, pause blocking every operation, allowances for transferFrom, and the
 *         creation fee being taken from msg.value with the excess refunded to the caller.
 * @dev Etched at 0x167 in tests. Response codes match the real network.
 */
contract MockHTS {
    int64 internal constant SUCCESS = 22;
    int64 internal constant INSUFFICIENT_TOKEN_BALANCE = 178;
    int64 internal constant TOKEN_NOT_ASSOCIATED_TO_ACCOUNT = 184;
    int64 internal constant ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN = 176;
    int64 internal constant TOKEN_HAS_NO_KYC_KEY = 171;
    int64 internal constant INVALID_KYC_KEY = 199;
    int64 internal constant INVALID_WIPE_KEY = 200;
    int64 internal constant INVALID_PAUSE_KEY = 314;
    int64 internal constant TOKEN_IS_PAUSED = 315;
    int64 internal constant CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT = 192;
    int64 internal constant TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;
    int64 internal constant SPENDER_DOES_NOT_HAVE_ALLOWANCE = 292;
    int64 internal constant INVALID_SIGNATURE = 7;

    uint256 public constant CREATE_FEE = 10e8; // 10 HBAR in tinybars

    struct Token {
        bool exists;
        address treasury;
        address kycKey;
        address wipeKey;
        address pauseKey;
        bool paused;
        uint256 totalSupply;
    }

    error HtsRejected(int64 responseCode);

    mapping(address => Token) public tokens;
    mapping(address => mapping(address => uint256)) internal _balances;
    mapping(address => mapping(address => bool)) public associated;
    mapping(address => mapping(address => bool)) public kyc;
    mapping(address => mapping(address => mapping(address => uint256))) internal _allowances;

    function createFungibleToken(IHederaTokenService.HederaToken memory token, int64 supply, int32 decimals)
        external
        payable
        returns (int64, address)
    {
        require(msg.value >= CREATE_FEE, "MockHTS: insufficient creation fee");
        MockHtsToken created =
            new MockHtsToken(MockHTS(address(this)), token.name, token.symbol, uint8(uint32(decimals)));
        address addr = address(created);

        Token storage t = tokens[addr];
        t.exists = true;
        t.treasury = token.treasury;
        for (uint256 i; i < token.tokenKeys.length; ++i) {
            uint256 keyType = token.tokenKeys[i].keyType;
            address holder = token.tokenKeys[i].key.contractId;
            if (keyType & 2 != 0) t.kycKey = holder;
            if (keyType & 8 != 0) t.wipeKey = holder;
            if (keyType & 64 != 0) t.pauseKey = holder;
        }
        t.totalSupply = uint256(uint64(supply));
        _balances[addr][token.treasury] = t.totalSupply;
        associated[addr][token.treasury] = true;
        kyc[addr][token.treasury] = true;

        // The network credits unused fee back to the caller without invoking it, like a selfdestruct does.
        if (msg.value > CREATE_FEE) new Refund{ value: msg.value - CREATE_FEE }(payable(msg.sender));
        return (SUCCESS, addr);
    }

    function associateToken(address account, address token) external returns (int64) {
        if (msg.sender != account) return INVALID_SIGNATURE;
        return _associate(token, account);
    }

    function transferToken(address token, address sender, address recipient, int64 amount) external returns (int64) {
        if (msg.sender != sender) return INVALID_SIGNATURE;
        return _transfer(token, sender, recipient, uint256(uint64(amount)));
    }

    function transferFrom(address token, address from, address to, uint256 amount) external returns (int64) {
        if (_allowances[token][from][msg.sender] < amount) return SPENDER_DOES_NOT_HAVE_ALLOWANCE;
        int64 rc = _transfer(token, from, to, amount);
        if (rc == SUCCESS) _allowances[token][from][msg.sender] -= amount;
        return rc;
    }

    function grantTokenKyc(address token, address account) external returns (int64) {
        return _setKyc(token, account, true);
    }

    function revokeTokenKyc(address token, address account) external returns (int64) {
        return _setKyc(token, account, false);
    }

    function wipeTokenAccount(address token, address account, int64 amount) external returns (int64) {
        Token storage t = tokens[token];
        if (t.wipeKey != msg.sender) return INVALID_WIPE_KEY;
        if (t.paused) return TOKEN_IS_PAUSED;
        if (account == t.treasury) return CANNOT_WIPE_TOKEN_TREASURY_ACCOUNT;
        if (!associated[token][account]) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        uint256 value = uint256(uint64(amount));
        if (_balances[token][account] < value) return INSUFFICIENT_TOKEN_BALANCE;
        _balances[token][account] -= value;
        t.totalSupply -= value;
        return SUCCESS;
    }

    function pauseToken(address token) external returns (int64) {
        Token storage t = tokens[token];
        if (t.pauseKey != msg.sender) return INVALID_PAUSE_KEY;
        t.paused = true;
        return SUCCESS;
    }

    // --- facade entry points (only callable by the token's own facade contract) ---

    function facadeTransfer(address token, address from, address to, uint256 amount) external returns (int64) {
        require(msg.sender == token, "MockHTS: facade only");
        return _transfer(token, from, to, amount);
    }

    function facadeApprove(address token, address owner, address spender, uint256 amount) external {
        require(msg.sender == token, "MockHTS: facade only");
        _allowances[token][owner][spender] = amount;
    }

    function facadeAssociate(address token, address account) external returns (int64) {
        require(msg.sender == token, "MockHTS: facade only");
        return _associate(token, account);
    }

    // --- views ---

    function balanceOf(address token, address account) external view returns (uint256) {
        return _balances[token][account];
    }

    function totalSupplyOf(address token) external view returns (uint256) {
        return tokens[token].totalSupply;
    }

    function allowanceOf(address token, address owner, address spender) external view returns (uint256) {
        return _allowances[token][owner][spender];
    }

    // --- internals ---

    function _associate(address token, address account) internal returns (int64) {
        if (associated[token][account]) return TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT;
        associated[token][account] = true;
        return SUCCESS;
    }

    function _setKyc(address token, address account, bool granted) internal returns (int64) {
        Token storage t = tokens[token];
        if (t.kycKey == address(0)) return TOKEN_HAS_NO_KYC_KEY;
        if (t.kycKey != msg.sender) return INVALID_KYC_KEY;
        if (t.paused) return TOKEN_IS_PAUSED;
        if (!associated[token][account]) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        kyc[token][account] = granted;
        return SUCCESS;
    }

    function _transfer(address token, address from, address to, uint256 amount) internal returns (int64) {
        Token storage t = tokens[token];
        if (t.paused) return TOKEN_IS_PAUSED;
        if (!associated[token][from] || !associated[token][to]) return TOKEN_NOT_ASSOCIATED_TO_ACCOUNT;
        if (t.kycKey != address(0) && (!kyc[token][from] || !kyc[token][to])) {
            return ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN;
        }
        if (_balances[token][from] < amount) return INSUFFICIENT_TOKEN_BALANCE;
        _balances[token][from] -= amount;
        _balances[token][to] += amount;
        return SUCCESS;
    }
}
