// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Demo of the attack a simulation cannot see: the hook treats every caller the same, so a quote and a
///         simulation agree, but its owner can change the fee at any time with no cap. Raised between a trader's quote
///         and the block that executes their swap, the trader pays the new fee up to their slippage. It ignores hookData.
///         FeeCommitHook answers the same move with its cap and the swapper's pinned fee.
///         Permission bits: beforeSwap only. The fee is an LP fee override.
/// @dev Testnet and local demo only: never deploy to Monad mainnet.
contract StateFlipFeeHook {
    using LPFeeLibrary for uint24;

    address public immutable poolManager;
    address public immutable owner;
    uint24 public fee;

    event FeeSet(uint24 fee);

    error NotPoolManager();
    error NotOwner();

    constructor(address poolManager_, address owner_, uint24 fee_) {
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: false,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
        fee_.validate();
        poolManager = poolManager_;
        owner = owner_;
        fee = fee_;
    }

    /// @notice Any fee up to 100%, at any time. This is the whole problem.
    function setFee(uint24 newFee) external {
        if (msg.sender != owner) revert NotOwner();
        newFee.validate();
        fee = newFee;
        emit FeeSet(newFee);
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        view
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (msg.sender != poolManager) revert NotPoolManager();
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
