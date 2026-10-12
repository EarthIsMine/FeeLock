// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @notice Minimal exact-input, single-hop v4 router that forwards hookData, for chains without Universal Router
///         (Monad testnet). The swapper passes FeeCommitHook's `abi.encode(uint24 maxFee)` as hookData.
///         Native MON input: send exactly amountIn as msg.value; whatever the pool does not take is refunded.
/// @dev Holds no funds between calls. Output goes to msg.sender.
contract DemoSwapRouter is IUnlockCallback {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;

    struct CallbackData {
        address payer;
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minAmountOut;
        bytes hookData;
    }

    event SwapExecuted(
        address indexed sender, PoolId indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut
    );

    error NotPoolManager();
    error InvalidMsgValue();
    error TooLittleReceived(uint256 amountOut, uint256 minAmountOut);

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    function swapExactInputSingle(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minAmountOut,
        bytes calldata hookData
    ) external payable returns (uint256 amountOut) {
        Currency input = zeroForOne ? key.currency0 : key.currency1;
        if (msg.value != (input.isAddressZero() ? amountIn : 0)) revert InvalidMsgValue();

        uint256 paid;
        (paid, amountOut) = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(msg.sender, key, zeroForOne, amountIn, minAmountOut, hookData))),
            (uint256, uint256)
        );
        // Partial fill at the price limit: return the native input the pool did not take.
        if (input.isAddressZero() && paid < amountIn) {
            CurrencyLibrary.ADDRESS_ZERO.transfer(msg.sender, amountIn - paid);
        }
        emit SwapExecuted(msg.sender, key.toId(), zeroForOne, paid, amountOut);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory data = abi.decode(raw, (CallbackData));

        BalanceDelta delta = poolManager.swap(
            data.key,
            SwapParams({
                zeroForOne: data.zeroForOne,
                amountSpecified: -int256(uint256(data.amountIn)),
                sqrtPriceLimitX96: data.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            data.hookData
        );

        (Currency input, Currency output) =
            data.zeroForOne ? (data.key.currency0, data.key.currency1) : (data.key.currency1, data.key.currency0);
        (int128 inDelta, int128 outDelta) =
            data.zeroForOne ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
        uint256 paid = uint256(uint128(-inDelta));
        uint256 amountOut = uint256(uint128(outDelta));
        if (amountOut < data.minAmountOut) revert TooLittleReceived(amountOut, data.minAmountOut);

        if (input.isAddressZero()) {
            poolManager.settle{value: paid}();
        } else {
            poolManager.sync(input);
            SafeTransferLib.safeTransferFrom(ERC20(Currency.unwrap(input)), data.payer, address(poolManager), paid);
            poolManager.settle();
        }
        poolManager.take(output, data.payer, amountOut);
        return abi.encode(paid, amountOut);
    }
}
