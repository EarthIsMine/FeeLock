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
import {CanonicalPoolRegistry} from "../src/CanonicalPoolRegistry.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {DemoLaunchpad} from "../src/demo/DemoLaunchpad.sol";
import {DemoSwapRouter} from "../src/demo/DemoSwapRouter.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {PoolSeeder} from "../src/demo/PoolSeeder.sol";
import {QuoteAwareFeeHook} from "../src/demo/QuoteAwareFeeHook.sol";
import {DeploymentIO} from "./DeploymentIO.sol";

/// @notice The demo pair: launch a token through DemoLaunchpad (fee-committed canonical pool), then, acting as the
///         attacker, buy some of it and open a look-alike pool with QuoteAwareFeeHook one tick spacing above the
///         canonical price so it wins every best-quote comparison.
///         Env: DEMO_NAME / DEMO_SYMBOL (default "FeeLock Demo" / "FLD"), DEMO_SEED_MON (default 0.05 ether).
///         The look-alike step refuses Monad mainnet.
contract DemoSetup is DeploymentIO {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 constant QUOTE_FEE = 500; // 0.05% shown to V4Quoter
    uint24 constant SWAP_FEE = 100_000; // 10% charged on real swaps

    function run() external {
        Deployment memory d = _load();
        require(_hasCode(d.registry) && _hasCode(d.feeCommitHook), "DemoSetup: run DeployFeeLock first");
        require(_hasCode(d.router) && _hasCode(d.quoter), "DemoSetup: no router or quoter");
        IPoolManager manager = IPoolManager(d.poolManager);
        uint256 pk = _deployerKey();
        address deployer = vm.addr(pk);
        string memory name = vm.envOr("DEMO_NAME", string("FeeLock Demo"));
        string memory symbol = vm.envOr("DEMO_SYMBOL", string("FLD"));
        uint128 seedMon = uint128(vm.envOr("DEMO_SEED_MON", uint256(0.05 ether)));

        vm.startBroadcast(pk);
        if (!_hasCode(d.launchpad)) {
            d.launchpad =
                address(new DemoLaunchpad(manager, CanonicalPoolRegistry(d.registry), FeeCommitHook(d.feeCommitHook)));
        }
        if (!_hasCode(d.seeder)) d.seeder = address(new PoolSeeder(manager));

        // A repeated launch would collide on CREATE2 and burn the whole gas limit; stop before sending it.
        DemoLaunchpad launchpad = DemoLaunchpad(d.launchpad);
        require(
            launchpad.predictToken(deployer, name, symbol).code.length == 0,
            "DemoSetup: token already launched, set DEMO_SYMBOL"
        );
        d.token = launchpad.launch(name, symbol);
        d.canonical = launchpad.poolKeyOf(d.token);

        if (block.chainid != MONAD_MAINNET) _seedLookAlike(d, manager, deployer, seedMon);
        vm.stopBroadcast();

        _save(d);
        console2.log("DemoLaunchpad     ", d.launchpad);
        console2.log("PoolSeeder        ", d.seeder);
        console2.log("token             ", d.token);
        console2.log("QuoteAwareFeeHook ", d.attackHook);
    }

    function _seedLookAlike(Deployment memory d, IPoolManager manager, address deployer, uint128 seedMon) internal {
        DemoSwapRouter(d.router).swapExactInputSingle{value: seedMon}(d.canonical, true, seedMon, 0, "");

        bytes memory args = abi.encode(address(manager), d.quoter, QUOTE_FEE, SWAP_FEE);
        (address predicted, bytes32 salt) =
            HookMiner.find(CREATE2_FACTORY, Hooks.BEFORE_SWAP_FLAG, type(QuoteAwareFeeHook).creationCode, args);
        d.attackHook = address(new QuoteAwareFeeHook{salt: salt}(address(manager), d.quoter, QUOTE_FEE, SWAP_FEE));
        require(d.attackHook == predicted, "DemoSetup: attack hook address mismatch");
        d.lookAlike = PoolKey(
            d.canonical.currency0, d.canonical.currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(d.attackHook)
        );

        (, int24 tick,,) = manager.getSlot0(d.canonical.toId());
        int24 tickUpper = (tick >= 0 ? ((tick + 59) / 60) * 60 : (tick / 60) * 60) + 60;
        uint256 amount = DemoToken(d.token).balanceOf(deployer);
        DemoToken(d.token).approve(d.seeder, amount);
        PoolSeeder(d.seeder).seed(d.lookAlike, tickUpper - 600, tickUpper, amount);
    }
}
