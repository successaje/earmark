// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { Earmark } from "../contracts/Earmark.sol";
import { MockHTS, MockHtsToken } from "./mocks/MockHTS.sol";
import { MockHSS } from "./mocks/MockHSS.sol";
import { IHederaTokenService } from "../contracts/hedera/IHederaTokenService.sol";

contract EarmarkTest is Test {
    address internal constant HTS_ADDR = address(0x167);
    address internal constant HSS_ADDR = address(0x16b);

    uint64 internal constant FUND = 1_000e6;
    uint256 internal constant CREATE_VALUE = 25e8; // tinybars; MockHTS keeps 10e8 as the creation fee
    bytes32 internal constant CHARTER = keccak256("charter");
    bytes32 internal constant FOOD = "FOOD";

    MockHTS internal hts;
    MockHSS internal hss;
    Earmark internal earmark;
    MockHtsToken internal usd;

    address internal funder = makeAddr("funder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal grocer = makeAddr("grocer");
    address internal pharmacy = makeAddr("pharmacy");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.etch(HTS_ADDR, address(new MockHTS()).code);
        vm.etch(HSS_ADDR, address(new MockHSS()).code);
        hts = MockHTS(HTS_ADDR);
        hss = MockHSS(HSS_ADDR);
        earmark = new Earmark();

        usd = _createBackingToken();
        vm.prank(address(this));
        usd.transfer(funder, 10_000e6);
        vm.deal(funder, 100e8);
    }

    // ------------------------------------------------------------------
    // createProgram
    // ------------------------------------------------------------------

    function test_createProgram_escrowsBackingAndMintsVoucher() public {
        uint256 id = _createProgram(7 days);
        Earmark.Program memory p = earmark.getProgram(id);

        assertEq(p.funder, funder);
        assertEq(uint8(p.status), uint8(Earmark.Status.Active));
        assertEq(p.funded, FUND);
        assertEq(usd.balanceOf(address(earmark)), FUND);
        assertEq(MockHtsToken(p.voucher).totalSupply(), FUND);
        assertEq(MockHtsToken(p.voucher).balanceOf(address(earmark)), FUND);
        assertEq(MockHtsToken(p.voucher).decimals(), 6);
        assertEq(p.charterHash, CHARTER);
    }

    function test_createProgram_contractHoldsKycWipePauseButNoSupplyKey() public {
        address voucher = earmark.getProgram(_createProgram(7 days)).voucher;
        (, address treasury, address kycKey, address wipeKey, address pauseKey,,) = hts.tokens(voucher);
        assertEq(treasury, address(earmark));
        assertEq(kycKey, address(earmark));
        assertEq(wipeKey, address(earmark));
        assertEq(pauseKey, address(earmark));
    }

    function test_createProgram_schedulesItsOwnSettlementAtExpiry() public {
        uint256 id = _createProgram(7 days);
        Earmark.Program memory p = earmark.getProgram(id);
        MockHSS.Schedule memory s = hss.get(p.schedule);

        assertEq(s.creator, address(earmark));
        assertEq(s.to, address(earmark));
        assertEq(s.executeAt, p.expiry + earmark.SETTLEMENT_DELAY(), "settles after Hedera's block time catches up");
        assertEq(s.gasLimit, earmark.SETTLE_GAS_LIMIT());
        assertEq(s.callData, abi.encodeCall(Earmark.settle, (id)));
    }

    function test_createProgram_probesForwardWhenSecondIsFull() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        uint256 target = expiry + earmark.SETTLEMENT_DELAY();
        hss.setFull(target, true);
        hss.setFull(target + 1, true);

        uint256 id = _createProgramAt(expiry);
        assertEq(hss.get(earmark.getProgram(id).schedule).executeAt, target + 2);
    }

    function test_createProgram_revertsWhenNoCapacityInProbeWindow() public {
        uint64 expiry = uint64(block.timestamp + 7 days);
        for (uint256 i; i < 30; ++i) {
            hss.setFull(expiry + earmark.SETTLEMENT_DELAY() + i, true);
        }
        _approveFunding(FUND);
        Earmark.CreateParams memory params = _params(expiry);
        params.backing = address(usd);
        vm.prank(funder);
        vm.expectRevert(Earmark.NoScheduleCapacity.selector);
        earmark.createProgram{ value: CREATE_VALUE }(params);
    }

    function test_createProgram_recordsReserveNetOfCreationFee() public {
        uint256 id = _createProgram(7 days);
        uint256 expected = CREATE_VALUE - hts.CREATE_FEE();
        assertEq(earmark.getProgram(id).hbarReserve, expected);
        assertEq(earmark.totalHbarReserve(), expected);
        assertEq(address(earmark).balance, expected);
    }

    function test_createProgram_rejectsBadParams() public {
        _approveFunding(FUND);
        Earmark.CreateParams memory params = _params(uint64(block.timestamp + 7 days));

        params.expiry = uint64(block.timestamp + 30 seconds);
        _expectInvalid(params);

        params.expiry = uint64(block.timestamp + 61 days);
        _expectInvalid(params);

        params = _params(uint64(block.timestamp + 7 days));
        params.amount = 0;
        _expectInvalid(params);

        params = _params(uint64(block.timestamp + 7 days));
        params.symbol = "";
        _expectInvalid(params);
    }

    function test_createProgram_withoutAllowanceReverts() public {
        Earmark.CreateParams memory params = _params(uint64(block.timestamp + 7 days));
        params.backing = address(usd);
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(Earmark.HtsFailed.selector, IHederaTokenService.transferFrom.selector, 292)
        );
        earmark.createProgram{ value: CREATE_VALUE }(params);
    }

    // ------------------------------------------------------------------
    // allocate / claim
    // ------------------------------------------------------------------

    function test_claim_grantsKycAndDeliversVouchers() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 200e6);
        address voucher = _voucher(id);

        _associate(voucher, alice);
        vm.prank(alice);
        earmark.claim(id);

        assertEq(MockHtsToken(voucher).balanceOf(alice), 200e6);
        assertTrue(hts.kyc(voucher, alice));
        assertTrue(earmark.hasClaimed(id, alice));
        assertEq(earmark.getProgram(id).claimed, 200e6);
    }

    function test_claim_requiresAssociation() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 200e6);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(Earmark.HtsFailed.selector, IHederaTokenService.grantTokenKyc.selector, 184)
        );
        earmark.claim(id);
    }

    function test_claim_twiceReverts() public {
        uint256 id = _createProgram(7 days);
        _allocateAndClaim(id, alice, 200e6);
        vm.prank(alice);
        vm.expectRevert(Earmark.AlreadyClaimed.selector);
        earmark.claim(id);
    }

    function test_claim_withoutAllocationReverts() public {
        uint256 id = _createProgram(7 days);
        vm.prank(stranger);
        vm.expectRevert(Earmark.NothingToClaim.selector);
        earmark.claim(id);
    }

    function test_claim_afterExpiryReverts() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 200e6);
        _associate(_voucher(id), alice);
        vm.warp(block.timestamp + 7 days);
        vm.prank(alice);
        vm.expectRevert(Earmark.Expired.selector);
        earmark.claim(id);
    }

    function test_allocate_cannotExceedEscrow() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 600e6);

        address[] memory who = new address[](1);
        uint64[] memory amounts = new uint64[](1);
        who[0] = bob;
        amounts[0] = 400e6 + 1;
        vm.prank(funder);
        vm.expectRevert(Earmark.OverAllocated.selector);
        earmark.allocate(id, who, amounts);
    }

    function test_allocate_overwritesPendingAllocation() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 600e6);
        _allocate(id, alice, 100e6);
        assertEq(earmark.allocationOf(id, alice), 100e6);
        assertEq(earmark.getProgram(id).allocated, 100e6);
    }

    function test_allocate_onlyFunder() public {
        uint256 id = _createProgram(7 days);
        vm.prank(stranger);
        vm.expectRevert(Earmark.NotFunder.selector);
        earmark.allocate(id, new address[](0), new uint64[](0));
    }

    function test_deallocate_releasesUnclaimed() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 300e6);
        vm.prank(funder);
        earmark.deallocate(id, alice);
        assertEq(earmark.allocationOf(id, alice), 0);
        assertEq(earmark.getProgram(id).allocated, 0);
    }

    // ------------------------------------------------------------------
    // The closed loop: enforced by HTS KYC, not by Earmark
    // ------------------------------------------------------------------

    function test_vouchers_flowToApprovedMerchant() public {
        uint256 id = _createProgram(7 days);
        _allocateAndClaim(id, alice, 200e6);
        _approveMerchant(id, grocer);

        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        vm.prank(alice);
        voucherToken.transfer(grocer, 50e6);
        assertEq(MockHtsToken(_voucher(id)).balanceOf(grocer), 50e6);
    }

    function test_vouchers_cannotLeaveTheProgram() public {
        uint256 id = _createProgram(7 days);
        _allocateAndClaim(id, alice, 200e6);
        address voucher = _voucher(id);
        _associate(voucher, stranger); // association alone is not enough

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockHTS.HtsRejected.selector, int64(176)));
        MockHtsToken(voucher).transfer(stranger, 1);
    }

    // ------------------------------------------------------------------
    // Merchants
    // ------------------------------------------------------------------

    function test_redeem_wipesVouchersAndPaysBacking() public {
        uint256 id = _createProgram(7 days);
        _spend(id, alice, grocer, 120e6);
        bytes32 receipt = keccak256("receipt-1");

        vm.expectEmit(true, true, false, true);
        emit Earmark.Redeemed(id, grocer, 120e6, receipt);
        vm.prank(grocer);
        earmark.redeem(id, 120e6, receipt);

        assertEq(usd.balanceOf(grocer), 120e6);
        assertEq(MockHtsToken(_voucher(id)).balanceOf(grocer), 0);
        assertEq(MockHtsToken(_voucher(id)).totalSupply(), FUND - 120e6);
        assertEq(earmark.escrowOf(id), FUND - 120e6);
    }

    function test_redeem_onlyApprovedMerchants() public {
        uint256 id = _createProgram(7 days);
        _allocateAndClaim(id, alice, 200e6);
        vm.prank(alice);
        vm.expectRevert(Earmark.NotMerchant.selector);
        earmark.redeem(id, 1, bytes32(0));
    }

    function test_redeem_moreThanHeldReverts() public {
        uint256 id = _createProgram(7 days);
        _spend(id, alice, grocer, 10e6);
        vm.prank(grocer);
        vm.expectRevert(
            abi.encodeWithSelector(Earmark.HtsFailed.selector, IHederaTokenService.wipeTokenAccount.selector, 178)
        );
        earmark.redeem(id, 11e6, bytes32(0));
    }

    function test_approveMerchant_rejectsBeneficiaryAndDuplicates() public {
        uint256 id = _createProgram(7 days);
        _allocate(id, alice, 1);
        vm.startPrank(funder);
        vm.expectRevert(Earmark.InvalidParams.selector);
        earmark.approveMerchant(id, alice, FOOD);
        vm.stopPrank();

        _approveMerchant(id, grocer);
        vm.prank(funder);
        vm.expectRevert(Earmark.MerchantExists.selector);
        earmark.approveMerchant(id, grocer, FOOD);
    }

    function test_removeMerchant_paysOutThenCutsOff() public {
        uint256 id = _createProgram(7 days);
        _spend(id, alice, grocer, 40e6);

        vm.prank(funder);
        earmark.removeMerchant(id, grocer);

        assertEq(usd.balanceOf(grocer), 40e6);
        assertFalse(hts.kyc(_voucher(id), grocer));
        assertEq(earmark.getMerchants(id).length, 0);

        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockHTS.HtsRejected.selector, int64(176)));
        voucherToken.transfer(grocer, 1);
    }

    // ------------------------------------------------------------------
    // Keeperless settlement
    // ------------------------------------------------------------------

    function test_settle_beforeExpiryReverts() public {
        uint256 id = _createProgram(7 days);
        vm.expectRevert(Earmark.NotExpired.selector);
        earmark.settle(id);
    }

    function test_settle_scheduledRunPaysMerchantsPausesAndRefunds() public {
        uint256 id = _createProgram(7 days);
        _allocateAndClaim(id, alice, 200e6);
        _approveMerchant(id, grocer);
        _approveMerchant(id, pharmacy);
        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        vm.startPrank(alice);
        voucherToken.transfer(grocer, 150e6);
        voucherToken.transfer(pharmacy, 30e6);
        vm.stopPrank();
        _allocate(id, bob, 100e6); // never claimed

        uint256 funderUsdBefore = usd.balanceOf(funder);
        uint256 funderHbarBefore = funder.balance;

        _fire(earmark.getProgram(id).schedule);

        Earmark.Program memory p = earmark.getProgram(id);
        assertEq(uint8(p.status), uint8(Earmark.Status.Closed));
        assertEq(usd.balanceOf(grocer), 150e6);
        assertEq(usd.balanceOf(pharmacy), 30e6);
        assertEq(usd.balanceOf(funder) - funderUsdBefore, FUND - 180e6);
        assertEq(usd.balanceOf(address(earmark)), 0);
        assertEq(funder.balance - funderHbarBefore, CREATE_VALUE - hts.CREATE_FEE());
        assertEq(earmark.totalHbarReserve(), 0);

        (,,,,, bool paused,) = hts.tokens(p.voucher);
        assertTrue(paused);
        assertFalse(hts.kyc(p.voucher, grocer));
    }

    function test_settle_leftoverVouchersAreDeadAfterClose() public {
        uint256 id = _createProgram(7 days);
        _spend(id, alice, grocer, 10e6);
        _fire(earmark.getProgram(id).schedule);

        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockHTS.HtsRejected.selector, int64(315)));
        voucherToken.transfer(grocer, 1);
    }

    function test_settle_continuesInBatchesUntilDone() public {
        uint256 id = _createProgram(7 days);
        uint256 merchantCount = earmark.SETTLE_BATCH() * 2 + 3;
        _allocateAndClaim(id, alice, uint64(merchantCount) * 1e6);
        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        for (uint256 i; i < merchantCount; ++i) {
            address m = address(uint160(0xA000 + i));
            _approveMerchant(id, m);
            vm.prank(alice);
            voucherToken.transfer(m, 1e6);
        }

        _fire(earmark.getProgram(id).schedule);
        Earmark.Program memory p = earmark.getProgram(id);
        assertEq(uint8(p.status), uint8(Earmark.Status.Settling));
        assertEq(p.settleCursor, earmark.SETTLE_BATCH());
        assertEq(hss.get(p.schedule).executeAt, block.timestamp + earmark.SETTLEMENT_DELAY(), "next batch is scheduled");

        _fire(p.schedule);
        _fire(earmark.getProgram(id).schedule);

        p = earmark.getProgram(id);
        assertEq(uint8(p.status), uint8(Earmark.Status.Closed));
        assertEq(p.redeemed, merchantCount * 1e6);
        assertEq(p.schedule, address(0));
        // These merchants never associated with the backing token, so their payouts were parked, not lost.
        assertEq(earmark.owed(id, address(0xA000)), 1e6);
    }

    function test_settle_rejectedPayoutIsOwedNotBlocking() public {
        uint256 id = _createProgram(7 days);
        address picky = makeAddr("picky"); // associated with the voucher but not with the backing token
        _allocateAndClaim(id, alice, 50e6);
        _approveMerchant(id, picky);
        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        vm.prank(alice);
        voucherToken.transfer(picky, 50e6);

        _fire(earmark.getProgram(id).schedule);
        assertEq(uint8(earmark.getProgram(id).status), uint8(Earmark.Status.Closed));
        assertEq(earmark.owed(id, picky), 50e6);
        assertEq(usd.balanceOf(address(earmark)), 50e6, "owed backing stays escrowed");

        _associate(address(usd), picky);
        vm.prank(picky);
        earmark.withdrawOwed(id);
        assertEq(usd.balanceOf(picky), 50e6);
        assertEq(earmark.owed(id, picky), 0);

        vm.prank(picky);
        vm.expectRevert(Earmark.NothingOwed.selector);
        earmark.withdrawOwed(id);
    }

    function test_settle_anyoneCanSettleIfTheScheduleNeverRuns() public {
        uint256 id = _createProgram(7 days);
        address schedule = earmark.getProgram(id).schedule;
        vm.warp(earmark.getProgram(id).expiry);

        vm.prank(stranger);
        earmark.settle(id);
        assertEq(uint8(earmark.getProgram(id).status), uint8(Earmark.Status.Closed));

        // The schedule still fires later; it reverts harmlessly instead of settling twice.
        vm.warp(hss.get(schedule).executeAt);
        hss.markExecuted(schedule);
        vm.prank(address(earmark));
        vm.expectRevert(Earmark.AlreadyClosed.selector);
        earmark.settle(id);
    }

    function test_settle_afterCloseReverts() public {
        uint256 id = _createProgram(7 days);
        _fire(earmark.getProgram(id).schedule);
        vm.expectRevert(Earmark.AlreadyClosed.selector);
        earmark.settle(id);
    }

    function test_settle_refundNeverTouchesOtherProgramsReserve() public {
        uint256 first = _createProgram(7 days);
        uint256 second = _createProgram(14 days);
        uint256 secondReserve = earmark.getProgram(second).hbarReserve;

        // Simulate the network charging 1 HBAR of schedule execution fees to the contract.
        vm.deal(address(earmark), address(earmark).balance - 1e8);
        _fire(earmark.getProgram(first).schedule);

        assertEq(address(earmark).balance, secondReserve);
        assertEq(earmark.totalHbarReserve(), secondReserve);
    }

    // ------------------------------------------------------------------
    // Expiry only moves forward
    // ------------------------------------------------------------------

    function test_extendExpiry_replacesSchedule() public {
        uint256 id = _createProgram(7 days);
        address oldSchedule = earmark.getProgram(id).schedule;
        uint64 newExpiry = uint64(block.timestamp + 20 days);

        vm.prank(funder);
        earmark.extendExpiry(id, newExpiry);

        Earmark.Program memory p = earmark.getProgram(id);
        assertTrue(hss.get(oldSchedule).deleted);
        assertEq(p.expiry, newExpiry);
        assertEq(hss.get(p.schedule).executeAt, newExpiry + earmark.SETTLEMENT_DELAY());
    }

    function test_extendExpiry_cannotShorten() public {
        uint256 id = _createProgram(7 days);
        vm.prank(funder);
        vm.expectRevert(Earmark.InvalidParams.selector);
        earmark.extendExpiry(id, uint64(block.timestamp + 1 days));
    }

    // ------------------------------------------------------------------
    // Invariant: voucher supply always equals what is still escrowed
    // ------------------------------------------------------------------

    function testFuzz_supplyEqualsEscrow(uint64 claimAmount, uint64 spend, uint64 redeemAmount) public {
        claimAmount = uint64(bound(claimAmount, 1, FUND));
        spend = uint64(bound(spend, 0, claimAmount));
        redeemAmount = uint64(bound(redeemAmount, 0, spend));

        uint256 id = _createProgram(7 days);
        _allocateAndClaim(id, alice, claimAmount);
        _approveMerchant(id, grocer);
        address voucher = _voucher(id);

        if (spend > 0) {
            vm.prank(alice);
            MockHtsToken(voucher).transfer(grocer, spend);
        }
        if (redeemAmount > 0) {
            vm.prank(grocer);
            earmark.redeem(id, redeemAmount, bytes32(0));
        }
        assertEq(MockHtsToken(voucher).totalSupply(), earmark.escrowOf(id));
        assertEq(usd.balanceOf(address(earmark)), earmark.escrowOf(id));

        _fire(earmark.getProgram(id).schedule);
        assertEq(usd.balanceOf(grocer), spend);
        assertEq(usd.balanceOf(address(earmark)), 0);
        assertEq(earmark.escrowOf(id), 0);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _createBackingToken() internal returns (MockHtsToken) {
        IHederaTokenService.HederaToken memory def;
        def.name = "USD Coin";
        def.symbol = "USDC";
        def.treasury = address(this);
        def.tokenKeys = new IHederaTokenService.TokenKey[](0);
        vm.deal(address(this), 10e8);
        (, address token) = hts.createFungibleToken{ value: 10e8 }(def, 1_000_000e6, 6);
        _associate(token, funder);
        _associate(token, grocer);
        _associate(token, pharmacy);
        return MockHtsToken(token);
    }

    function _params(uint64 expiry) internal pure returns (Earmark.CreateParams memory) {
        return Earmark.CreateParams({
            backing: address(0),
            amount: FUND,
            expiry: expiry,
            name: "Food Aid",
            symbol: "eFOOD",
            charterHash: CHARTER
        });
    }

    function _approveFunding(uint256 amount) internal {
        vm.prank(funder);
        usd.approve(address(earmark), amount);
    }

    function _createProgram(uint256 duration) internal returns (uint256) {
        return _createProgramAt(uint64(block.timestamp + duration));
    }

    function _createProgramAt(uint64 expiry) internal returns (uint256 id) {
        _approveFunding(FUND);
        Earmark.CreateParams memory params = _params(expiry);
        params.backing = address(usd);
        vm.prank(funder);
        id = earmark.createProgram{ value: CREATE_VALUE }(params);
    }

    function _expectInvalid(Earmark.CreateParams memory params) internal {
        params.backing = address(usd);
        vm.prank(funder);
        vm.expectRevert(Earmark.InvalidParams.selector);
        earmark.createProgram{ value: CREATE_VALUE }(params);
    }

    function _voucher(uint256 id) internal view returns (address) {
        return earmark.getProgram(id).voucher;
    }

    function _associate(address token, address account) internal {
        vm.prank(account);
        MockHtsToken(token).associate();
    }

    function _allocate(uint256 id, address who, uint64 amount) internal {
        address[] memory list = new address[](1);
        uint64[] memory amounts = new uint64[](1);
        list[0] = who;
        amounts[0] = amount;
        vm.prank(funder);
        earmark.allocate(id, list, amounts);
    }

    function _allocateAndClaim(uint256 id, address who, uint64 amount) internal {
        _allocate(id, who, amount);
        _associate(_voucher(id), who);
        vm.prank(who);
        earmark.claim(id);
    }

    function _approveMerchant(uint256 id, address merchant) internal {
        _associate(_voucher(id), merchant);
        vm.prank(funder);
        earmark.approveMerchant(id, merchant, FOOD);
    }

    function _spend(uint256 id, address beneficiary, address merchant, uint64 amount) internal {
        _allocateAndClaim(id, beneficiary, amount);
        _approveMerchant(id, merchant);
        MockHtsToken voucherToken = MockHtsToken(_voucher(id));
        vm.prank(beneficiary);
        voucherToken.transfer(merchant, amount);
    }

    /// @dev Replays a schedule the way the network executes it: at its second, from the contract that created it.
    function _fire(address schedule) internal {
        MockHSS.Schedule memory s = hss.get(schedule);
        if (block.timestamp < s.executeAt) vm.warp(s.executeAt);
        hss.markExecuted(schedule);
        vm.prank(s.creator);
        (bool ok, bytes memory ret) = s.to.call{ gas: s.gasLimit }(s.callData);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
