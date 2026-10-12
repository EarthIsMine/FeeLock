// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice A v4 hook that fixes a per-pool LP fee cap at pool creation and enforces it on every swap.
interface IFeeCommitHook {
    /// @param maxFee Fee cap in pips, fixed at pool creation.
    /// @param currentFee Fee charged on swaps, always <= maxFee.
    /// @param feeManager May move currentFee within [0, maxFee]. address(0) freezes the fee.
    struct Commitment {
        uint24 maxFee;
        uint24 currentFee;
        address feeManager;
        bool exists;
    }

    event FeeCommitted(PoolId indexed id, uint24 maxFee, uint24 initialFee, address feeManager);
    event FeeUpdated(PoolId indexed id, uint24 oldFee, uint24 newFee);

    error InitializeOnlyThroughHook();
    error NotDynamicFeePool();
    error NotThisHook();
    error FeeAboveCommitment();
    error FeeAboveUserLimit(uint24 fee, uint24 userMax);
    error NotFeeManager();
    error NotPoolManager();
    error UnknownPool();

    /// @notice Stores the commitment, then initializes the pool on the PoolManager. The only way to create a pool
    ///         with this hook.
    function initializePool(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        uint24 maxFee,
        uint24 initialFee,
        address feeManager
    ) external returns (int24 tick);

    /// @notice Only the pool's feeManager, and only within the committed cap.
    function setFee(PoolKey calldata key, uint24 newFee) external;

    function commitmentOf(PoolId id) external view returns (Commitment memory);

    /// @notice Lets off-chain clients identify a FeeLock hook and its rule set.
    function FEELOCK_HOOK_VERSION() external pure returns (uint16);
}
