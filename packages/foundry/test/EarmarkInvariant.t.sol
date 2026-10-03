// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { Earmark } from "../contracts/Earmark.sol";
import { IHederaTokenService } from "../contracts/hedera/IHederaTokenService.sol";
import { MockHTS, MockHtsToken } from "./mocks/MockHTS.sol";
import { MockHSS } from "./mocks/MockHSS.sol";
import { ISaucerSwapV1Router } from "../contracts/saucerswap/ISaucerSwapV1Router.sol";

/// @notice Drives one program through random claims, payments, redemptions and settlement.
contract EarmarkHandler is Test {
    uint64 public constant FUND = 1_000e6;
    uint64 internal constant SHARE = 100e6;

    Earmark public immutable earmark;
    MockHtsToken public immutable usd;
    MockHSS internal immutable hss;
    uint256 public immutable id;
    MockHtsToken public immutable voucher;

    address[] internal beneficiaries;
    address[] internal shops;
    /// @dev Backing paid out to merchants, by redemption or settlement. Ghost variable for the invariants.
    uint256 public paidToMerchants;

    constructor(Earmark earmark_, MockHtsToken usd_, MockHSS hss_, address funder) {
        earmark = earmark_;
        usd = usd_;
        hss = hss_;

        vm.startPrank(funder);
        usd.approve(address(earmark), FUND);
        id = earmark.createProgram{ value: 25e8 }(
            Earmark.CreateParams({
                backing: address(usd),
                amount: FUND,
                expiry: uint64(block.timestamp + 7 days),
                name: "Invariant",
                symbol: "eINV",
                charterHash: bytes32(0)
            })
        );
        vm.stopPrank();
        voucher = MockHtsToken(earmark.getProgram(id).voucher);

        address[] memory who = new address[](4);
        uint64[] memory amounts = new uint64[](4);
        for (uint256 i; i < 4; ++i) {
            who[i] = makeAddr(string.concat("beneficiary", vm.toString(i)));
            amounts[i] = SHARE;
            beneficiaries.push(who[i]);
            vm.prank(who[i]);
            voucher.associate();
        }
        vm.prank(funder);
        earmark.allocate(id, who, amounts);

        for (uint256 i; i < 3; ++i) {
            address shop = makeAddr(string.concat("shop", vm.toString(i)));
            shops.push(shop);
            vm.prank(shop);
            voucher.associate();
            vm.prank(shop);
            usd.associate();
            vm.prank(funder);
            earmark.approveMerchant(id, shop, "FOOD");
        }
    }

    function claim(uint256 who) external {
        address beneficiary = beneficiaries[who % beneficiaries.length];
        if (earmark.hasClaimed(id, beneficiary) || block.timestamp >= earmark.getProgram(id).expiry) return;
        vm.prank(beneficiary);
        earmark.claim(id);
    }

    function pay(uint256 who, uint256 shop, uint256 amount) external {
        address beneficiary = beneficiaries[who % beneficiaries.length];
        amount = bound(amount, 0, voucher.balanceOf(beneficiary));
        if (amount == 0 || earmark.getProgram(id).status == Earmark.Status.Closed) return;
        vm.prank(beneficiary);
        voucher.transfer(shops[shop % shops.length], amount);
    }

    function redeem(uint256 shop, uint256 amount) external {
        address merchant = shops[shop % shops.length];
        (bool approved,) = earmark.merchants(id, merchant);
        amount = bound(amount, 0, voucher.balanceOf(merchant));
        if (!approved || amount == 0 || earmark.getProgram(id).status == Earmark.Status.Closed) return;
        vm.prank(merchant);
        earmark.redeem(id, uint64(amount), bytes32(0));
        paidToMerchants += amount;
    }

    function settle() external {
        Earmark.Program memory p = earmark.getProgram(id);
        if (p.status == Earmark.Status.Closed || p.schedule == address(0)) return;
        MockHSS.Schedule memory s = hss.get(p.schedule);
        vm.warp(s.executeAt);
        hss.markExecuted(p.schedule);
        uint256 before = _merchantBacking();
        earmark.settle(id);
        paidToMerchants += _merchantBacking() - before;
    }

    function _merchantBacking() internal view returns (uint256 total) {
        for (uint256 i; i < shops.length; ++i) {
            total += usd.balanceOf(shops[i]);
        }
    }
}

contract EarmarkInvariantTest is Test {
    MockHTS internal hts;
    Earmark internal earmark;
    MockHtsToken internal usd;
    EarmarkHandler internal handler;
    address internal funder = makeAddr("funder");

    function setUp() public {
        vm.etch(address(0x167), address(new MockHTS()).code);
        vm.etch(address(0x16b), address(new MockHSS()).code);
        hts = MockHTS(address(0x167));
        earmark = new Earmark(ISaucerSwapV1Router(address(0)), address(0));

        IHederaTokenService.HederaToken memory def;
        def.name = "USD Coin";
        def.symbol = "USDC";
        def.treasury = address(this);
        def.tokenKeys = new IHederaTokenService.TokenKey[](0);
        vm.deal(address(this), 10e8);
        (, address token) = hts.createFungibleToken{ value: 10e8 }(def, 1_000_000e6, 6);
        usd = MockHtsToken(token);

        vm.prank(funder);
        usd.associate();
        usd.transfer(funder, 1_000e6);
        vm.deal(funder, 100e8);

        handler = new EarmarkHandler(earmark, usd, MockHSS(address(0x16b)), funder);
        targetContract(address(handler));
    }

    /// @dev The core promise: every circulating voucher is backed 1:1 by escrow held in the contract.
    function invariant_supplyEqualsEscrow() public view {
        uint256 id = handler.id();
        assertEq(handler.voucher().totalSupply(), earmark.escrowOf(id) + _unvoidedSupplyAfterClose(id));
        if (earmark.getProgram(id).status != Earmark.Status.Closed) {
            assertEq(usd.balanceOf(address(earmark)), earmark.escrowOf(id));
        }
    }

    /// @dev Backing is conserved: whatever left the contract went to merchants or back to the funder.
    function invariant_backingIsConserved() public view {
        Earmark.Program memory p = earmark.getProgram(handler.id());
        assertEq(usd.balanceOf(address(earmark)) + handler.paidToMerchants() + p.refunded, handler.FUND());
        assertEq(p.redeemed, handler.paidToMerchants());
    }

    /// @dev After close, unspent vouchers still exist on paper but are paused and backed by nothing.
    function _unvoidedSupplyAfterClose(uint256 id) internal view returns (uint256) {
        Earmark.Program memory p = earmark.getProgram(id);
        return p.status == Earmark.Status.Closed ? p.funded - p.redeemed : 0;
    }
}
