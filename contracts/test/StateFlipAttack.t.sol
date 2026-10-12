// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "./utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {IFeeCommitHook} from "../src/interfaces/IFeeCommitHook.sol";
import {StateFlipFeeHook} from "../src/demo/StateFlipFeeHook.sol";

/// @notice The case a pre-sign simulation cannot catch: a hook that charges everyone the same fee, then has its owner
///         raise it between the trader's quote and the block that executes the swap. Same move against FeeCommitHook.
contract StateFlipAttackTest is Deployers {
    uint24 constant START_FEE = 3_000; // 0.3%
    uint24 constant FLIPPED_FEE = 100_000; // 10%
    uint24 constant CAP = 10_000; // 1%
    uint256 constant AMOUNT_IN = 1 ether;

    address attacker = makeAddr("attacker");
    address feeManager = makeAddr("feeManager");
    StateFlipFeeHook flip;
    FeeCommitHook commit;
    PoolKey flipKey;
    PoolKey commitKey;

    error TooLittleReceived(uint256 received, uint256 minOut);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployNativePair();

        address flipAt = hookAddress(Hooks.BEFORE_SWAP_FLAG, 1);
        deployCodeTo("StateFlipFeeHook.sol:StateFlipFeeHook", abi.encode(address(manager), attacker, START_FEE), flipAt);
        flip = StateFlipFeeHook(flipAt);
        flipKey = initPool(currency0, currency1, IHooks(flipAt), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, SQRT_PRICE_1_1);
        addLiquidity(flipKey, -600, 600, 1e24);

        address commitAt = hookAddress(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG, 2);
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(manager), commitAt);
        commit = FeeCommitHook(commitAt);
        commitKey = PoolKey(currency0, currency1, LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(commitAt));
        commit.initializePool(commitKey, SQRT_PRICE_1_1, CAP, START_FEE, feeManager);
        addLiquidity(commitKey, -600, 600, 1e24);
    }

    /// @notice Router behaviour: swap exact in, revert below minOut.
    function swapWithMinOut(PoolKey memory key, uint256 minOut, bytes memory hookData)
        external
        returns (uint256 received)
    {
        BalanceDelta delta = swapExactIn(key, true, AMOUNT_IN, hookData);
        received = uint256(uint128(delta.amount1()));
        if (received < minOut) revert TooLittleReceived(received, minOut);
    }

    function _lossBps(uint256 quoted, uint256 received) internal pure returns (uint256) {
        return (quoted - received) * 10_000 / quoted;
    }

    /// @dev Output scales with (1 - fee), so moving from `fromFee` to `toFee` loses 1 - (1 - to) / (1 - from).
    function _expectedLossBps(uint24 fromFee, uint24 toFee) internal pure returns (uint256) {
        return 10_000 - (1_000_000 - uint256(toFee)) * 10_000 / (1_000_000 - uint256(fromFee));
    }

    /// @notice Before the flip the quote and the real swap agree exactly: a dual simulation shows no gap.
    function testSimulationSeesNoGap() public {
        uint256 quoted = quoteExactIn(flipKey, true, AMOUNT_IN, "");
        uint256 snapshot = vm.snapshotState();
        assertEq(this.swapWithMinOut(flipKey, 0, ""), quoted, "quote == execution while the fee is unchanged");
        vm.revertToState(snapshot);
    }

    /// @notice The owner raises the fee after the quote: the swap still fits a 15% tolerance and loses ~9.73%.
    function testFlipBetweenQuoteAndExecution() public {
        uint256 quoted = quoteExactIn(flipKey, true, AMOUNT_IN, "");
        vm.prank(attacker);
        flip.setFee(FLIPPED_FEE);
        uint256 received = this.swapWithMinOut(flipKey, quoted * 85 / 100, "");
        assertApproxEqAbs(_lossBps(quoted, received), _expectedLossBps(START_FEE, FLIPPED_FEE), 1, "~9.73%");
    }

    /// @notice A swapper's pinned fee means nothing to this hook.
    function testPinnedFeeDoesNotBindStateFlip() public {
        uint256 quoted = quoteExactIn(flipKey, true, AMOUNT_IN, abi.encode(START_FEE));
        vm.prank(attacker);
        flip.setFee(FLIPPED_FEE);
        uint256 received = this.swapWithMinOut(flipKey, quoted * 85 / 100, abi.encode(START_FEE));
        assertGt(_lossBps(quoted, received), 900);
    }

    /// @notice The same move on FeeCommitHook: the fee manager can raise the fee only to the cap, and a swap carrying
    ///         the quoted fee in hookData reverts instead of paying more.
    function testFeeCommitHookBlocksTheSameMove() public {
        uint256 quoted = quoteExactIn(commitKey, true, AMOUNT_IN, abi.encode(START_FEE));

        vm.prank(feeManager);
        vm.expectRevert(IFeeCommitHook.FeeAboveCommitment.selector);
        commit.setFee(commitKey, FLIPPED_FEE);

        vm.prank(feeManager);
        commit.setFee(commitKey, CAP);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(commit),
                IHooks.beforeSwap.selector,
                abi.encodeWithSelector(IFeeCommitHook.FeeAboveUserLimit.selector, CAP, START_FEE),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        this.swapWithMinOut(commitKey, quoted * 85 / 100, abi.encode(START_FEE));

        // Even a swapper who sent no hookData pays at most the cap: ~0.7% over the quote, not ~9.7%.
        uint256 received = this.swapWithMinOut(commitKey, quoted * 85 / 100, "");
        assertApproxEqAbs(_lossBps(quoted, received), _expectedLossBps(START_FEE, CAP), 1);
    }

    function testOnlyOwnerFlips() public {
        vm.expectRevert(StateFlipFeeHook.NotOwner.selector);
        flip.setFee(FLIPPED_FEE);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(LPFeeLibrary.LPFeeTooLarge.selector, uint24(1_000_001)));
        flip.setFee(1_000_001);
    }
}
