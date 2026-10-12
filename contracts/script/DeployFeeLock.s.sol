// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {CanonicalPoolRegistry} from "../src/CanonicalPoolRegistry.sol";
import {FeeCommitHook} from "../src/FeeCommitHook.sol";
import {DeploymentIO} from "./DeploymentIO.sol";

/// @notice CanonicalPoolRegistry and FeeCommitHook against the PoolManager in deployments/<chainId>.json.
///         The hook address must carry BEFORE_INITIALIZE | BEFORE_SWAP in its low bits, so HookMiner finds a CREATE2
///         salt for forge's deterministic deployer.
contract DeployFeeLock is DeploymentIO {
    function run() external {
        Deployment memory d = _load();
        require(_hasCode(d.poolManager), "DeployFeeLock: no PoolManager in deployments file");
        IPoolManager manager = IPoolManager(d.poolManager);
        if (d.deployBlock == 0) d.deployBlock = block.number;

        vm.startBroadcast(_deployerKey());
        if (!_hasCode(d.registry)) d.registry = address(new CanonicalPoolRegistry(manager));
        if (!_hasCode(d.feeCommitHook)) {
            uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;
            (address predicted, bytes32 salt) =
                HookMiner.find(CREATE2_FACTORY, flags, type(FeeCommitHook).creationCode, abi.encode(manager));
            d.feeCommitHook = address(new FeeCommitHook{salt: salt}(manager));
            require(d.feeCommitHook == predicted, "DeployFeeLock: hook address mismatch");
        }
        vm.stopBroadcast();

        d.feeCommitHookCodeHash = d.feeCommitHook.codehash;
        _save(d);
        console2.log("CanonicalPoolRegistry", d.registry);
        console2.log("FeeCommitHook        ", d.feeCommitHook);
        console2.logBytes32(d.feeCommitHookCodeHash);
    }
}
