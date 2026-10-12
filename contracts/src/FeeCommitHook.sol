// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IFeeCommitHook} from "./interfaces/IFeeCommitHook.sol";

/// @title FeeCommitHook
/// @notice Each pool's LP fee cap (maxFee) is fixed when the pool is created. The current fee moves only inside the
///         cap, and every swap is charged exactly the current fee, so the fee a quote sees is the fee a swap pays.
/// @dev Implements only the two callbacks its address enables (BEFORE_INITIALIZE | BEFORE_SWAP); PoolManager never
///      calls the others. Not built on BaseHook, which v4-periphery no longer ships.
contract FeeCommitHook is IFeeCommitHook {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    IPoolManager public immutable poolManager;

    mapping(PoolId => Commitment) public commitments;

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
    }

    /// @inheritdoc IFeeCommitHook
    function initializePool(
        PoolKey calldata key,
        uint160 sqrtPriceX96,
        uint24 maxFee,
        uint24 initialFee,
        address feeManager
    ) external returns (int24 tick) {
        if (address(key.hooks) != address(this)) revert NotThisHook();
        if (key.fee != LPFeeLibrary.DYNAMIC_FEE_FLAG) revert NotDynamicFeePool();
        maxFee.validate();
        if (initialFee > maxFee) revert FeeAboveCommitment();

        PoolId id = key.toId();
        // A second call for the same key reverts in PoolManager.initialize (PoolAlreadyInitialized), undoing this write.
        commitments[id] = Commitment(maxFee, initialFee, feeManager, true);
        emit FeeCommitted(id, maxFee, initialFee, feeManager);

        tick = poolManager.initialize(key, sqrtPriceX96);
        // Mirror the fee into slot0 so StateView readers see it. Swaps use the beforeSwap override regardless.
        poolManager.updateDynamicLPFee(key, initialFee);
    }

    /// @inheritdoc IFeeCommitHook
    function setFee(PoolKey calldata key, uint24 newFee) external {
        PoolId id = key.toId();
        Commitment storage c = commitments[id];
        if (!c.exists) revert UnknownPool();
        if (msg.sender != c.feeManager) revert NotFeeManager();
        if (newFee > c.maxFee) revert FeeAboveCommitment();

        emit FeeUpdated(id, c.currentFee, newFee);
        c.currentFee = newFee;
        poolManager.updateDynamicLPFee(key, newFee);
    }

    /// @inheritdoc IFeeCommitHook
    function FEELOCK_HOOK_VERSION() external pure returns (uint16) {
        return 1;
    }

    /// @inheritdoc IFeeCommitHook
    function commitmentOf(PoolId id) external view returns (Commitment memory) {
        return commitments[id];
    }

    /// @notice Rejects every initialization that does not come through initializePool.
    /// @dev PoolManager skips a hook's own callbacks when the hook is the caller (Hooks.noSelfCall), so this runs only
    ///      for third-party initializations and always reverts. The sender check states the intent.
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != address(this)) revert InitializeOnlyThroughHook();
        return IHooks.beforeInitialize.selector;
    }

    /// @notice Charges currentFee. If hookData carries the swapper's limit, `abi.encode(uint24 userMaxFee)`, the swap
    ///         reverts when currentFee is above it. Shorter hookData means no swapper limit. V4Quoter forwards the
    ///         same hookData, so a quote and the swap it backs follow the same rule.
    /// @dev A limit word with bits set above 24 fails abi.decode and reverts.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata hookData)
        external
        view
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        Commitment memory c = commitments[key.toId()];
        if (!c.exists) revert UnknownPool();
        uint24 fee = c.currentFee;
        // setFee already keeps currentFee <= maxFee; checked again so no code path can charge above the cap.
        if (fee > c.maxFee) revert FeeAboveCommitment();
        if (hookData.length >= 32) {
            uint24 userMax = abi.decode(hookData, (uint24));
            if (fee > userMax) revert FeeAboveUserLimit(fee, userMax);
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }
}
