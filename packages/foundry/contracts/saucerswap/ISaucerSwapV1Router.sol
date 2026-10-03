// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The part of SaucerSwap's V1 router (Uniswap V2 style) Earmark uses to turn HBAR into a program's backing.
/// @dev Testnet router 0.0.19264, mainnet 0.0.3045981. Paths start with the WHBAR *token* (testnet 0.0.15058,
///      mainnet 0.0.1456986); the router wraps the HBAR sent as value. See docs.saucerswap.finance.
interface ISaucerSwapV1Router {
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}
