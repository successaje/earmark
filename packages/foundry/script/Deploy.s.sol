//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { Earmark } from "../contracts/Earmark.sol";
import { DemoDollar } from "../contracts/DemoDollar.sol";
import { ISaucerSwapV1Router } from "../contracts/saucerswap/ISaucerSwapV1Router.sol";

/**
 * @notice Deploys Earmark (wired to SaucerSwap on Hedera networks) and the DemoDollar faucet.
 * @dev Only plain deployments happen here: Forge simulates scripts on a local EVM where the Hedera system contracts
 *      (0x167, 0x16b) do not exist. Token creation and the HCS topic are done by `yarn earmark:setup` afterwards.
 *
 * Example: yarn foundry:deploy --network hedera_testnet
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        (address router, address whbar) = saucerSwap();
        Earmark earmark = new Earmark(ISaucerSwapV1Router(router), whbar);
        deployments.push(Deployment({ name: "Earmark", addr: address(earmark) }));

        DemoDollar demoDollar = new DemoDollar();
        deployments.push(Deployment({ name: "DemoDollar", addr: address(demoDollar) }));
    }

    /// @dev SaucerSwap V1 router and WHBAR token ids from docs.saucerswap.finance; zero disables HBAR funding.
    function saucerSwap() internal view returns (address router, address whbar) {
        if (block.chainid == 296) return (address(uint160(19_264)), address(uint160(15_058))); // 0.0.19264, 0.0.15058
        if (block.chainid == 295) return (address(uint160(3_045_981)), address(uint160(1_456_986))); // 0.0.3045981, 0.0.1456986
        return (address(0), address(0));
    }
}
