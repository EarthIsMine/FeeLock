// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "./utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {DemoSwapRouter} from "../src/demo/DemoSwapRouter.sol";

contract DemoSwapRouterTest is Deployers {
    using PoolIdLibrary for PoolKey;

    DemoSwapRouter router;
    PoolKey key;
    MockERC20 token;
    address trader = makeAddr("trader");

    event SwapExecuted(
        address indexed sender, PoolId indexed poolId, bool zeroForOne, uint256 amountIn, uint256 amountOut
    );

    function setUp() public {
        deployFreshManagerAndRouters();
        deployNativePair();
        token = MockERC20(Currency.unwrap(currency1));
        router = new DemoSwapRouter(manager);
        key = initPool(IHooks(address(0)), 3000, 60);
        addLiquidity(key, -600, 600, 1e24);

        vm.deal(trader, 100 ether);
        token.mint(trader, 100 ether);
        vm.prank(trader);
        token.approve(address(router), type(uint256).max);
    }

    function testNativeIn() public {
        uint256 quoted = quoteExactIn(key, true, 1 ether, "");
        vm.expectEmit(address(router));
        emit SwapExecuted(trader, key.toId(), true, 1 ether, quoted);
        vm.prank(trader);
        uint256 out = router.swapExactInputSingle{value: 1 ether}(key, true, 1 ether, uint128(quoted), "");

        assertEq(out, quoted);
        assertEq(trader.balance, 99 ether);
        assertEq(token.balanceOf(trader), 100 ether + quoted);
        assertEq(address(router).balance, 0, "router keeps nothing");
        assertEq(token.balanceOf(address(router)), 0);
    }

    function testTokenInNativeOut() public {
        uint256 quoted = quoteExactIn(key, false, 1 ether, "");
        vm.prank(trader);
        uint256 out = router.swapExactInputSingle(key, false, 1 ether, uint128(quoted), "");

        assertEq(out, quoted);
        assertEq(token.balanceOf(trader), 99 ether);
        assertEq(trader.balance, 100 ether + quoted);
    }

    function testMinAmountOut() public {
        uint256 quoted = quoteExactIn(key, true, 1 ether, "");
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(DemoSwapRouter.TooLittleReceived.selector, quoted, quoted + 1));
        router.swapExactInputSingle{value: 1 ether}(key, true, 1 ether, uint128(quoted + 1), "");
    }

    function testMsgValueMustMatchNativeInput() public {
        vm.startPrank(trader);
        vm.expectRevert(DemoSwapRouter.InvalidMsgValue.selector);
        router.swapExactInputSingle{value: 1 ether - 1}(key, true, 1 ether, 0, "");
        vm.expectRevert(DemoSwapRouter.InvalidMsgValue.selector);
        router.swapExactInputSingle{value: 1}(key, false, 1 ether, 0, "");
        vm.stopPrank();
    }

    /// @notice The price runs out of range before the whole input is used: the unused MON comes back.
    function testPartialFillRefundsNative() public {
        PoolKey memory thin = initPool(IHooks(address(0)), 500, 10);
        addLiquidity(thin, -10, 10, 1e18);
        vm.prank(trader);
        router.swapExactInputSingle{value: 50 ether}(thin, true, 50 ether, 0, "");

        uint256 spent = 100 ether - trader.balance;
        assertGt(spent, 0);
        assertLt(spent, 1 ether, "only what the range could absorb was taken");
        assertEq(address(router).balance, 0);
    }

    function testCallbackOnlyFromPoolManager() public {
        vm.expectRevert(DemoSwapRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }
}
