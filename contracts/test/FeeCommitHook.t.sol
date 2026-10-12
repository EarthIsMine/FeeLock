// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "./utils/Deployers.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {Pool} from "@uniswap/v4-core/src/libraries/Pool.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {IFeeCommitHook} from "../src/interfaces/IFeeCommitHook.sol";

contract FeeCommitHookTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for PoolManager;

    uint24 constant MAX_FEE = 10_000; // 1%
    uint24 constant INITIAL_FEE = 3_000; // 0.3%
    int24 constant TICK_SPACING = 60;
    int24 constant RANGE = 600;
    int256 constant LIQUIDITY = 1e24;
    uint256 constant AMOUNT_IN = 1 ether;

    FeeCommitHook hook;
    PoolKey key;
    address feeManager = makeAddr("feeManager");
    address attacker = makeAddr("attacker");

    event FeeCommitted(PoolId indexed id, uint24 maxFee, uint24 initialFee, address feeManager);
    event FeeUpdated(PoolId indexed id, uint24 oldFee, uint24 newFee);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployNativePair();
        address at = hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 1);
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(manager), at);
        hook = FeeCommitHook(at);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, TICK_SPACING, IHooks(at));
    }

    function _commit() internal {
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, feeManager);
        addLiquidity(key, -RANGE, RANGE, LIQUIDITY);
    }

    /// @dev Same pair, price and liquidity as the committed pool, but with the fee fixed in the PoolKey.
    function _staticPool(uint24 fee) internal returns (PoolKey memory k) {
        k = initPool(currency0, currency1, IHooks(address(0)), fee, TICK_SPACING, SQRT_PRICE_1_1);
        addLiquidity(k, -RANGE, RANGE, LIQUIDITY);
    }

    function _out(BalanceDelta delta, bool zeroForOne) internal pure returns (uint256) {
        return uint256(uint128(zeroForOne ? delta.amount1() : delta.amount0()));
    }

    function _wrapped(bytes4 hookSelector, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            hookSelector,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    // ---------- deployment ----------

    function testRejectsAddressWithWrongPermissions() public {
        address wrong = hookAddress(Hooks.BEFORE_SWAP_FLAG, 2);
        // Run the constructor at `wrong` the way deployCodeTo does, but keep the revert data.
        vm.etch(wrong, abi.encodePacked(vm.getCode("FeeCommitHook.sol:FeeCommitHook"), abi.encode(manager)));
        (bool ok, bytes memory reason) = wrong.call("");
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(Hooks.HookAddressNotValid.selector, wrong));
    }

    function testVersion() public view {
        assertEq(hook.FEELOCK_HOOK_VERSION(), 1);
    }

    // ---------- initializePool ----------

    function testInitializePoolStoresCommitment() public {
        PoolId id = key.toId();
        vm.expectEmit(address(hook));
        emit FeeCommitted(id, MAX_FEE, INITIAL_FEE, feeManager);
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, feeManager);

        IFeeCommitHook.Commitment memory c = hook.commitmentOf(id);
        assertEq(c.maxFee, MAX_FEE);
        assertEq(c.currentFee, INITIAL_FEE);
        assertEq(c.feeManager, feeManager);
        assertTrue(c.exists);

        (uint160 sqrtPriceX96,,, uint24 lpFee) = manager.getSlot0(id);
        assertEq(sqrtPriceX96, SQRT_PRICE_1_1);
        assertEq(lpFee, INITIAL_FEE, "slot0 mirrors the current fee");
    }

    function testDirectInitializeIsBlocked() public {
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IFeeCommitHook.InitializeOnlyThroughHook.selector)
            )
        );
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    /// @notice A pool with this hook but a different tick spacing still cannot be created around the commitment.
    function testDirectInitializeIsBlockedForAnyKey() public {
        PoolKey memory other = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 10, IHooks(address(hook)));
        vm.prank(attacker);
        vm.expectRevert(
            _wrapped(
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IFeeCommitHook.InitializeOnlyThroughHook.selector)
            )
        );
        manager.initialize(other, SQRT_PRICE_1_1);
        assertFalse(hook.commitmentOf(other.toId()).exists);
    }

    function testRejectStaticFeeKey() public {
        key.fee = 3_000;
        vm.expectRevert(IFeeCommitHook.NotDynamicFeePool.selector);
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, feeManager);
    }

    function testRejectKeyForAnotherHook() public {
        key.hooks = IHooks(hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 3));
        vm.expectRevert(IFeeCommitHook.NotThisHook.selector);
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, feeManager);
    }

    function testRejectInitialFeeAboveCap() public {
        vm.expectRevert(IFeeCommitHook.FeeAboveCommitment.selector);
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, MAX_FEE + 1, feeManager);
    }

    function testRejectCapAboveMaxLpFee() public {
        uint24 tooHigh = LPFeeLibrary.MAX_LP_FEE + 1;
        vm.expectRevert(abi.encodeWithSelector(LPFeeLibrary.LPFeeTooLarge.selector, tooHigh));
        hook.initializePool(key, SQRT_PRICE_1_1, tooHigh, INITIAL_FEE, feeManager);
    }

    /// @notice Re-running initializePool with a looser cap reverts and leaves the original commitment intact.
    function testCannotRecommit() public {
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, feeManager);
        vm.prank(attacker);
        vm.expectRevert(Pool.PoolAlreadyInitialized.selector);
        hook.initializePool(key, SQRT_PRICE_1_1, LPFeeLibrary.MAX_LP_FEE, LPFeeLibrary.MAX_LP_FEE, attacker);

        IFeeCommitHook.Commitment memory c = hook.commitmentOf(key.toId());
        assertEq(c.maxFee, MAX_FEE);
        assertEq(c.currentFee, INITIAL_FEE);
        assertEq(c.feeManager, feeManager);
    }

    // ---------- setFee ----------

    function testSetFeeWithinCap() public {
        _commit();
        PoolId id = key.toId();
        vm.expectEmit(address(hook));
        emit FeeUpdated(id, INITIAL_FEE, MAX_FEE);
        vm.prank(feeManager);
        hook.setFee(key, MAX_FEE);

        assertEq(hook.commitmentOf(id).currentFee, MAX_FEE);
        (,,, uint24 lpFee) = manager.getSlot0(id);
        assertEq(lpFee, MAX_FEE);

        vm.prank(feeManager);
        hook.setFee(key, 0);
        assertEq(hook.commitmentOf(id).currentFee, 0);
    }

    function testSetFeeAboveCapReverts() public {
        _commit();
        vm.prank(feeManager);
        vm.expectRevert(IFeeCommitHook.FeeAboveCommitment.selector);
        hook.setFee(key, MAX_FEE + 1);
    }

    function testSetFeeOnlyFeeManager() public {
        _commit();
        vm.prank(attacker);
        vm.expectRevert(IFeeCommitHook.NotFeeManager.selector);
        hook.setFee(key, INITIAL_FEE + 1);
    }

    function testSetFeeUnknownPool() public {
        vm.prank(feeManager);
        vm.expectRevert(IFeeCommitHook.UnknownPool.selector);
        hook.setFee(key, INITIAL_FEE);
    }

    function testZeroFeeManagerFreezesFee() public {
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, address(0));
        vm.prank(attacker);
        vm.expectRevert(IFeeCommitHook.NotFeeManager.selector);
        hook.setFee(key, MAX_FEE);
    }

    /// @notice Nobody but the hook can move the pool's dynamic fee in PoolManager.
    function testOnlyHookUpdatesDynamicFee() public {
        _commit();
        vm.prank(attacker);
        vm.expectRevert(IPoolManager.UnauthorizedDynamicLPFeeUpdate.selector);
        manager.updateDynamicLPFee(key, MAX_FEE);
    }

    // ---------- callbacks ----------

    function testCallbacksOnlyFromPoolManager() public {
        _commit();
        vm.startPrank(attacker);
        vm.expectRevert(IFeeCommitHook.NotPoolManager.selector);
        hook.beforeInitialize(address(hook), key, SQRT_PRICE_1_1);
        vm.expectRevert(IFeeCommitHook.NotPoolManager.selector);
        hook.beforeSwap(attacker, key, SwapParams(true, -1, 0), "");
        vm.stopPrank();
    }

    // ---------- swaps ----------

    /// @notice A committed pool charges exactly its current fee: same output as a static pool with that fee.
    function testSwapChargesCurrentFee() public {
        _commit();
        PoolKey memory static03 = _staticPool(INITIAL_FEE);
        PoolKey memory static1 = _staticPool(MAX_FEE);

        uint256 snapshot = vm.snapshotState();
        assertEq(
            _out(swapExactIn(key, true, AMOUNT_IN, ""), true), _out(swapExactIn(static03, true, AMOUNT_IN, ""), true)
        );
        vm.revertToState(snapshot);

        vm.prank(feeManager);
        hook.setFee(key, MAX_FEE);
        assertEq(
            _out(swapExactIn(key, true, AMOUNT_IN, ""), true), _out(swapExactIn(static1, true, AMOUNT_IN, ""), true)
        );
    }

    /// @notice The quote is what the swap pays, in both directions and after a fee change.
    function testQuoteEqualsExecution() public {
        _commit();
        for (uint256 i; i < 2; ++i) {
            bool zeroForOne = i == 0;
            uint256 quoted = quoteExactIn(key, zeroForOne, AMOUNT_IN, "");
            assertEq(_out(swapExactIn(key, zeroForOne, AMOUNT_IN, ""), zeroForOne), quoted);
        }
        vm.prank(feeManager);
        hook.setFee(key, MAX_FEE);
        uint256 quotedAfter = quoteExactIn(key, true, AMOUNT_IN, "");
        assertEq(_out(swapExactIn(key, true, AMOUNT_IN, ""), true), quotedAfter);
    }
}
