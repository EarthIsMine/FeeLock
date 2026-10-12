// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {Deployers} from "./utils/Deployers.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {CanonicalPoolRegistry} from "../src/CanonicalPoolRegistry.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {IFeeCommitHook} from "../src/interfaces/IFeeCommitHook.sol";
import {DemoLaunchpad} from "../src/demo/DemoLaunchpad.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {DemoSwapRouter} from "../src/demo/DemoSwapRouter.sol";
import {PoolSeeder} from "../src/demo/PoolSeeder.sol";

/// @notice The whole demo on a local v4 stack: launch → look-alike pool → naive routing loses → FeeLock route holds.
contract FeeLockE2ETest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for PoolManager;

    uint24 constant QUOTE_FEE = 500; // 0.05% shown to V4Quoter
    uint24 constant SWAP_FEE = 100_000; // 10% charged on real swaps
    uint128 constant ATTACKER_BUY = 0.05 ether; // MON the attacker spends on tokens to seed the look-alike
    uint128 constant TRADE = 0.001 ether; // MON the trader spends

    CanonicalPoolRegistry registry;
    FeeCommitHook hook;
    DemoLaunchpad launchpad;
    PoolSeeder seeder;
    DemoSwapRouter router;

    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");
    address trader = makeAddr("trader");

    address token;
    PoolKey canonical;
    PoolKey lookAlike;

    function setUp() public {
        deployFreshManagerAndRouters();
        registry = new CanonicalPoolRegistry(manager);
        address at = hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 1);
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(manager), at);
        hook = FeeCommitHook(at);
        launchpad = new DemoLaunchpad(manager, registry, hook);
        seeder = new PoolSeeder(manager);
        router = new DemoSwapRouter(manager);
        vm.deal(attacker, 10 ether);
        vm.deal(trader, 10 ether);
    }

    // ---------- scenario steps ----------

    function _launch() internal {
        vm.prank(creator);
        token = launchpad.launch("Demo", "DEMO");
        canonical = launchpad.poolKeyOf(token);
    }

    /// @dev The attacker buys tokens on the canonical pool, then opens a dynamic-fee pool one tick spacing above the
    ///      canonical price with a hook that quotes 0.05% and charges 10%, so it wins every best-quote comparison.
    function _seedLookAlike() internal {
        vm.startPrank(attacker);
        router.swapExactInputSingle{value: ATTACKER_BUY}(canonical, true, ATTACKER_BUY, 0, "");

        address attackHook = hookAddress(Hooks.BEFORE_SWAP_FLAG, 7);
        deployCodeTo(
            "QuoteAwareFeeHook.sol:QuoteAwareFeeHook",
            abi.encode(address(manager), address(quoter), QUOTE_FEE, SWAP_FEE),
            attackHook
        );
        lookAlike =
            PoolKey(canonical.currency0, canonical.currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(attackHook));

        (, int24 tick,,) = manager.getSlot0(canonical.toId());
        int24 tickUpper = (tick >= 0 ? ((tick + 59) / 60) * 60 : (tick / 60) * 60) + 60;
        uint256 amount = DemoToken(token).balanceOf(attacker);
        DemoToken(token).approve(address(seeder), amount);
        seeder.seed(lookAlike, tickUpper - 600, tickUpper, amount);
        vm.stopPrank();
    }

    function _quote(PoolKey memory key, bytes memory hookData) internal returns (uint256) {
        return quoteExactIn(key, true, TRADE, hookData);
    }

    function _tradeAs(address who, PoolKey memory key, uint256 minOut, bytes memory hookData)
        internal
        returns (uint256 received)
    {
        uint256 before = DemoToken(token).balanceOf(who);
        vm.prank(who);
        router.swapExactInputSingle{value: TRADE}(key, true, TRADE, uint128(minOut), hookData);
        received = DemoToken(token).balanceOf(who) - before;
    }

    // ---------- launch ----------

    function testLaunchDeclaresFeeCommittedCanonicalPool() public {
        _launch();
        bytes32 poolId = PoolId.unwrap(canonical.toId());
        assertEq(token, launchpad.predictToken(creator, "Demo", "DEMO"));

        (bool declared, CanonicalPoolRegistry.CanonicalPool memory pool) = registry.getCanonicalPool(token);
        assertTrue(declared);
        assertEq(pool.poolId, poolId);
        assertEq(pool.issuer, address(launchpad));
        assertEq(address(pool.key.hooks), address(hook));

        IFeeCommitHook.Commitment memory c = hook.commitmentOf(canonical.toId());
        assertEq(c.maxFee, launchpad.MAX_FEE());
        assertEq(c.currentFee, launchpad.INITIAL_FEE());
        assertEq(c.feeManager, creator);

        // The supply is locked in the pool; only rounding dust stays in the launchpad. The price starts on the range's
        // upper edge, so the liquidity becomes active with the first buy.
        assertLt(DemoToken(token).balanceOf(address(launchpad)), 1e9);
        assertEq(DemoToken(token).balanceOf(address(manager)) + DemoToken(token).balanceOf(address(launchpad)), 1e27);
    }

    function testRelaunchSameNameReverts() public {
        _launch();
        vm.prank(creator);
        vm.expectRevert();
        launchpad.launch("Demo", "DEMO");
    }

    // ---------- the attack and the two routes ----------

    function testLookAlikeWinsTheQuote() public {
        _launch();
        _seedLookAlike();
        uint256 canonicalQuote = _quote(canonical, "");
        uint256 lookAlikeQuote = _quote(lookAlike, "");
        console2.log("canonical quote  ", canonicalQuote);
        console2.log("look-alike quote ", lookAlikeQuote);
        assertGt(lookAlikeQuote, canonicalQuote, "a best-quote router picks the look-alike");
        assertFalse(registry.isCanonical(token, PoolId.unwrap(lookAlike.toId())));
    }

    /// @notice Naive routing: best quote wins. At 5% slippage the swap reverts; at 15% it executes and pays ~10% less
    ///         than quoted, and less than the canonical pool would have paid.
    function testNaiveRoutingLoses() public {
        _launch();
        _seedLookAlike();
        uint256 canonicalQuote = _quote(canonical, "");
        uint256 quoted = _quote(lookAlike, "");

        vm.prank(trader);
        vm.expectPartialRevert(DemoSwapRouter.TooLittleReceived.selector);
        router.swapExactInputSingle{value: TRADE}(lookAlike, true, TRADE, uint128(quoted * 95 / 100), "");

        uint256 received = _tradeAs(trader, lookAlike, quoted * 85 / 100, "");
        uint256 lossBps = (quoted - received) * 10_000 / quoted;
        console2.log("naive: received  ", received);
        console2.log("naive: loss (bps)", lossBps);
        assertApproxEqAbs(lossBps, (SWAP_FEE - QUOTE_FEE) / 100, 15, "loss ~ 10% - 0.05%");
        assertLt(received, canonicalQuote, "and less than the canonical pool would have paid");
    }

    /// @notice FeeLock route: the canonical, fee-committed pool with the swapper's maxFee in hookData pays its quote.
    function testFeeLockRoutePaysTheQuote() public {
        _launch();
        _seedLookAlike();
        bytes memory hookData = abi.encode(launchpad.MAX_FEE());
        uint256 quoted = _quote(canonical, hookData);
        uint256 received = _tradeAs(trader, canonical, quoted * 995 / 1000, hookData);
        assertEq(received, quoted, "quoted = paid");
    }

    /// @notice The fee manager raises the fee within the cap after the trader's quote. The trader pinned the quoted fee
    ///         in hookData, so the swap reverts instead of paying more.
    function testFeeRaiseAfterQuoteReverts() public {
        _launch();
        uint24 quotedFee = hook.commitmentOf(canonical.toId()).currentFee;
        bytes memory hookData = abi.encode(quotedFee);
        uint256 quoted = _quote(canonical, hookData);

        uint24 cap = launchpad.MAX_FEE();
        vm.prank(creator);
        hook.setFee(canonical, cap);

        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IFeeCommitHook.FeeAboveUserLimit.selector, cap, quotedFee),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        router.swapExactInputSingle{value: TRADE}(canonical, true, TRADE, uint128(quoted * 99 / 100), hookData);
    }

    function testCreatorCannotRaiseFeeAboveCap() public {
        _launch();
        uint24 cap = launchpad.MAX_FEE();
        vm.prank(creator);
        vm.expectRevert(IFeeCommitHook.FeeAboveCommitment.selector);
        hook.setFee(canonical, cap + 1);
    }
}
