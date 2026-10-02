// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaTokenService } from "./hedera/IHederaTokenService.sol";
import { HederaResponseCodes } from "./hedera/HederaResponseCodes.sol";

/**
 * @title DemoDollar — a testnet-only HTS stablecoin stand-in with a faucet
 * @notice Lets anyone try Earmark without sourcing USDC. On a real deployment point Earmark at Circle's HTS USDC
 *         instead (testnet 0.0.429274, mainnet 0.0.456858); nothing in Earmark depends on this contract.
 */
contract DemoDollar {
    IHederaTokenService internal constant HTS = IHederaTokenService(address(0x167));

    uint8 public constant DECIMALS = 6;
    uint64 public constant DRIP_AMOUNT = 1_000 * 10 ** 6;
    uint256 public constant DRIP_COOLDOWN = 1 hours;
    int64 internal constant SUPPLY = int64(1_000_000_000) * int64(10 ** 6);

    address public token;
    mapping(address account => uint256) public lastDrip;

    event Initialized(address token);
    event Dripped(address indexed to, uint64 amount);

    error AlreadyInitialized();
    error NotInitialized();
    error CoolingDown(uint256 availableAt);
    error HtsFailed(int64 responseCode);
    error RefundFailed();

    /// @notice Create the HTS token with this contract as treasury. `msg.value` pays the creation fee and whatever
    ///         HTS does not use is sent back to the caller.
    /// @dev Separate from the constructor because HTS needs the treasury account to exist before creation.
    function initialize() external payable {
        if (token != address(0)) revert AlreadyInitialized();

        IHederaTokenService.HederaToken memory definition;
        definition.name = "Demo Dollar";
        definition.symbol = "dUSD";
        definition.treasury = address(this);
        definition.memo = "Testnet-only stand-in for USDC";
        definition.tokenKeys = new IHederaTokenService.TokenKey[](0);
        definition.expiry =
            IHederaTokenService.Expiry({ second: 0, autoRenewAccount: address(this), autoRenewPeriod: 7_776_000 });

        (int64 rc, address created) =
            HTS.createFungibleToken{ value: msg.value }(definition, SUPPLY, int32(uint32(DECIMALS)));
        if (rc != HederaResponseCodes.SUCCESS) revert HtsFailed(rc);

        token = created;
        emit Initialized(created);

        (bool ok,) = msg.sender.call{ value: address(this).balance }("");
        if (!ok) revert RefundFailed();
    }

    /// @notice Send DRIP_AMOUNT dUSD to the caller. Accounts with free auto-association slots (the default for
    ///         accounts created from an EVM address) are associated automatically.
    function drip() external {
        if (token == address(0)) revert NotInitialized();
        uint256 availableAt = lastDrip[msg.sender] + DRIP_COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < availableAt) revert CoolingDown(availableAt);

        lastDrip[msg.sender] = block.timestamp;
        // forge-lint: disable-next-line(unsafe-typecast)
        int64 rc = HTS.transferToken(token, address(this), msg.sender, int64(DRIP_AMOUNT));
        if (rc != HederaResponseCodes.SUCCESS) revert HtsFailed(rc);
        emit Dripped(msg.sender, DRIP_AMOUNT);
    }
}
