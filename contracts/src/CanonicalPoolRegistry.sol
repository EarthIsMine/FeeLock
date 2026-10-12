// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @title CanonicalPoolRegistry
/// @notice Only a token's issuer can declare that token's canonical pool, once. After that nobody, the deployer of this
///         contract included, can change it. No owner, no upgrade path.
/// @dev Declaration checks ported from EarthIsMine/klamp contract/src/CanonicalPoolRegistrar.sol (`_record`).
///      Klamp stored the result in ENS text/data records; FeeLock keeps it in this contract's storage and an event.
contract CanonicalPoolRegistry {
    using PoolIdLibrary for PoolKey;

    struct CanonicalPool {
        bytes32 poolId;
        PoolKey key;
        address issuer;
        uint64 declaredAt;
    }

    /// @dev v4-core StateLibrary.POOLS_SLOT. Tests check it against the v4-core submodule and Monad's PoolManager.
    bytes32 public constant POOLS_SLOT = bytes32(uint256(6));

    IPoolManager public immutable poolManager;

    mapping(address token => CanonicalPool) internal _canonical;

    event PoolDeclared(address indexed token, bytes32 indexed poolId, address indexed issuer, PoolKey key);

    error NotIssuer();
    error TokenNotDeployed();
    error TokenNotInPool();
    error AlreadyDeclared();
    error PoolNotInitialized();

    constructor(IPoolManager poolManager_) {
        poolManager = poolManager_;
    }

    /// @notice Issuer = the contract that deployed `token` with CREATE2. A launchpad calls this inside the launch
    ///         transaction. If the launchpad uses a separate token factory, that factory must call this instead.
    ///         Assumption: the issuer contract has no arbitrary external call feature (execute, multicall, ...),
    ///         otherwise anyone could declare through it.
    function declareByCreate2(address token, PoolKey calldata key, bytes32 salt, bytes32 initCodeHash) external {
        if (token.code.length == 0) revert TokenNotDeployed();
        address predicted =
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), msg.sender, salt, initCodeHash)))));
        if (predicted != token) revert NotIssuer();
        _declare(token, key);
    }

    /// @notice Issuer = the current `owner()` of an already deployed Ownable token.
    ///         Weakness: ownership is transferable, and whichever owner declares first fixes the pool for good.
    function declareByOwner(address token, PoolKey calldata key) external {
        if (token.code.length == 0) revert TokenNotDeployed();
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || ret.length < 32) revert NotIssuer();
        uint256 owner = abi.decode(ret, (uint256));
        if (owner >> 160 != 0 || address(uint160(owner)) != msg.sender) revert NotIssuer();
        _declare(token, key);
    }

    function getCanonicalPool(address token) external view returns (bool declared, CanonicalPool memory pool) {
        pool = _canonical[token];
        declared = pool.poolId != bytes32(0);
    }

    function isCanonical(address token, bytes32 poolId) external view returns (bool) {
        return poolId != bytes32(0) && _canonical[token].poolId == poolId;
    }

    function _declare(address token, PoolKey calldata key) internal {
        if (Currency.unwrap(key.currency0) != token && Currency.unwrap(key.currency1) != token) {
            revert TokenNotInPool();
        }
        if (_canonical[token].poolId != bytes32(0)) revert AlreadyDeclared();

        bytes32 poolId = PoolId.unwrap(key.toId());
        // pools[poolId].slot0 holds sqrtPriceX96 in its low 160 bits; zero means uninitialized.
        // PoolManager validates the key on initialize, so an initialized pool implies a valid key.
        bytes32 slot0 = poolManager.extsload(keccak256(abi.encodePacked(poolId, POOLS_SLOT)));
        if (uint160(uint256(slot0)) == 0) revert PoolNotInitialized();

        _canonical[token] = CanonicalPool(poolId, key, msg.sender, uint64(block.timestamp));
        emit PoolDeclared(token, poolId, msg.sender, key);
    }
}
