// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { MockHtsToken } from "./MockHTS.sol";

/// @notice A SaucerSwap V1 router stand-in with a fixed rate, paying out from its own token balance.
contract MockSaucerRouter {
    /// @dev Output units per whole HBAR (1e8 tinybars).
    uint256 public rate;
    /// @dev Simulates a router that reports more than it delivers: it checks the minimum against the quoted amount
    ///      but transfers this much less.
    uint256 public shortfall;

    function setRate(uint256 unitsPerHbar) external {
        rate = unitsPerHbar;
    }

    function setShortfall(uint256 units) external {
        shortfall = units;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata) public view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * rate / 1e8;
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts)
    {
        require(block.timestamp <= deadline, "MockSaucerRouter: expired");
        amounts = getAmountsOut(msg.value, path);
        require(amounts[1] >= amountOutMin, "MockSaucerRouter: slippage");
        MockHtsToken(path[1]).transfer(to, amounts[1] - shortfall);
    }
}
