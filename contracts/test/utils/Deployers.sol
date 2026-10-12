// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";

/// @notice Local v4 stack for tests: a real PoolManager, v4-core's test routers and the v4-periphery V4Quoter.
///         Leaner than v4-core's own Deployers: only what FeeLock tests use, plus native (MON) currency0 support.
abstract contract Deployers is Test {
    using CurrencyLibrary for Currency;

    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    /// @dev Native value sent with liquidity and swap calls on MON pools; the routers refund what is left.
    uint256 internal constant NATIVE_BUDGET = 1_000_000 ether;

    PoolManager internal manager;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal modifyLiquidityRouter;
    V4Quoter internal quoter;

    Currency internal currency0;
    Currency internal currency1;

    /// @dev The test routers refund unused native value to the caller.
    receive() external payable {}

    function deployFreshManagerAndRouters() internal {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        modifyLiquidityRouter = new PoolModifyLiquidityTest(manager);
        quoter = new V4Quoter(manager);
        vm.label(address(manager), "PoolManager");
        vm.label(address(swapRouter), "PoolSwapTest");
        vm.label(address(modifyLiquidityRouter), "PoolModifyLiquidityTest");
        vm.label(address(quoter), "V4Quoter");
    }

    /// @notice Mints a token to this contract and approves both test routers.
    function deployMintAndApproveToken() internal returns (MockERC20 token) {
        token = new MockERC20("Test", "TST", 18);
        token.mint(address(this), type(uint128).max);
        token.approve(address(swapRouter), type(uint256).max);
        token.approve(address(modifyLiquidityRouter), type(uint256).max);
    }

    /// @notice Two ERC20s, sorted into currency0 < currency1.
    function deployCurrencyPair() internal {
        (address a, address b) = (address(deployMintAndApproveToken()), address(deployMintAndApproveToken()));
        (currency0, currency1) = a < b ? (Currency.wrap(a), Currency.wrap(b)) : (Currency.wrap(b), Currency.wrap(a));
    }

    /// @notice Native MON as currency0 (address(0) always sorts first) and one ERC20 as currency1.
    function deployNativePair() internal {
        vm.deal(address(this), NATIVE_BUDGET * 10);
        currency0 = CurrencyLibrary.ADDRESS_ZERO;
        currency1 = Currency.wrap(address(deployMintAndApproveToken()));
    }

    /// @notice An address whose low 14 bits are exactly `flags`; `seed` keeps several hooks with the same flags apart.
    ///         Use with `deployCodeTo` in tests. Scripts mine a CREATE2 salt with HookMiner instead.
    function hookAddress(uint160 flags, uint256 seed) internal pure returns (address) {
        return address((uint160(seed) << 100) | (flags & Hooks.ALL_HOOK_MASK));
    }

    function initPool(Currency c0, Currency c1, IHooks hooks, uint24 fee, int24 tickSpacing, uint160 sqrtPriceX96)
        internal
        returns (PoolKey memory key)
    {
        key = PoolKey(c0, c1, fee, tickSpacing, hooks);
        manager.initialize(key, sqrtPriceX96);
    }

    function initPool(IHooks hooks, uint24 fee, int24 tickSpacing) internal returns (PoolKey memory key) {
        key = initPool(currency0, currency1, hooks, fee, tickSpacing, SQRT_PRICE_1_1);
    }

    function addLiquidity(PoolKey memory key, int24 tickLower, int24 tickUpper, int256 liquidityDelta)
        internal
        returns (BalanceDelta delta)
    {
        delta = modifyLiquidityRouter.modifyLiquidity{value: _nativeValue(key)}(
            key, ModifyLiquidityParams(tickLower, tickUpper, liquidityDelta, 0), ""
        );
    }

    /// @notice Exact-input swap through PoolSwapTest with no price limit beyond the tick bounds.
    function swapExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn, bytes memory hookData)
        internal
        returns (BalanceDelta delta)
    {
        delta = swapRouter.swap{value: zeroForOne ? _nativeValue(key) : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            hookData
        );
    }

    function quoteExactIn(PoolKey memory key, bool zeroForOne, uint256 amountIn, bytes memory hookData)
        internal
        returns (uint256 amountOut)
    {
        (amountOut,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams(key, zeroForOne, uint128(amountIn), hookData)
        );
    }

    function _nativeValue(PoolKey memory key) private pure returns (uint256) {
        return key.currency0.isAddressZero() ? NATIVE_BUDGET : 0;
    }
}
