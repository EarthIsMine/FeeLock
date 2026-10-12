// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";
import {DemoSwapRouter} from "../src/demo/DemoSwapRouter.sol";
import {DeploymentIO} from "./DeploymentIO.sol";

/// @notice For chains without Uniswap v4 (Monad testnet, anvil): PoolManager, V4Quoter, StateView, DemoSwapRouter.
///         Refuses Monad mainnet, where FeeLock uses only the official v4 deployment (v4 is BUSL until 2027-06-15).
///         Skips anything already in deployments/<chainId>.json with code on chain.
contract DeployCore is DeploymentIO {
    function run() external {
        require(block.chainid != MONAD_MAINNET, "DeployCore: Monad mainnet uses the official v4 deployment");
        Deployment memory d = _load();
        uint256 pk = _deployerKey();
        if (d.deployBlock == 0) d.deployBlock = block.number;

        vm.startBroadcast(pk);
        if (!_hasCode(d.poolManager)) d.poolManager = address(new PoolManager(vm.addr(pk)));
        IPoolManager manager = IPoolManager(d.poolManager);
        if (!_hasCode(d.quoter)) d.quoter = address(new V4Quoter(manager));
        if (!_hasCode(d.stateView)) d.stateView = address(new StateView(manager));
        if (!_hasCode(d.router)) d.router = address(new DemoSwapRouter(manager));
        vm.stopBroadcast();

        _save(d);
        console2.log("PoolManager   ", d.poolManager);
        console2.log("V4Quoter      ", d.quoter);
        console2.log("StateView     ", d.stateView);
        console2.log("DemoSwapRouter", d.router);
    }
}
