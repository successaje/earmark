// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IHederaTokenService } from "./hedera/IHederaTokenService.sol";
import { IHederaScheduleService } from "./hedera/IHederaScheduleService.sol";
import { HederaResponseCodes } from "./hedera/HederaResponseCodes.sol";
import { ISaucerSwapV1Router } from "./saucerswap/ISaucerSwapV1Router.sol";

/**
 * @title Earmark — purpose-bound money on Hedera
 * @notice A funder escrows an HTS stablecoin and gets a program-specific voucher token minted 1:1 against it.
 *         Vouchers can only move between accounts this contract has KYC-granted (enrolled beneficiaries and
 *         approved merchants), so the network itself refuses transfers anywhere else. Merchants redeem vouchers
 *         for the escrowed stablecoin. After expiry the contract's own scheduled call settles every merchant,
 *         pauses the voucher and returns whatever was not spent to the funder — no keeper, no cron.
 *
 * Hedera services composed:
 *  - HTS: voucher created by this contract, which holds its KYC, wipe and pause keys. There is no supply key, so
 *         not even this contract can mint vouchers beyond what is escrowed.
 *  - HSS (HIP-1215): settlement is scheduled at creation and re-scheduled in batches until done.
 *  - HCS: program charters and itemised merchant receipts are anchored by hash (see packages/nextjs).
 * Ecosystem: `createProgramWithHbar` funds a program from HBAR by swapping through SaucerSwap, so a funder does not
 *            need to hold the backing stablecoin first.
 */
contract Earmark {
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));
    IHederaScheduleService internal constant HSS = IHederaScheduleService(address(0x16b));

    /// @dev HSS rejects schedules further out than ledger.schedule.maxExpirationFutureSeconds (62 days).
    uint256 public constant MAX_DURATION = 60 days;
    uint256 public constant MIN_DURATION = 1 minutes;
    /// @dev Hedera's block.timestamp is the start of the ~2s record block, so it can trail the consensus time a
    ///      schedule fires at. Settlement is scheduled this long after expiry so `block.timestamp >= expiry` holds.
    uint256 public constant SETTLEMENT_DELAY = 5 seconds;
    uint256 public constant MAX_MERCHANTS = 64;
    uint256 public constant SETTLE_BATCH = 8;
    uint256 public constant SETTLE_GAS_LIMIT = 2_000_000;
    /// @dev How many consecutive seconds to probe when the target second has no schedule capacity.
    uint256 internal constant CAPACITY_PROBE = 30;

    uint256 internal constant KYC_KEY = 2;
    uint256 internal constant WIPE_KEY = 8;
    uint256 internal constant PAUSE_KEY = 64;
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000; // 90 days

    enum Status {
        None,
        Active,
        Settling,
        Closed
    }

    struct Program {
        address funder;
        address backing;
        address voucher;
        uint64 expiry;
        Status status;
        uint64 funded;
        uint64 allocated;
        uint64 claimed;
        uint64 redeemed;
        uint64 refunded;
        uint32 settleCursor;
        address schedule;
        uint256 hbarReserve;
        bytes32 charterHash;
    }

    struct Merchant {
        bool approved;
        bytes32 category;
    }

    struct CreateParams {
        address backing;
        uint64 amount;
        uint64 expiry;
        string name;
        string symbol;
        bytes32 charterHash;
    }

    /// @notice SaucerSwap V1 router and WHBAR token for `createProgramWithHbar`; zero where no DEX is configured.
    ISaucerSwapV1Router public immutable SWAP_ROUTER;
    address public immutable WHBAR;
    uint256 internal constant SWAP_DEADLINE = 5 minutes;

    uint256 public programCount;
    /// @dev Sum of open programs' HBAR reserves. Schedule execution fees are charged to the contract's balance as a
    ///      whole, so a program closing while another is mid-settlement may absorb that program's few cents of
    ///      fees; the refund is capped so it can never take more than the unreserved balance.
    uint256 public totalHbarReserve;
    /// @notice HBAR refunds a funder could not receive (e.g. a contract without a receive hook). Collected with
    ///         `withdrawHbar`.
    mapping(address account => uint256) public hbarOwed;
    uint256 public totalHbarOwed;

    mapping(uint256 id => Program) internal _programs;
    mapping(uint256 id => address[]) internal _merchantList;
    mapping(uint256 id => mapping(address merchant => Merchant)) public merchants;
    mapping(uint256 id => mapping(address beneficiary => uint64)) public allocationOf;
    mapping(uint256 id => mapping(address beneficiary => bool)) public hasClaimed;
    /// @notice Backing owed to an account whose payout the network rejected during settlement (e.g. it dissociated
    ///         from the backing token). Collected with `withdrawOwed`.
    mapping(uint256 id => mapping(address account => uint64)) public owed;
    mapping(address token => bool) public isAssociated;
    mapping(address token => bool) public isVoucher;

    event ProgramCreated(
        uint256 indexed id,
        address indexed funder,
        address voucher,
        address backing,
        uint64 amount,
        uint64 expiry,
        bytes32 charterHash
    );
    event SettlementScheduled(uint256 indexed id, address schedule, uint256 executeAt);
    event SettlementScheduleFailed(uint256 indexed id, int64 responseCode);
    event SettlementCapacityExhausted(uint256 indexed id, uint256 from, uint256 to);
    event MerchantSettlementSkipped(uint256 indexed id, address indexed merchant, int64 responseCode);
    event ExpiryExtended(uint256 indexed id, uint64 newExpiry);
    event Allocated(uint256 indexed id, address indexed beneficiary, uint64 amount);
    event Deallocated(uint256 indexed id, address indexed beneficiary, uint64 amount);
    event Claimed(uint256 indexed id, address indexed beneficiary, uint64 amount);
    event MerchantApproved(uint256 indexed id, address indexed merchant, bytes32 category);
    event MerchantRemoved(uint256 indexed id, address indexed merchant);
    event Redeemed(uint256 indexed id, address indexed merchant, uint64 amount, bytes32 receiptHash);
    event PayoutDeferred(uint256 indexed id, address indexed account, uint64 amount, int64 responseCode);
    event OwedWithdrawn(uint256 indexed id, address indexed account, uint64 amount);
    event HbarOwed(address indexed account, uint256 amount);
    event FundedBySwap(uint256 indexed id, uint256 hbarIn, uint64 received);
    event SettlementProgress(uint256 indexed id, uint256 processed, uint256 total);
    event ProgramClosed(uint256 indexed id, uint64 redeemed, uint64 refunded, uint256 hbarRefunded);

    error InvalidParams();
    error NotFunder();
    error NotActive();
    error Expired();
    error NotExpired();
    error AlreadyClosed();
    error NothingToClaim();
    error AlreadyClaimed();
    error NotMerchant();
    error MerchantExists();
    error TooManyMerchants();
    error OverAllocated();
    error NothingOwed();
    error UnsupportedBacking();
    error HbarTransferFailed();
    error SwapUnavailable();
    error InsufficientSwapOutput(uint256 received);
    error HtsFailed(bytes4 op, int64 responseCode);
    error ScheduleFailed(int64 responseCode);
    error NoScheduleCapacity();

    constructor(ISaucerSwapV1Router swapRouter, address whbar) {
        SWAP_ROUTER = swapRouter;
        WHBAR = whbar;
    }

    modifier onlyFunder(uint256 id) {
        if (_programs[id].funder != msg.sender) revert NotFunder();
        _;
    }

    // ---------------------------------------------------------------------
    // Funder
    // ---------------------------------------------------------------------

    /// @notice Escrow `amount` of an HTS token and mint a voucher token against it.
    /// @dev The caller must first `approve` this contract on the backing token. `msg.value` pays the HTS token
    ///      creation fee; whatever is left becomes the program's reserve for its scheduled settlement and is
    ///      refunded at close.
    function createProgram(CreateParams calldata params) external payable returns (uint256 id) {
        _validate(params);
        uint256 balanceBefore = address(this).balance - msg.value;

        _associateSelf(params.backing);
        _check(HTS.transferFrom(params.backing, msg.sender, address(this), params.amount), HTS.transferFrom.selector);

        id = _open(params, params.amount, msg.value, balanceBefore);
    }

    /// @notice Fund a program with HBAR: Earmark swaps `hbarIn` through SaucerSwap into the backing token and escrows
    ///         exactly what arrives. The rest of `msg.value` is the network reserve, as in `createProgram`.
    /// @param params `amount` is ignored; the escrow is whatever the swap delivers.
    /// @param hbarIn Tinybars to swap. Must be less than `msg.value`.
    /// @param minOut Smallest acceptable amount of backing (the funder's slippage limit).
    function createProgramWithHbar(CreateParams calldata params, uint256 hbarIn, uint64 minOut)
        external
        payable
        returns (uint256 id)
    {
        if (address(SWAP_ROUTER) == address(0)) revert SwapUnavailable();
        if (hbarIn == 0 || hbarIn >= msg.value || minOut == 0) revert InvalidParams();
        _validate(params);
        uint256 balanceBefore = address(this).balance - msg.value;

        _associateSelf(params.backing);
        uint64 received = _swapHbarForBacking(params.backing, hbarIn, minOut);
        emit FundedBySwap(programCount + 1, hbarIn, received);

        id = _open(params, received, msg.value - hbarIn, balanceBefore);
    }

    /// @notice Reserve vouchers for beneficiaries. They receive them by calling `claim`.
    function allocate(uint256 id, address[] calldata beneficiaries, uint64[] calldata amounts) external onlyFunder(id) {
        Program storage p = _requireOpen(id);
        if (beneficiaries.length != amounts.length) revert InvalidParams();

        uint64 total = p.allocated;
        for (uint256 i; i < beneficiaries.length; ++i) {
            address who = beneficiaries[i];
            if (who == address(0) || amounts[i] == 0 || hasClaimed[id][who] || merchants[id][who].approved) {
                revert InvalidParams();
            }
            total = total - allocationOf[id][who] + amounts[i];
            allocationOf[id][who] = amounts[i];
            emit Allocated(id, who, amounts[i]);
        }
        if (total > p.funded) revert OverAllocated();
        p.allocated = total;
    }

    /// @notice Withdraw an allocation that has not been claimed yet.
    function deallocate(uint256 id, address beneficiary) external onlyFunder(id) {
        Program storage p = _requireOpen(id);
        uint64 amount = allocationOf[id][beneficiary];
        if (amount == 0 || hasClaimed[id][beneficiary]) revert NothingToClaim();
        delete allocationOf[id][beneficiary];
        p.allocated -= amount;
        emit Deallocated(id, beneficiary, amount);
    }

    /// @notice Let `merchant` receive vouchers and redeem them. The merchant must already be associated with the
    ///         voucher token (HIP-719 `associate()` on the token address).
    function approveMerchant(uint256 id, address merchant, bytes32 category) external onlyFunder(id) {
        _requireOpen(id);
        // The contract is the voucher treasury, and HTS refuses to wipe a treasury: approving it would jam settlement.
        if (merchant == address(0) || merchant == address(this) || allocationOf[id][merchant] != 0) {
            revert InvalidParams();
        }
        if (merchants[id][merchant].approved) revert MerchantExists();
        if (_merchantList[id].length >= MAX_MERCHANTS) revert TooManyMerchants();

        _check(HTS.grantTokenKyc(_programs[id].voucher, merchant), HTS.grantTokenKyc.selector);
        merchants[id][merchant] = Merchant({ approved: true, category: category });
        _merchantList[id].push(merchant);
        emit MerchantApproved(id, merchant, category);
    }

    /// @notice Pay out whatever `merchant` holds, then revoke its KYC so it can no longer receive vouchers.
    function removeMerchant(uint256 id, address merchant) external onlyFunder(id) {
        Program storage p = _requireOpen(id);
        if (!merchants[id][merchant].approved) revert NotMerchant();

        _settleMerchant(id, p, merchant);
        _removeFromList(id, merchant);
        emit MerchantRemoved(id, merchant);
    }

    /// @notice Push the expiry later. Expiry can never be brought forward: beneficiaries' spending window only grows.
    function extendExpiry(uint256 id, uint64 newExpiry) external onlyFunder(id) {
        Program storage p = _requireOpen(id);
        if (newExpiry <= p.expiry || newExpiry > block.timestamp + MAX_DURATION) revert InvalidParams();

        address previous = p.schedule;
        p.schedule = address(0);
        if (previous != address(0)) _check(HSS.deleteSchedule(previous), HSS.deleteSchedule.selector);

        p.expiry = newExpiry;
        _scheduleSettlement(id, newExpiry + SETTLEMENT_DELAY, true);
        emit ExpiryExtended(id, newExpiry);
    }

    // ---------------------------------------------------------------------
    // Beneficiary
    // ---------------------------------------------------------------------

    /// @notice Receive your allocation. Requires prior association with the voucher token.
    function claim(uint256 id) external {
        Program storage p = _requireOpen(id);
        uint64 amount = allocationOf[id][msg.sender];
        if (amount == 0) revert NothingToClaim();
        if (hasClaimed[id][msg.sender]) revert AlreadyClaimed();

        hasClaimed[id][msg.sender] = true;
        p.claimed += amount;

        _check(HTS.grantTokenKyc(p.voucher, msg.sender), HTS.grantTokenKyc.selector);
        _check(HTS.transferToken(p.voucher, address(this), msg.sender, _i64(amount)), HTS.transferToken.selector);
        emit Claimed(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Merchant
    // ---------------------------------------------------------------------

    /// @notice Swap vouchers you hold for the escrowed backing token.
    /// @param receiptHash keccak256 of the itemised receipt the merchant anchored on HCS; zero if none.
    function redeem(uint256 id, uint64 amount, bytes32 receiptHash) external {
        Program storage p = _programs[id];
        if (p.status != Status.Active && p.status != Status.Settling) revert NotActive();
        if (!merchants[id][msg.sender].approved) revert NotMerchant();
        if (amount == 0) revert InvalidParams();

        _wipe(p, msg.sender, amount);
        _check(HTS.transferToken(p.backing, address(this), msg.sender, _i64(amount)), HTS.transferToken.selector);
        emit Redeemed(id, msg.sender, amount, receiptHash);
    }

    /// @notice Collect backing whose automatic payout the network rejected. Re-associate with the backing token
    ///         first if that was the cause.
    function withdrawOwed(uint256 id) external {
        uint64 amount = owed[id][msg.sender];
        if (amount == 0) revert NothingOwed();
        delete owed[id][msg.sender];
        _check(
            HTS.transferToken(_programs[id].backing, address(this), msg.sender, _i64(amount)),
            HTS.transferToken.selector
        );
        emit OwedWithdrawn(id, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Collect an HBAR refund that could not be sent at close.
    function withdrawHbar() external {
        uint256 amount = hbarOwed[msg.sender];
        if (amount == 0) revert NothingOwed();
        delete hbarOwed[msg.sender];
        totalHbarOwed -= amount;
        if (!_sendHbar(msg.sender, amount)) revert HbarTransferFailed();
    }

    /// @notice Settle an expired program. The network calls this itself via the schedule created in
    ///         `createProgram`; anyone may call it too, so a failed schedule can never strand funds.
    /// @dev Processes up to SETTLE_BATCH merchants per call. Each merchant is paid for its remaining vouchers and
    ///      then loses KYC, so it cannot receive vouchers after being settled. When merchants remain, the
    ///      contract schedules the next batch. Nothing an individual merchant does can make this revert: payouts
    ///      the network rejects are parked in `owed` instead.
    ///      Inside a scheduled execution msg.sender is the payer of the transaction that created the schedule,
    ///      not this contract, so access control here must not depend on it.
    function settle(uint256 id) external {
        Program storage p = _programs[id];
        if (p.status == Status.None) revert NotActive();
        if (p.status == Status.Closed) revert AlreadyClosed();
        if (block.timestamp < p.expiry) revert NotExpired();

        p.status = Status.Settling;
        p.schedule = address(0);

        address[] storage list = _merchantList[id];
        uint256 total = list.length;
        uint256 cursor = p.settleCursor;
        uint256 end = cursor + SETTLE_BATCH < total ? cursor + SETTLE_BATCH : total;

        for (; cursor < end; ++cursor) {
            _settleMerchant(id, p, list[cursor]);
        }
        p.settleCursor = uint32(cursor);
        emit SettlementProgress(id, cursor, total);

        if (cursor < total) {
            _scheduleSettlement(id, block.timestamp + SETTLEMENT_DELAY, false);
            return;
        }
        _close(id, p);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getProgram(uint256 id) external view returns (Program memory) {
        return _programs[id];
    }

    function getMerchants(uint256 id) external view returns (address[] memory) {
        return _merchantList[id];
    }

    /// @notice Backing that still stands behind circulating vouchers. Always equals the voucher's total supply
    ///         while the program is open.
    function escrowOf(uint256 id) external view returns (uint64) {
        Program storage p = _programs[id];
        return p.funded - p.redeemed - p.refunded;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _createVoucher(CreateParams calldata params, uint64 amount, uint8 decimals, uint256 id, uint256 fee)
        internal
        returns (address)
    {
        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: KYC_KEY | WIPE_KEY | PAUSE_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });

        IHederaTokenService.HederaToken memory token = IHederaTokenService.HederaToken({
            name: params.name,
            symbol: params.symbol,
            treasury: address(this),
            memo: string.concat("Earmark program #", _toString(id)),
            tokenSupplyType: true, // finite: the supply can never exceed what is escrowed
            maxSupply: _i64(amount),
            freezeDefault: false,
            tokenKeys: keys,
            expiry: IHederaTokenService.Expiry({
                second: 0, autoRenewAccount: address(this), autoRenewPeriod: AUTO_RENEW_PERIOD
            })
        });

        (int64 rc, address voucher) =
            HTS.createFungibleToken{ value: fee }(token, _i64(amount), int32(uint32(decimals)));
        _check(rc, HTS.createFungibleToken.selector);
        return voucher;
    }

    /// @dev Pays a merchant for every voucher it holds and revokes its KYC. Never reverts: a rejected wipe skips
    ///      the merchant (its vouchers die with the pause and their backing is refunded), a rejected payout is
    ///      parked in `owed`, and a failed revoke means the merchant dissociated, which already stops it receiving.
    function _settleMerchant(uint256 id, Program storage p, address merchant) internal {
        uint256 balance = IERC20Metadata(p.voucher).balanceOf(merchant);
        if (balance > 0) {
            uint64 amount = uint64(balance);
            int64 rc = HTS.wipeTokenAccount(p.voucher, merchant, _i64(amount));
            if (rc == HederaResponseCodes.SUCCESS) {
                p.redeemed += amount;
                _payOrOwe(id, p.backing, merchant, amount);
                emit Redeemed(id, merchant, amount, bytes32(0));
            } else {
                emit MerchantSettlementSkipped(id, merchant, rc);
            }
        }
        HTS.revokeTokenKyc(p.voucher, merchant);
        merchants[id][merchant].approved = false;
    }

    /// @dev Vouchers are destroyed before any backing leaves, so supply never exceeds escrow.
    function _wipe(Program storage p, address account, uint64 amount) internal {
        p.redeemed += amount;
        _check(HTS.wipeTokenAccount(p.voucher, account, _i64(amount)), HTS.wipeTokenAccount.selector);
    }

    function _payOrOwe(uint256 id, address backing, address to, uint64 amount) internal {
        int64 rc = HTS.transferToken(backing, address(this), to, _i64(amount));
        if (rc != HederaResponseCodes.SUCCESS) {
            owed[id][to] += amount;
            emit PayoutDeferred(id, to, amount, rc);
        }
    }

    function _close(uint256 id, Program storage p) internal {
        p.status = Status.Closed;
        _check(HTS.pauseToken(p.voucher), HTS.pauseToken.selector);

        uint64 refund = p.funded - p.redeemed;
        p.refunded = refund;
        if (refund > 0) _payOrOwe(id, p.backing, p.funder, refund);

        uint256 reserve = p.hbarReserve;
        p.hbarReserve = 0;
        totalHbarReserve -= reserve;
        uint256 held = totalHbarReserve + totalHbarOwed;
        uint256 available = address(this).balance > held ? address(this).balance - held : 0;
        uint256 hbarRefund = reserve < available ? reserve : available;
        if (hbarRefund > 0 && !_sendHbar(p.funder, hbarRefund)) {
            hbarOwed[p.funder] += hbarRefund;
            totalHbarOwed += hbarRefund;
            emit HbarOwed(p.funder, hbarRefund);
        }

        emit ProgramClosed(id, p.redeemed, refund, hbarRefund);
    }

    /// @param strict Revert when no schedule can be created. Continuations pass false: the batch already ran, and
    ///               anyone can call `settle` to finish the job if the network is out of capacity.
    function _scheduleSettlement(uint256 id, uint256 target, bool strict) internal {
        uint256 executeAt = target;
        uint256 limit = target + CAPACITY_PROBE;
        while (!HSS.hasScheduleCapacity(executeAt, SETTLE_GAS_LIMIT)) {
            if (++executeAt == limit) {
                if (strict) revert NoScheduleCapacity();
                emit SettlementCapacityExhausted(id, target, limit);
                return;
            }
        }

        (int64 rc, address schedule) =
            HSS.scheduleCall(address(this), executeAt, SETTLE_GAS_LIMIT, 0, abi.encodeCall(this.settle, (id)));
        if (rc != HederaResponseCodes.SUCCESS) {
            if (strict) revert ScheduleFailed(rc);
            emit SettlementScheduleFailed(id, rc);
            return;
        }
        _programs[id].schedule = schedule;
        emit SettlementScheduled(id, schedule, executeAt);
    }

    function _associateSelf(address token) internal {
        if (isAssociated[token]) return;
        int64 rc = HTS.associateToken(address(this), token);
        if (rc != HederaResponseCodes.SUCCESS && rc != HederaResponseCodes.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT) {
            revert HtsFailed(HTS.associateToken.selector, rc);
        }
        isAssociated[token] = true;
    }

    function _validate(CreateParams calldata params) internal {
        if (
            params.backing == address(0) || params.amount > uint64(type(int64).max)
                || params.expiry < block.timestamp + MIN_DURATION || params.expiry > block.timestamp + MAX_DURATION
                || bytes(params.name).length == 0 || bytes(params.symbol).length == 0
        ) revert InvalidParams();
        _requireFeeFreeBacking(params.backing);
    }

    /// @dev Shared tail of both creation paths, once `amount` of backing is held: mint, record, schedule.
    function _open(CreateParams calldata params, uint64 amount, uint256 creationValue, uint256 balanceBefore)
        internal
        returns (uint256 id)
    {
        if (amount == 0) revert InvalidParams();
        id = ++programCount;
        address voucher = _createVoucher(params, amount, IERC20Metadata(params.backing).decimals(), id, creationValue);
        isVoucher[voucher] = true;

        Program storage p = _programs[id];
        p.funder = msg.sender;
        p.backing = params.backing;
        p.voucher = voucher;
        p.expiry = params.expiry;
        p.status = Status.Active;
        p.funded = amount;
        p.charterHash = params.charterHash;

        _scheduleSettlement(id, params.expiry + SETTLEMENT_DELAY, true);

        uint256 reserve = address(this).balance - balanceBefore;
        p.hbarReserve = reserve;
        totalHbarReserve += reserve;

        emit ProgramCreated(id, msg.sender, voucher, params.backing, amount, params.expiry, params.charterHash);
    }

    /// @dev Measures what actually arrived rather than trusting the router's return value.
    function _swapHbarForBacking(address backing, uint256 hbarIn, uint64 minOut) internal returns (uint64) {
        address[] memory path = new address[](2);
        path[0] = WHBAR;
        path[1] = backing;
        uint256 before = IERC20Metadata(backing).balanceOf(address(this));
        SWAP_ROUTER.swapExactETHForTokens{ value: hbarIn }(minOut, path, address(this), block.timestamp + SWAP_DEADLINE);
        uint256 received = IERC20Metadata(backing).balanceOf(address(this)) - before;
        if (received < minOut || received > uint64(type(int64).max)) revert InsufficientSwapOutput(received);
        return uint64(received);
    }

    /// @dev Backing must arrive and leave 1:1. Custom fees would skim escrow (fractional) or bill the shared pool
    ///      (fixed); another program's voucher would be paused under this one.
    function _requireFeeFreeBacking(address backing) internal {
        if (isVoucher[backing]) revert UnsupportedBacking();
        (
            int64 rc,
            IHederaTokenService.FixedFee[] memory fixedFees,
            IHederaTokenService.FractionalFee[] memory fractionalFees,
            IHederaTokenService.RoyaltyFee[] memory royaltyFees
        ) = HTS.getTokenCustomFees(backing);
        if (
            rc != HederaResponseCodes.SUCCESS || fixedFees.length > 0 || fractionalFees.length > 0
                || royaltyFees.length > 0
        ) revert UnsupportedBacking();
    }

    /// @dev Forwards all gas but copies no return data, so a receiving contract cannot grief settlement with a
    ///      return-data bomb; a revert simply reports failure.
    function _sendHbar(address to, uint256 amount) internal returns (bool ok) {
        assembly {
            ok := call(gas(), to, amount, 0, 0, 0, 0)
        }
    }

    function _requireOpen(uint256 id) internal view returns (Program storage p) {
        p = _programs[id];
        if (p.status != Status.Active) revert NotActive();
        if (block.timestamp >= p.expiry) revert Expired();
    }

    function _removeFromList(uint256 id, address merchant) internal {
        address[] storage list = _merchantList[id];
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == merchant) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }

    function _check(int64 rc, bytes4 op) internal pure {
        if (rc != HederaResponseCodes.SUCCESS) revert HtsFailed(op, rc);
    }

    function _i64(uint64 amount) internal pure returns (int64) {
        if (amount > uint64(type(int64).max)) revert InvalidParams();
        // forge-lint: disable-next-line(unsafe-typecast)
        return int64(amount);
    }

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 digits;
        for (uint256 v = value; v != 0; v /= 10) {
            ++digits;
        }
        bytes memory buffer = new bytes(digits);
        for (; value != 0; value /= 10) {
            buffer[--digits] = bytes1(uint8(48 + value % 10));
        }
        return string(buffer);
    }
}
