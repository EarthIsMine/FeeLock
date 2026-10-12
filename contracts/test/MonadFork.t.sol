// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IV4Quoter} from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";
import {IStateView} from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";
import {QuoterRevert} from "@uniswap/v4-periphery/src/libraries/QuoterRevert.sol";
import {CanonicalPoolRegistry} from "../src/CanonicalPoolRegistry.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {IFeeCommitHook} from "../src/interfaces/IFeeCommitHook.sol";
import {DemoSwapRouter} from "../src/demo/DemoSwapRouter.sol";

/// @notice FeeLock against the official Uniswap v4 deployment on Monad mainnet (143), on a fork of the latest block.
///         Run: FOUNDRY_PROFILE=fork forge test   (MONAD_MAINNET_RPC_URL, e.g. https://rpc.monad.xyz)
///         Addresses: https://developers.uniswap.org/docs/protocols/v4/deployments
contract MonadForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant POOL_MANAGER = IPoolManager(0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e);
    IV4Quoter constant QUOTER = IV4Quoter(0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891);
    IStateView constant STATE_VIEW = IStateView(0x77395F3b2E73aE90843717371294fa97cC419D64);

    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint24 constant MAX_FEE = 10_000;
    uint24 constant INITIAL_FEE = 3_000;
    bytes32 constant SALT = keccak256("feelock-fork");

    FeeCommitHook hook;
    CanonicalPoolRegistry registry;
    DemoSwapRouter router;
    MockERC20 token;
    PoolKey key;

    function setUp() public {
        require(block.chainid == 143, "MonadFork: run with FOUNDRY_PROFILE=fork and MONAD_MAINNET_RPC_URL");
        require(address(POOL_MANAGER).code.length != 0, "MonadFork: no PoolManager at the official address");

        address at =
            address(uint160(Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG) | (uint160(0xfee10c) << 100));
        deployCodeTo("FeeCommitHook.sol:FeeCommitHook", abi.encode(POOL_MANAGER), at);
        hook = FeeCommitHook(at);
        registry = new CanonicalPoolRegistry(POOL_MANAGER);
        router = new DemoSwapRouter(POOL_MANAGER);

        // CREATE2 from this contract so it is the issuer for declareByCreate2.
        token = new MockERC20{salt: SALT}("Fork", "FRK", 18);
        token.mint(address(this), 1e30);
        key = PoolKey(
            CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(token)), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(at)
        );
        vm.deal(address(this), 1_000_000 ether);
    }

    function _commitWithLiquidity() internal {
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, address(this));
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(POOL_MANAGER);
        token.approve(address(lp), type(uint256).max);
        lp.modifyLiquidity{value: 100_000 ether}(key, ModifyLiquidityParams(-600, 600, 1e22, 0), "");
    }

    function _quote(bytes memory hookData) internal returns (uint256 amountOut) {
        (amountOut,) = QUOTER.quoteExactInputSingle(IV4Quoter.QuoteExactSingleParams(key, true, 1 ether, hookData));
    }

    /// @notice CanonicalPoolRegistry.POOLS_SLOT matches the storage layout of the deployed PoolManager.
    function testPoolsSlotMatchesOfficialPoolManager() public {
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, address(this));
        bytes32 id = PoolId.unwrap(key.toId());
        uint160 raw = uint160(uint256(POOL_MANAGER.extsload(keccak256(abi.encodePacked(id, registry.POOLS_SLOT())))));
        (uint160 viaStateView,,, uint24 lpFee) = STATE_VIEW.getSlot0(key.toId());
        assertEq(raw, SQRT_PRICE_1_1);
        assertEq(raw, viaStateView);
        assertEq(lpFee, INITIAL_FEE, "slot0 mirrors the committed fee on the official PoolManager");
    }

    function testRegistryDeclaresOnOfficialPoolManager() public {
        hook.initializePool(key, SQRT_PRICE_1_1, MAX_FEE, INITIAL_FEE, address(this));
        bytes32 initCodeHash =
            keccak256(abi.encodePacked(type(MockERC20).creationCode, abi.encode("Fork", "FRK", uint8(18))));
        registry.declareByCreate2(address(token), key, SALT, initCodeHash);
        assertTrue(registry.isCanonical(address(token), PoolId.unwrap(key.toId())));
    }

    function testDirectInitializeBlockedOnOfficialPoolManager() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(IFeeCommitHook.InitializeOnlyThroughHook.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        POOL_MANAGER.initialize(key, SQRT_PRICE_1_1);
    }

    /// @notice The official V4Quoter quotes a FeeCommitHook pool, and the swap pays exactly that.
    function testOfficialQuoterQuoteEqualsExecution() public {
        _commitWithLiquidity();
        bytes memory hookData = abi.encode(MAX_FEE);
        uint256 quoted = _quote(hookData);
        uint256 out = router.swapExactInputSingle{value: 1 ether}(key, true, 1 ether, uint128(quoted), hookData);
        assertEq(out, quoted);
    }

    /// @notice The official quoter forwards hookData, so a swapper limit below the fee fails the quote too.
    function testOfficialQuoterAppliesUserLimit() public {
        _commitWithLiquidity();
        bytes memory reason = abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            address(hook),
            IHooks.beforeSwap.selector,
            abi.encodeWithSelector(IFeeCommitHook.FeeAboveUserLimit.selector, INITIAL_FEE, INITIAL_FEE - 1),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
        vm.expectRevert(abi.encodeWithSelector(QuoterRevert.UnexpectedRevertBytes.selector, reason));
        _quote(abi.encode(INITIAL_FEE - 1));
    }

    /// @notice After the fee manager moves the fee within the cap, the official quoter sees the new fee.
    function testOfficialQuoterFollowsSetFee() public {
        _commitWithLiquidity();
        uint256 before = _quote("");
        hook.setFee(key, MAX_FEE);
        uint256 afterRaise = _quote("");
        assertLt(afterRaise, before, "higher fee, lower output");
        uint256 out = router.swapExactInputSingle{value: 1 ether}(key, true, 1 ether, uint128(afterRaise), "");
        assertEq(out, afterRaise);
    }

    receive() external payable {}
}
