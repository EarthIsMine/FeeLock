// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";

interface IERC20Pull {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice For the demo: initializes a MON/token pool at the tickUpper price and adds the caller's tokens as single-sided
///         [tickLower, tickUpper) liquidity. Used to open the look-alike (attack) pool next to the canonical one; placing
///         tickUpper above the canonical price makes it win the quote. Liquidity stays in this contract and there is no
///         withdrawal function.
/// @dev Ported from EarthIsMine/klamp contract/src/demo/PoolSeeder.sol (imports and comments only).
contract PoolSeeder is IUnlockCallback {
    IPoolManager public immutable poolManager;

    error NotPoolManager();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function seed(PoolKey calldata key, int24 tickLower, int24 tickUpper, uint256 amount) external {
        address token = Currency.unwrap(key.currency1);
        IERC20Pull(token).transferFrom(msg.sender, address(this), amount);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(tickUpper));
        poolManager.unlock(abi.encode(key, tickLower, tickUpper, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, int24 tickLower, int24 tickUpper, uint256 amount) =
            abi.decode(data, (PoolKey, int24, int24, uint256));
        uint256 liquidity = FullMath.mulDiv(
            amount, FixedPoint96.Q96, TickMath.getSqrtPriceAtTick(tickUpper) - TickMath.getSqrtPriceAtTick(tickLower)
        );
        (BalanceDelta delta,) =
            poolManager.modifyLiquidity(key, ModifyLiquidityParams(tickLower, tickUpper, int256(liquidity), 0), "");
        poolManager.sync(key.currency1);
        IERC20Pull(Currency.unwrap(key.currency1)).transfer(address(poolManager), uint256(uint128(-delta.amount1())));
        poolManager.settle();
        return "";
    }
}
