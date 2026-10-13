// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "./utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {IFeeCommitHook} from "../src/interfaces/IFeeCommitHook.sol";

/// @notice Flash accounting only checks balances when unlock returns, so inside one callback anyone can move a pool's
///         spot price with capital they do not have, call something, move it back and settle. This contract does
///         exactly that against a FeeCommitHook pool: crash the price with an unpaid swap, probe, restore, settle.
contract FlashManipulator is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable manager;
    PoolKey public key;
    uint160 public sqrtPriceBefore;
    uint160 public sqrtPriceDuringProbe;

    constructor(IPoolManager manager_, PoolKey memory key_) {
        manager = manager_;
        key = key_;
    }

    receive() external payable {}

    /// @param crashIn MON swapped in, unpaid until settlement, to crash the price.
    /// @param probeHookData hookData of the probe swap made while the price is crashed.
    function attack(uint256 crashIn, uint256 probeIn, bytes calldata probeHookData) external {
        manager.unlock(abi.encode(crashIn, probeIn, probeHookData));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(manager), "not manager");
        (uint256 crashIn, uint256 probeIn, bytes memory probeHookData) = abi.decode(raw, (uint256, uint256, bytes));
        (sqrtPriceBefore,,,) = manager.getSlot0(key.toId());

        // 1. Crash the spot price with MON nobody has paid for yet.
        BalanceDelta crash = _swap(true, crashIn, "");
        // 2. Probe while the pool is in a state that exists only inside this transaction.
        (sqrtPriceDuringProbe,,,) = manager.getSlot0(key.toId());
        _swap(true, probeIn, probeHookData);
        // 3. Push the price back with the tokens the crash produced.
        _swap(false, uint256(uint128(crash.amount1())), "");

        // 4. Settle what is owed and take what is owed back; unlock reverts unless every delta is zero.
        _clear(key.currency0);
        _clear(key.currency1);
        return "";
    }

    function _swap(bool zeroForOne, uint256 amountIn, bytes memory hookData) internal returns (BalanceDelta) {
        return manager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            hookData
        );
    }

    function _clear(Currency currency) internal {
        int256 delta = manager.currencyDelta(address(this), currency);
        if (delta < 0) {
            uint256 owed = uint256(-delta);
            if (currency.isAddressZero()) {
                manager.settle{value: owed}();
            } else {
                manager.sync(currency);
                MockERC20(Currency.unwrap(currency)).transfer(address(manager), owed);
                manager.settle();
            }
        } else if (delta > 0) {
            manager.take(currency, address(this), uint256(delta));
        }
    }
}

/// @notice FeeCommitHook reads no spot state: the fee it applies, the cap and the swapper's pinned fee hold even while
///         a flash-accounting attacker has the pool's price wherever they want it.
contract FlashManipulationTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for PoolManager;

    uint24 constant MAX_FEE = 10_000;
    uint24 constant FEE = 3_000;
    uint256 constant CRASH = 10_000 ether; // moves the spot price to under 1/100 of where it was
    uint256 constant PROBE = 1 ether;

    FeeCommitHook hook;
    PoolKey key;
    FlashManipulator attacker;
    address feeManager = makeAddr("feeManager");

    function setUp() public {
        deployFreshManagerAndRouters();
        deployNativePair();
        address at = hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 1);
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(manager), at);
        hook = FeeCommitHook(at);
        key = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(at));
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, FEE, feeManager);
        // Wide and shallow (~950 of each currency), so a flash-funded swap can move the price a long way.
        addLiquidity(key, -60_000, 60_000, 1e21);

        attacker = new FlashManipulator(manager, key);
        // Enough only for fees and rounding: the 10,000 MON crash is never paid for.
        vm.deal(address(attacker), 200 ether);
        MockERC20(Currency.unwrap(currency1)).transfer(address(attacker), 200 ether);
    }

    /// @dev Fees PoolManager applied, from its Swap events, in order.
    function _appliedFees(Vm.Log[] memory logs) internal view returns (uint24[] memory fees) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(manager) && logs[i].topics[0] == IPoolManager.Swap.selector) n++;
        }
        fees = new uint24[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(manager) || logs[i].topics[0] != IPoolManager.Swap.selector) continue;
            (,,,,, uint24 fee) = abi.decode(logs[i].data, (int128, int128, uint160, uint128, int24, uint24));
            fees[n++] = fee;
        }
    }

    function testCommittedFeeHoldsWhileSpotIsManipulated() public {
        vm.recordLogs();
        attacker.attack(CRASH, PROBE, abi.encode(FEE));

        // The price really was moved far away inside the transaction...
        uint160 before = attacker.sqrtPriceBefore();
        uint160 during = attacker.sqrtPriceDuringProbe();
        assertLt(during, before / 10, "spot price crashed by more than 100x in the callback");

        // ...yet every swap, the probe included, paid exactly the committed fee.
        uint24[] memory fees = _appliedFees(vm.getRecordedLogs());
        assertEq(fees.length, 3);
        for (uint256 i; i < fees.length; ++i) {
            assertEq(fees[i], FEE, "applied fee == committed fee");
        }

        // The commitment and the fee PoolManager stores are untouched, and the price is back near where it was.
        IFeeCommitHook.Commitment memory c = hook.commitmentOf(key.toId());
        assertEq(c.maxFee, MAX_FEE);
        assertEq(c.currentFee, FEE);
        (uint160 afterPrice,,, uint24 lpFee) = manager.getSlot0(key.toId());
        assertEq(lpFee, FEE);
        assertApproxEqRel(afterPrice, before, 0.01e18, "price restored within 1%");
    }

    /// @notice The swapper's pinned fee is checked against the committed fee, not against anything the attacker moved.
    function testPinnedFeeStillEnforcedInsideTheCallback() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IFeeCommitHook.FeeAboveUserLimit.selector, FEE, FEE - 1),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        attacker.attack(CRASH, PROBE, abi.encode(FEE - 1));
    }

    /// @notice Flash capital buys no authority: only the fee manager moves the fee, and never above the cap.
    function testNoFeeChangeWithoutTheFeeManager() public {
        vm.prank(address(attacker));
        vm.expectRevert(IFeeCommitHook.NotFeeManager.selector);
        hook.setFee(key, MAX_FEE);

        vm.prank(feeManager);
        vm.expectRevert(IFeeCommitHook.FeeAboveCommitment.selector);
        hook.setFee(key, MAX_FEE + 1);
    }
}
