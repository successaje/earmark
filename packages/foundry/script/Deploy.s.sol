//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { Earmark } from "../contracts/Earmark.sol";
import { DemoDollar } from "../contracts/DemoDollar.sol";

/**
 * @notice Deploys Earmark and the DemoDollar faucet.
 * @dev Only plain deployments happen here: Forge simulates scripts on a local EVM where the Hedera system contracts
 *      (0x167, 0x16b) do not exist. Token creation and the HCS topic are done by `yarn earmark:setup` afterwards.
 *
 * Example: yarn foundry:deploy --network hedera_testnet
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        Earmark earmark = new Earmark();
        deployments.push(Deployment({ name: "Earmark", addr: address(earmark) }));

        DemoDollar demoDollar = new DemoDollar();
        deployments.push(Deployment({ name: "DemoDollar", addr: address(demoDollar) }));
    }
}
