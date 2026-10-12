// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "@uniswap/v4-core/src/libraries/FixedPoint96.sol";
import {CanonicalPoolRegistry} from "../CanonicalPoolRegistry.sol";
import {FeeCommitHook} from "../FeeCommitHook.sol";
import {DemoToken} from "./DemoToken.sol";

/// @notice Demo launchpad. In one transaction it
///         1) deploys the token with CREATE2  2) opens a fee-committed MON/token pool through FeeCommitHook
///         (cap 1%, starting fee 0.3%, the caller as fee manager)  3) adds the full supply as single-sided token
///         liquidity, locked forever  4) declares that pool as the token's canonical pool.
///         The launchpad itself executes CREATE2, so it is the issuer for CanonicalPoolRegistry.
/// @dev Ported from EarthIsMine/klamp contract/src/demo/DemoLaunchpad.sol. Changes: FeeCommitHook.initializePool
///      instead of PoolManager.initialize with a static fee, and CanonicalPoolRegistry.declareByCreate2 instead of the
///      ENS registrar. Per the registry's assumption there is no arbitrary external call feature, and no liquidity
///      withdrawal function either.
contract DemoLaunchpad is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;
    CanonicalPoolRegistry public immutable registry;
    FeeCommitHook public immutable feeCommitHook;

    uint256 public constant SUPPLY = 1e27; // 1 billion tokens
    uint24 public constant MAX_FEE = 10_000; // 1% cap, fixed forever
    uint24 public constant INITIAL_FEE = 3_000; // 0.3%
    int24 public constant TICK_SPACING = 60;
    int24 public constant TICK_UPPER = 198060; // initial price = this tick. 1 MON ≈ 400 million tokens
    int24 public constant TICK_LOWER = -198060;

    event Launched(address indexed token, address indexed creator, bytes32 indexed poolId, PoolKey key);

    error NotPoolManager();

    constructor(IPoolManager poolManager_, CanonicalPoolRegistry registry_, FeeCommitHook feeCommitHook_) {
        poolManager = poolManager_;
        registry = registry_;
        feeCommitHook = feeCommitHook_;
    }

    function initCodeHash(string memory name, string memory symbol) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(DemoToken).creationCode, abi.encode(name, symbol, SUPPLY)));
    }

    function saltOf(address creator, string memory name, string memory symbol) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, name, symbol));
    }

    function predictToken(address creator, string memory name, string memory symbol) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), saltOf(creator, name, symbol), initCodeHash(name, symbol))
        );
        return address(uint160(uint256(h)));
    }

    /// @notice The canonical pool key for a token launched here.
    function poolKeyOf(address token) public view returns (PoolKey memory) {
        return PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(feeCommitHook))
        });
    }

    function launch(string calldata name, string calldata symbol) external returns (address token) {
        bytes32 salt = saltOf(msg.sender, name, symbol);
        token = address(new DemoToken{salt: salt}(name, symbol, SUPPLY));

        PoolKey memory key = poolKeyOf(token);
        feeCommitHook.initializePool(key, TickMath.getSqrtPriceAtTick(TICK_UPPER), MAX_FEE, INITIAL_FEE, msg.sender);
        poolManager.unlock(abi.encode(key, token));

        registry.declareByCreate2(token, key, salt, initCodeHash(name, symbol));
        emit Launched(token, msg.sender, PoolId.unwrap(key.toId()), key);
    }

    /// @dev Single-sided token liquidity: current tick = TICK_UPPER, so the [TICK_LOWER, TICK_UPPER) range needs only
    ///      the token (currency1).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, address token) = abi.decode(data, (PoolKey, address));
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 liquidity = FullMath.mulDiv(SUPPLY, FixedPoint96.Q96, sqrtB - sqrtA);

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(TICK_LOWER, TICK_UPPER, int256(liquidity), bytes32(0)), ""
        );
        uint256 owed = uint256(uint128(-delta.amount1()));
        poolManager.sync(key.currency1);
        DemoToken(token).transfer(address(poolManager), owed);
        poolManager.settle();
        return "";
    }
}
