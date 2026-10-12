// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

/// @notice Reads and writes deployments/<chainId>.json. The chain id always comes from the RPC (block.chainid) and must
///         match the file. Every field is written on every save; address(0) means "not deployed".
/// @dev Monad charges the full gas limit, so broadcast with a tight multiplier, e.g.
///      `forge script <Script> --rpc-url monad_testnet --broadcast --gas-estimate-multiplier 110`.
///      The key comes from FEELOCK_PK only.
abstract contract DeploymentIO is Script {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant MONAD_MAINNET = 143;

    struct Deployment {
        uint256 chainId;
        uint256 deployBlock;
        address poolManager;
        address quoter;
        address stateView;
        address router;
        address registry;
        address feeCommitHook;
        bytes32 feeCommitHookCodeHash;
        // demo
        address launchpad;
        address seeder;
        address token;
        address attackHook;
        PoolKey canonical;
        PoolKey lookAlike;
    }

    function _path() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
    }

    function _deployerKey() internal view returns (uint256) {
        return vm.envUint("FEELOCK_PK");
    }

    function _load() internal view returns (Deployment memory d) {
        d.chainId = block.chainid;
        string memory path = _path();
        if (!vm.exists(path)) return d;

        string memory json = vm.readFile(path);
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "deployments file is for another chain");
        d.deployBlock = vm.parseJsonUint(json, ".deployBlock");
        d.poolManager = vm.parseJsonAddress(json, ".poolManager");
        d.quoter = vm.parseJsonAddress(json, ".quoter");
        d.stateView = vm.parseJsonAddress(json, ".stateView");
        d.router = vm.parseJsonAddress(json, ".router");
        d.registry = vm.parseJsonAddress(json, ".registry");
        d.feeCommitHook = vm.parseJsonAddress(json, ".feeCommitHook");
        d.feeCommitHookCodeHash = vm.parseJsonBytes32(json, ".feeCommitHookCodeHash");
        d.launchpad = vm.parseJsonAddress(json, ".demo.launchpad");
        d.seeder = vm.parseJsonAddress(json, ".demo.seeder");
        d.token = vm.parseJsonAddress(json, ".demo.token");
        d.attackHook = vm.parseJsonAddress(json, ".demo.attackHook");
        if (d.token != address(0)) {
            d.canonical = _readKey(json, ".demo.pools[0].key");
            d.lookAlike = _readKey(json, ".demo.pools[1].key");
        }
    }

    /// @dev Writes only when the transactions are actually sent (--broadcast or --resume). A dry run would otherwise
    ///      record addresses that were never deployed.
    function _save(Deployment memory d) internal {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) && !vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            console2.log("dry run: deployments file not written");
            return;
        }
        string memory demo = vm.serializeAddress("demo", "launchpad", d.launchpad);
        demo = vm.serializeAddress("demo", "seeder", d.seeder);
        demo = vm.serializeAddress("demo", "token", d.token);
        demo = vm.serializeAddress("demo", "attackHook", d.attackHook);
        string[] memory pools = new string[](d.token == address(0) ? 0 : 2);
        if (d.token != address(0)) {
            pools[0] = _poolJson("pool0", "canonical", d.canonical);
            pools[1] = _poolJson("pool1", "look-alike", d.lookAlike);
        }
        demo = vm.serializeString("demo", "pools", pools);

        string memory root = "root";
        vm.serializeUint(root, "chainId", d.chainId);
        vm.serializeAddress(root, "poolManager", d.poolManager);
        vm.serializeAddress(root, "quoter", d.quoter);
        vm.serializeAddress(root, "stateView", d.stateView);
        vm.serializeAddress(root, "router", d.router);
        vm.serializeAddress(root, "registry", d.registry);
        vm.serializeAddress(root, "feeCommitHook", d.feeCommitHook);
        vm.serializeBytes32(root, "feeCommitHookCodeHash", d.feeCommitHookCodeHash);
        vm.serializeString(root, "demo", demo);
        string memory json = vm.serializeUint(root, "deployBlock", d.deployBlock);
        vm.writeJson(json, _path());
    }

    function _poolJson(string memory id, string memory label, PoolKey memory key) private returns (string memory) {
        string memory k = string.concat(id, ".key");
        vm.serializeAddress(k, "currency0", Currency.unwrap(key.currency0));
        vm.serializeAddress(k, "currency1", Currency.unwrap(key.currency1));
        vm.serializeUint(k, "fee", key.fee);
        vm.serializeInt(k, "tickSpacing", key.tickSpacing);
        string memory keyJson = vm.serializeAddress(k, "hooks", address(key.hooks));

        vm.serializeString(id, "label", label);
        vm.serializeBytes32(id, "poolId", PoolId.unwrap(key.toId()));
        return vm.serializeString(id, "key", keyJson);
    }

    function _readKey(string memory json, string memory at) private pure returns (PoolKey memory key) {
        key.currency0 = Currency.wrap(vm.parseJsonAddress(json, string.concat(at, ".currency0")));
        key.currency1 = Currency.wrap(vm.parseJsonAddress(json, string.concat(at, ".currency1")));
        key.fee = uint24(vm.parseJsonUint(json, string.concat(at, ".fee")));
        key.tickSpacing = int24(vm.parseJsonInt(json, string.concat(at, ".tickSpacing")));
        key.hooks = IHooks(vm.parseJsonAddress(json, string.concat(at, ".hooks")));
    }

    function _hasCode(address a) internal view returns (bool) {
        return a != address(0) && a.code.length != 0;
    }
}
