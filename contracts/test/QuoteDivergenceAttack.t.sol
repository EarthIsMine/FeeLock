// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {Deployers} from "./utils/Deployers.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {QuoteAwareFeeHook} from "../src/demo/QuoteAwareFeeHook.sol";

/// @notice Reproduces the attack FeeLock blocks, on the real v4-core PoolManager and v4-periphery V4Quoter.
///         Same pair, two pools at the same price and depth: a static 0.25% pool (the one an issuer would declare)
///         and a dynamic-fee look-alike whose hook quotes 0.05%. A best-quote router picks the look-alike; at swap
///         time the hook charges 10% or 30%, and the trader loses that much whenever it fits inside their slippage.
/// @dev Ported from EarthIsMine/klamp contract/test/QuoteDivergenceAttack.t.sol. Changes: uses the src/demo hook and
///      the shared Deployers, adds the 15% slippage point and the hookData case.
contract QuoteDivergenceAttackTest is Deployers {
    uint24 constant STATIC_FEE = 2500; // 0.25%
    uint24 constant QUOTE_FEE = 500; // 0.05%, what the quoter sees
    uint256 constant AMOUNT_IN = 1e18;
    int24 constant TICK_RANGE = 600; // a multiple of both tick spacings (50 and 60)

    PoolKey canonical;

    error TooLittleReceived(uint256 received, uint256 minOut);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployCurrencyPair();
        canonical = _pool(IHooks(address(0)), STATIC_FEE, 50);
    }

    function _pool(IHooks hooks, uint24 fee, int24 tickSpacing) internal returns (PoolKey memory key) {
        key = initPool(hooks, fee, tickSpacing);
        // Deep liquidity so a 1e18 trade moves the price by basis points, not percent: the fee dominates the result.
        addLiquidity(key, -TICK_RANGE, TICK_RANGE, 1e24);
    }

    /// @dev A look-alike pool with the given swap-time fee. The hook address carries only the beforeSwap flag.
    function _lookAlike(uint24 swapFee) internal returns (PoolKey memory key) {
        address hook = hookAddress(Hooks.BEFORE_SWAP_FLAG, swapFee);
        deployCodeTo(
            "QuoteAwareFeeHook.sol:QuoteAwareFeeHook",
            abi.encode(address(manager), address(quoter), QUOTE_FEE, swapFee),
            hook
        );
        key = _pool(IHooks(hook), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60);
    }

    function _quote(PoolKey memory key) internal returns (uint256) {
        return quoteExactIn(key, true, AMOUNT_IN, "");
    }

    /// @notice Router behaviour: swap exact in, then revert unless the output reaches minOut (like amountOutMinimum).
    function swapWithMinOut(PoolKey memory key, uint256 minOut, bytes memory hookData)
        external
        returns (uint256 received)
    {
        BalanceDelta delta = swapExactIn(key, true, AMOUNT_IN, hookData);
        received = uint256(uint128(delta.amount1()));
        if (received < minOut) revert TooLittleReceived(received, minOut);
    }

    /// @return executed whether the swap cleared the trader's minimum; received is 0 when it reverted.
    function _swapAtSlippage(PoolKey memory key, uint256 quoted, uint256 slippageBps, bytes memory hookData)
        internal
        returns (bool executed, uint256 received)
    {
        uint256 snapshot = vm.snapshotState();
        try this.swapWithMinOut(key, quoted * (10_000 - slippageBps) / 10_000, hookData) returns (uint256 out) {
            (executed, received) = (true, out);
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), TooLittleReceived.selector, "only the minimum-output check may revert");
        }
        vm.revertToState(snapshot);
    }

    function testLookAlikeWinsTheQuote() public {
        PoolKey memory lookAlike = _lookAlike(100_000);
        assertGt(_quote(lookAlike), _quote(canonical), "a best-quote router picks the look-alike");
    }

    function testStaticPoolPaysWhatItQuotes() public {
        uint256 quoted = _quote(canonical);
        (bool executed, uint256 received) = _swapAtSlippage(canonical, quoted, 50, "");
        assertTrue(executed);
        assertEq(received, quoted, "fee fixed in the PoolKey: quoted fee = paid fee");
    }

    /// @notice 10% at swap time: reverts at 0.5%, 1% and 5% slippage, executes from 10% up and loses ~10%.
    function testTenPercentAtSwapTime() public {
        _assertOutcomes(100_000, [false, false, false, true, true, true, true]);
    }

    /// @notice 30% at swap time: only a 30% tolerance lets it through, and then the trader loses ~30%.
    function testThirtyPercentAtSwapTime() public {
        _assertOutcomes(300_000, [false, false, false, false, false, false, true]);
    }

    /// @notice A swapper's maxFee in hookData is only a FeeCommitHook rule. This hook ignores it, so the swap still
    ///         goes through at 10%: the SDK has to keep such pools out of the route.
    function testSwapperMaxFeeDoesNotBindForeignHook() public {
        PoolKey memory lookAlike = _lookAlike(100_000);
        uint256 quoted = _quote(lookAlike);
        (bool executed, uint256 received) = _swapAtSlippage(lookAlike, quoted, 1_500, abi.encode(QUOTE_FEE));
        assertTrue(executed, "hookData limit of 0.05% is ignored");
        assertApproxEqAbs((quoted - received) * 10_000 / quoted, (100_000 - QUOTE_FEE) / 100, 1);
    }

    function _assertOutcomes(uint24 swapFee, bool[7] memory expected) internal {
        uint256[7] memory slippages = [uint256(50), 100, 500, 1_000, 1_500, 2_000, 3_000];
        PoolKey memory lookAlike = _lookAlike(swapFee);
        uint256 quoted = _quote(lookAlike);
        assertGt(quoted, _quote(canonical), "the look-alike still wins the quote");
        console2.log(string.concat("quoted fee 0.05%, swap-time fee ", _pct(uint256(swapFee) / 100)));
        for (uint256 i; i < slippages.length; ++i) {
            (bool executed, uint256 received) = _swapAtSlippage(lookAlike, quoted, slippages[i], "");
            assertEq(executed, expected[i], "outcome at this slippage");
            if (executed) {
                uint256 lossBps = (quoted - received) * 10_000 / quoted;
                // The loss is the fee gap (swap fee minus quote fee), within one basis point, and never above the tolerance.
                assertApproxEqAbs(lossBps, (uint256(swapFee) - QUOTE_FEE) / 100, 1, "loss = swap-time fee - quoted fee");
                assertLe(lossBps, slippages[i]);
                console2.log(
                    string.concat("  slippage ", _pct(slippages[i]), ": executes, trader loses ", _pct(lossBps))
                );
            } else {
                console2.log(string.concat("  slippage ", _pct(slippages[i]), ": reverts"));
            }
        }
    }

    function _pct(uint256 bps) internal pure returns (string memory) {
        return string.concat(vm.toString(bps / 100), ".", bps % 100 < 10 ? "0" : "", vm.toString(bps % 100), "%");
    }
}
