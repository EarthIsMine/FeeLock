// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "./utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Owned} from "solmate/src/auth/Owned.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CanonicalPoolRegistry} from "../src/CanonicalPoolRegistry.sol";

contract OwnedToken is MockERC20, Owned {
    constructor(address owner_) MockERC20("Owned", "OWN", 18) Owned(owner_) {}
}

/// @dev owner() returns a word with bits above 160 set: not an address.
contract DirtyOwnerToken is MockERC20 {
    address immutable target;

    constructor(address target_) MockERC20("Dirty", "DRT", 18) {
        target = target_;
    }

    function owner() external view returns (uint256) {
        return uint256(uint160(target)) | (1 << 200);
    }
}

/// @dev Ported test cases from EarthIsMine/klamp contract/test/CanonicalPoolRegistrar.t.sol and PoolValidation.t.sol.
contract CanonicalPoolRegistryTest is Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for PoolManager;

    bytes32 constant SALT = keccak256("feelock");

    CanonicalPoolRegistry registry;
    address issuerOwner = makeAddr("issuerOwner");
    address attacker = makeAddr("attacker");

    event PoolDeclared(address indexed token, bytes32 indexed poolId, address indexed issuer, PoolKey key);

    function setUp() public {
        deployFreshManagerAndRouters();
        registry = new CanonicalPoolRegistry(manager);
    }

    // ---------- helpers ----------

    function _initCodeHash() internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(type(MockERC20).creationCode, abi.encode("Launch", "LCH", uint8(18))));
    }

    /// @dev This test contract is the CREATE2 issuer, like a launchpad.
    function _create2Token() internal returns (address) {
        return address(new MockERC20{salt: SALT}("Launch", "LCH", 18));
    }

    function _monKey(address token, uint24 fee, int24 tickSpacing) internal pure returns (PoolKey memory) {
        return PoolKey(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(token), fee, tickSpacing, IHooks(address(0)));
    }

    function _monPool(address token, uint24 fee, int24 tickSpacing) internal returns (PoolKey memory key) {
        key = _monKey(token, fee, tickSpacing);
        manager.initialize(key, SQRT_PRICE_1_1);
    }

    // ---------- path A: CREATE2 ----------

    function testCreate2Declares() public {
        address token = _create2Token();
        PoolKey memory key = _monPool(token, 3000, 60);
        bytes32 poolId = PoolId.unwrap(key.toId());

        vm.expectEmit(address(registry));
        emit PoolDeclared(token, poolId, address(this), key);
        registry.declareByCreate2(token, key, SALT, _initCodeHash());

        (bool declared, CanonicalPoolRegistry.CanonicalPool memory pool) = registry.getCanonicalPool(token);
        assertTrue(declared);
        assertEq(pool.poolId, poolId);
        assertEq(PoolId.unwrap(pool.key.toId()), poolId, "stored key hashes to the stored poolId");
        assertEq(pool.issuer, address(this));
        assertEq(pool.declaredAt, block.timestamp);
        assertTrue(registry.isCanonical(token, poolId));
    }

    function testCreate2RejectsNonIssuer() public {
        address token = _create2Token();
        PoolKey memory key = _monPool(token, 3000, 60);
        vm.prank(attacker);
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByCreate2(token, key, SALT, _initCodeHash());
    }

    function testCreate2RejectsWrongSaltOrInitCode() public {
        address token = _create2Token();
        PoolKey memory key = _monPool(token, 3000, 60);
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByCreate2(token, key, bytes32(0), _initCodeHash());
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByCreate2(token, key, SALT, keccak256("other"));
    }

    function testRejectPredictedButUndeployedToken() public {
        address predicted = vm.computeCreate2Address(SALT, _initCodeHash(), address(this));
        vm.expectRevert(CanonicalPoolRegistry.TokenNotDeployed.selector);
        registry.declareByCreate2(predicted, _monKey(predicted, 3000, 60), SALT, _initCodeHash());
    }

    // ---------- path B: owner() ----------

    function testOwnerDeclares() public {
        address token = address(new OwnedToken(issuerOwner));
        PoolKey memory key = _monPool(token, 3000, 60);
        bytes32 poolId = PoolId.unwrap(key.toId());

        vm.expectEmit(address(registry));
        emit PoolDeclared(token, poolId, issuerOwner, key);
        vm.prank(issuerOwner);
        registry.declareByOwner(token, key);

        assertTrue(registry.isCanonical(token, poolId));
        (, CanonicalPoolRegistry.CanonicalPool memory pool) = registry.getCanonicalPool(token);
        assertEq(pool.issuer, issuerOwner);
    }

    function testOwnerPathRejectsNonOwner() public {
        address token = address(new OwnedToken(issuerOwner));
        PoolKey memory key = _monPool(token, 3000, 60);
        vm.prank(attacker);
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByOwner(token, key);
    }

    function testOwnerPathRejectsNonOwnableToken() public {
        address token = address(deployMintAndApproveToken());
        PoolKey memory key = _monPool(token, 3000, 60);
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByOwner(token, key);
    }

    function testOwnerPathRejectsDirtyOwnerWord() public {
        address token = address(new DirtyOwnerToken(issuerOwner));
        PoolKey memory key = _monPool(token, 3000, 60);
        vm.prank(issuerOwner);
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByOwner(token, key);
    }

    function testOwnerPathRejectsEoa() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(CanonicalPoolRegistry.TokenNotDeployed.selector);
        registry.declareByOwner(eoa, _monKey(eoa, 3000, 60));
    }

    /// @notice Documented weakness: after a transfer the new owner is the issuer, as long as nobody declared yet.
    function testOwnerPathFollowsOwnershipTransfer() public {
        OwnedToken token = new OwnedToken(issuerOwner);
        PoolKey memory key = _monPool(address(token), 3000, 60);
        vm.prank(issuerOwner);
        token.transferOwnership(attacker);

        vm.prank(issuerOwner);
        vm.expectRevert(CanonicalPoolRegistry.NotIssuer.selector);
        registry.declareByOwner(address(token), key);

        vm.prank(attacker);
        registry.declareByOwner(address(token), key);
        (, CanonicalPoolRegistry.CanonicalPool memory pool) = registry.getCanonicalPool(address(token));
        assertEq(pool.issuer, attacker);
    }

    // ---------- shared validation ----------

    function testRejectTokenNotInPool() public {
        address token = _create2Token();
        address other = address(deployMintAndApproveToken());
        PoolKey memory key = _monPool(other, 3000, 60);
        vm.expectRevert(CanonicalPoolRegistry.TokenNotInPool.selector);
        registry.declareByCreate2(token, key, SALT, _initCodeHash());
    }

    function testRejectUninitializedPool() public {
        address token = _create2Token();
        vm.expectRevert(CanonicalPoolRegistry.PoolNotInitialized.selector);
        registry.declareByCreate2(token, _monKey(token, 3000, 60), SALT, _initCodeHash());
    }

    function testRejectPoolInitializedOnAnotherManager() public {
        address token = _create2Token();
        PoolKey memory key = _monKey(token, 3000, 60);
        new PoolManager(address(this)).initialize(key, SQRT_PRICE_1_1);
        vm.expectRevert(CanonicalPoolRegistry.PoolNotInitialized.selector);
        registry.declareByCreate2(token, key, SALT, _initCodeHash());
    }

    /// @dev PoolManager rejects unsorted keys on initialize, so they can never pass the initialized check.
    function testRejectUnsortedCurrencies() public {
        address token = _create2Token();
        _monPool(token, 3000, 60);
        PoolKey memory flipped =
            PoolKey(Currency.wrap(token), CurrencyLibrary.ADDRESS_ZERO, 3000, 60, IHooks(address(0)));
        vm.expectRevert(CanonicalPoolRegistry.PoolNotInitialized.selector);
        registry.declareByCreate2(token, flipped, SALT, _initCodeHash());
    }

    function testInitializedWithoutLiquidityIsAllowed() public {
        address token = _create2Token();
        PoolKey memory key = _monPool(token, 3000, 60);
        registry.declareByCreate2(token, key, SALT, _initCodeHash());
        assertTrue(registry.isCanonical(token, PoolId.unwrap(key.toId())));
    }

    function testCannotRedeclare() public {
        address token = address(new OwnedToken(address(this)));
        PoolKey memory first = _monPool(token, 3000, 60);
        PoolKey memory second = _monPool(token, 500, 10);
        registry.declareByOwner(token, first);

        vm.expectRevert(CanonicalPoolRegistry.AlreadyDeclared.selector);
        registry.declareByOwner(token, second);
        vm.expectRevert(CanonicalPoolRegistry.AlreadyDeclared.selector);
        registry.declareByOwner(token, first);

        assertTrue(registry.isCanonical(token, PoolId.unwrap(first.toId())));
        assertFalse(registry.isCanonical(token, PoolId.unwrap(second.toId())));
    }

    /// @notice A token that is both CREATE2-issued and Ownable: the first path to declare wins, the other is shut.
    function testCannotRedeclareAcrossPaths() public {
        address token = address(new OwnedToken{salt: SALT}(issuerOwner));
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(OwnedToken).creationCode, abi.encode(issuerOwner)));
        PoolKey memory key = _monPool(token, 3000, 60);
        PoolKey memory other = _monPool(token, 500, 10);
        registry.declareByCreate2(token, key, SALT, initCodeHash);

        vm.prank(issuerOwner);
        vm.expectRevert(CanonicalPoolRegistry.AlreadyDeclared.selector);
        registry.declareByOwner(token, other);
        assertTrue(registry.isCanonical(token, PoolId.unwrap(key.toId())));
    }

    function testUndeclaredToken() public {
        address token = _create2Token();
        (bool declared, CanonicalPoolRegistry.CanonicalPool memory pool) = registry.getCanonicalPool(token);
        assertFalse(declared);
        assertEq(pool.poolId, bytes32(0));
        assertFalse(registry.isCanonical(token, bytes32(0)), "zero poolId is never canonical");
    }

    function testErc20PairDeclares() public {
        address token = address(new OwnedToken(address(this)));
        address other = address(deployMintAndApproveToken());
        (Currency c0, Currency c1) =
            token < other ? (Currency.wrap(token), Currency.wrap(other)) : (Currency.wrap(other), Currency.wrap(token));
        PoolKey memory key = initPool(c0, c1, IHooks(address(0)), 3000, 60, SQRT_PRICE_1_1);
        registry.declareByOwner(token, key);
        assertTrue(registry.isCanonical(token, PoolId.unwrap(key.toId())));
    }

    // ---------- storage layout ----------

    function testPoolsSlotMatchesV4Core() public view {
        assertEq(registry.POOLS_SLOT(), StateLibrary.POOLS_SLOT);
    }

    function testPoolsSlotReadsInitializedPrice(uint160 sqrtPriceX96) public {
        sqrtPriceX96 = uint160(bound(sqrtPriceX96, TickMath.MIN_SQRT_PRICE, TickMath.MAX_SQRT_PRICE - 1));
        address token = address(deployMintAndApproveToken());
        PoolKey memory key = _monKey(token, 3000, 60);
        manager.initialize(key, sqrtPriceX96);
        bytes32 id = PoolId.unwrap(key.toId());
        uint160 raw = uint160(uint256(manager.extsload(keccak256(abi.encodePacked(id, registry.POOLS_SLOT())))));
        (uint160 viaStateLibrary,,,) = manager.getSlot0(key.toId());
        assertEq(raw, sqrtPriceX96);
        assertEq(raw, viaStateLibrary);
    }
}
