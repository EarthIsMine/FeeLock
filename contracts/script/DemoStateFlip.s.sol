// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DemoSwapRouter} from "../src/demo/DemoSwapRouter.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {PoolSeeder} from "../src/demo/PoolSeeder.sol";
import {StateFlipFeeHook} from "../src/demo/StateFlipFeeHook.sol";
import {DeploymentIO} from "./DeploymentIO.sol";

/// @notice Adds the third demo pool to an existing DemoSetup: a StateFlipFeeHook pool (fee 0.3% until its owner, the
///         deployer, changes it) one tick spacing above the canonical price, next to the look-alike.
///         Env: DEMO_SEED_MON (default 0.05 ether). Refuses Monad mainnet; skips if already deployed.
contract DemoStateFlip is DeploymentIO {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 constant START_FEE = 3_000; // 0.3%, same as the canonical pool

    function run() external {
        require(block.chainid != MONAD_MAINNET, "DemoStateFlip: demo attack hooks are not deployed to mainnet");
        Deployment memory d = _load();
        require(d.token != address(0) && _hasCode(d.seeder), "DemoStateFlip: run DemoSetup first");
        if (_hasCode(d.stateFlipHook)) {
            console2.log("StateFlipFeeHook already deployed", d.stateFlipHook);
            return;
        }
        IPoolManager manager = IPoolManager(d.poolManager);
        uint256 pk = _deployerKey();
        address deployer = vm.addr(pk);
        uint128 seedMon = uint128(vm.envOr("DEMO_SEED_MON", uint256(0.05 ether)));

        vm.startBroadcast(pk);
        DemoSwapRouter(d.router).swapExactInputSingle{value: seedMon}(d.canonical, true, seedMon, 0, "");

        bytes memory args = abi.encode(address(manager), deployer, START_FEE);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, Hooks.BEFORE_SWAP_FLAG, type(StateFlipFeeHook).creationCode, args);
        d.stateFlipHook = address(new StateFlipFeeHook{salt: salt}(address(manager), deployer, START_FEE));
        require(d.stateFlipHook == predicted, "DemoStateFlip: hook address mismatch");
        d.stateFlip = PoolKey(
            d.canonical.currency0, d.canonical.currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(d.stateFlipHook)
        );

        (, int24 tick,,) = manager.getSlot0(d.canonical.toId());
        int24 tickUpper = (tick >= 0 ? ((tick + 59) / 60) * 60 : (tick / 60) * 60) + 60;
        uint256 amount = DemoToken(d.token).balanceOf(deployer);
        DemoToken(d.token).approve(d.seeder, amount);
        PoolSeeder(d.seeder).seed(d.stateFlip, tickUpper - 600, tickUpper, amount);
        vm.stopBroadcast();

        _save(d);
        console2.log("StateFlipFeeHook", d.stateFlipHook);
    }
}
