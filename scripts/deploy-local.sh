#!/usr/bin/env bash
# Deploys the full FeeLock demo (DeployCore, DeployFeeLock, DemoSetup, DemoStateFlip) to a running anvil and writes
# contracts/deployments/31337.json. On a fresh anvil the addresses match the committed file.
#
#   anvil &            # in another terminal
#   pnpm deploy:local
set -euo pipefail

RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
# anvil's public default account 0; never a real key.
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

chain_id="$(cast chain-id --rpc-url "$RPC_URL")"
if [ "$chain_id" != "31337" ]; then
  echo "refusing: $RPC_URL is chain $chain_id, not anvil (31337)" >&2
  exit 1
fi

cd "$(dirname "$0")/../contracts"
for script in DeployCore DeployFeeLock DemoSetup DemoStateFlip; do
  FEELOCK_PK="$ANVIL_KEY" forge script "script/$script.s.sol:$script" --rpc-url "$RPC_URL" --broadcast >/dev/null
  echo "$script done"
done
echo "wrote contracts/deployments/31337.json"
