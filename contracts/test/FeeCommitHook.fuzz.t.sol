// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Deployers} from "./utils/Deployers.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {IFeeCommitHook} from "../src/interfaces/IFeeCommitHook.sol";

/// @dev Reads the fee PoolManager actually applied from its Swap event.
abstract contract SwapFeeReader {
    function _appliedFee(Vm.Log[] memory logs, address manager, PoolId id)
        internal
        pure
        returns (bool found, uint24 fee)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory log = logs[i];
            if (log.emitter == manager && log.topics[0] == IPoolManager.Swap.selector) {
                if (log.topics[1] != PoolId.unwrap(id)) continue;
                (,,,,, fee) = abi.decode(log.data, (int128, int128, uint160, uint128, int24, uint24));
                return (true, fee);
            }
        }
    }
}

/// @notice Drives one committed pool through random fee changes and swaps and counts every broken rule.
contract FeeCommitHandler is Deployers, SwapFeeReader {
    using PoolIdLibrary for PoolKey;

    uint24 public constant MAX_FEE = 10_000;
    uint24 public constant INITIAL_FEE = 3_000;

    FeeCommitHook public hook;
    PoolKey public key;

    uint256 public swaps;
    uint256 public limitReverts;
    uint24 public maxAppliedFee;
    uint256 public violations;
    string public lastViolation;

    constructor() {
        deployFreshManagerAndRouters();
        deployNativePair();
        address at = hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 1);
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(manager), at);
        hook = FeeCommitHook(at);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(at));
        // This handler is the fee manager.
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, address(this));
        // ~29,600 of each currency in range; 64 swaps of at most 100 never push the price to the limit.
        addLiquidity(key, -600, 600, 1e24);
    }

    function poolManager() external view returns (PoolManager) {
        return manager;
    }

    function setFee(uint24 newFee) external {
        newFee = uint24(bound(newFee, 0, MAX_FEE * 2));
        try hook.setFee(key, newFee) {
            if (newFee > MAX_FEE) _violate("setFee above the cap succeeded");
        } catch {
            if (newFee <= MAX_FEE) _violate("setFee within the cap reverted");
        }
    }

    function setFeeAsStranger(uint24 newFee, address stranger) external {
        if (stranger == address(this)) return;
        vm.prank(stranger);
        try hook.setFee(key, newFee) {
            _violate("a stranger changed the fee");
        } catch {}
    }

    function swap(bool zeroForOne, uint256 amountIn, uint24 userMax, bool withLimit) external {
        amountIn = bound(amountIn, 1e6, 100 ether);
        uint24 current = hook.commitmentOf(key.toId()).currentFee;
        bytes memory hookData = withLimit ? abi.encode(userMax) : bytes("");

        vm.recordLogs();
        try swapRouter.swap{value: zeroForOne ? NATIVE_BUDGET : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        ) {
            (bool found, uint24 fee) = _appliedFee(vm.getRecordedLogs(), address(manager), key.toId());
            if (!found) return _violate("swap without a Swap event");
            ++swaps;
            if (fee > maxAppliedFee) maxAppliedFee = fee;
            if (fee != current) _violate("applied fee != committed current fee");
            if (fee > MAX_FEE) _violate("applied fee above the cap");
            if (withLimit && fee > userMax) _violate("applied fee above the swapper limit");
        } catch {
            if (withLimit && current > userMax) ++limitReverts;
            else _violate("swap within all limits reverted");
        }
    }

    function _violate(string memory what) internal {
        ++violations;
        lastViolation = what;
    }
}

/// @notice Invariant: across any sequence of fee changes and swaps, the applied fee never exceeds the committed cap.
contract FeeCommitHookInvariantTest is StdInvariant, Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for PoolManager;

    FeeCommitHandler handler;

    function setUp() public {
        handler = new FeeCommitHandler();
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = FeeCommitHandler.setFee.selector;
        selectors[1] = FeeCommitHandler.setFeeAsStranger.selector;
        selectors[2] = FeeCommitHandler.swap.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_appliedFeeNeverAboveCap() public view {
        assertLe(handler.maxAppliedFee(), handler.MAX_FEE());
        assertEq(handler.violations(), 0, handler.lastViolation());
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_commitmentStaysWithinCap() public view {
        PoolKey memory key = _key();
        IFeeCommitHook.Commitment memory c = handler.hook().commitmentOf(key.toId());
        assertEq(c.maxFee, handler.MAX_FEE(), "cap never changes");
        assertLe(c.currentFee, c.maxFee);
        (,,, uint24 lpFee) = handler.poolManager().getSlot0(key.toId());
        assertEq(lpFee, c.currentFee, "slot0 mirrors the current fee");
    }

    /// @dev Guards against a vacuous pass: every run must have executed swaps.
    function afterInvariant() public view {
        assertGt(handler.swaps(), 0, "no swap ran");
    }

    function _key() internal view returns (PoolKey memory key) {
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) = handler.key();
    }
}

/// @notice Stateless fuzzing of the fee bounds for arbitrary caps.
contract FeeCommitHookFuzzTest is Deployers, SwapFeeReader {
    using PoolIdLibrary for PoolKey;

    FeeCommitHook hook;
    PoolKey key;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployNativePair();
        address at = hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 1);
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(manager), at);
        hook = FeeCommitHook(at);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(at));
    }

    function testFuzz_initializeAcceptsOnlyValidBounds(uint24 maxFee, uint24 initialFee) public {
        bool valid = maxFee <= LPFeeLibrary.MAX_LP_FEE && initialFee <= maxFee;
        if (!valid) vm.expectRevert();
        hook.initializePool(key, SQRT_PRICE_1_1, maxFee, initialFee, address(this));
        if (valid) {
            IFeeCommitHook.Commitment memory c = hook.commitmentOf(key.toId());
            assertEq(c.maxFee, maxFee);
            assertEq(c.currentFee, initialFee);
        }
    }

    function testFuzz_setFeeStaysWithinCap(uint24 maxFee, uint24 newFee) public {
        maxFee = uint24(bound(maxFee, 0, LPFeeLibrary.MAX_LP_FEE));
        hook.initializePool(key, SQRT_PRICE_1_1, maxFee, 0, address(this));
        if (newFee > maxFee) vm.expectRevert(IFeeCommitHook.FeeAboveCommitment.selector);
        hook.setFee(key, newFee);
        assertLe(hook.commitmentOf(key.toId()).currentFee, maxFee);
    }

    /// @notice The applied fee is the current fee, which is within the cap, and the swapper limit is honoured.
    function testFuzz_appliedFee(uint24 maxFee, uint24 fee, uint24 userMax, bool withLimit, bool zeroForOne) public {
        // Below 100% so an exact-input swap still has output to take.
        maxFee = uint24(bound(maxFee, 0, LPFeeLibrary.MAX_LP_FEE - 1));
        fee = uint24(bound(fee, 0, maxFee));
        hook.initializePool(key, SQRT_PRICE_1_1, maxFee, fee, address(this));
        addLiquidity(key, -600, 600, 1e24);

        bytes memory hookData = withLimit ? abi.encode(userMax) : bytes("");
        if (withLimit && fee > userMax) {
            vm.expectRevert();
            swapExactIn(key, zeroForOne, 1 ether, hookData);
            return;
        }
        vm.recordLogs();
        swapExactIn(key, zeroForOne, 1 ether, hookData);
        (bool found, uint24 applied) = _appliedFee(vm.getRecordedLogs(), address(manager), key.toId());
        assertTrue(found);
        assertEq(applied, fee);
        assertLe(applied, maxFee);
    }
}
