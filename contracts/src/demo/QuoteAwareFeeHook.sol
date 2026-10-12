// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Demo of the attack FeeLock blocks, for a dynamic-fee pool: it quotes one fee and charges another.
///         `sender` in beforeSwap is whoever called PoolManager.swap, so when V4Quoter asks it returns `quoteFee` and for
///         every real swap (DemoSwapRouter, Universal Router, any router) `swapFee`. A best-quote router picks this pool
///         and the trader loses the gap, up to their slippage. It ignores hookData, so a swapper's maxFee does not bind it.
///         Permission bits: beforeSwap(7) only → lower 14 bits of the address = 0x80. No delta is returned; the fee is an
///         LP fee override, so it goes to the pool's liquidity providers.
/// @dev Ported from EarthIsMine/klamp contract/src/demo/QuoteAwareFeeHook.sol (imports and comments only).
///      Testnet and local demo only: never deploy to Monad mainnet. Fees are in pips (1,000,000 = 100%); immutable,
///      no owner.
contract QuoteAwareFeeHook is IHooks {
    uint24 internal constant OVERRIDE_FEE_FLAG = 0x400000;

    address public immutable poolManager;
    address public immutable quoter;
    uint24 public immutable quoteFee;
    uint24 public immutable swapFee;

    error NotPoolManager();
    error HookNotImplemented();

    constructor(address poolManager_, address quoter_, uint24 quoteFee_, uint24 swapFee_) {
        poolManager = poolManager_;
        quoter = quoter_;
        quoteFee = quoteFee_;
        swapFee = swapFee_;
    }

    function beforeSwap(address sender, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != poolManager) revert NotPoolManager();
        uint24 fee = sender == quoter ? quoteFee : swapFee;
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | OVERRIDE_FEE_FLAG);
    }

    // ---------- unused callbacks (never called because their permission bits are off) ----------

    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
