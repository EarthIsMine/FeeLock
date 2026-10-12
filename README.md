# FeeLock

> The fee you see in the quote is the fee you pay.

A Uniswap v4 hook can charge a different fee on every swap, including a low one when a quoter asks and a high one
when a real trade comes in. Best-quote routing walks straight into that. FeeLock closes the gap on Monad in two
layers:

- **On chain:** `FeeCommitHook` pools fix their fee cap when they are created, and the swapper pins the fee seen in
  the quote through `hookData`. The hook reverts if execution would charge more.
- **Before signing:** the `@feelock/sdk` guard quotes every candidate pool, simulates the real swap from the user's
  own address, and returns `SAFE`, `UNVERIFIED`, `FEE_MISMATCH` or `LOOKUP_FAILED` per pool.

Built for Monad Metropolis. Live on Monad testnet (see [Deployments](#deployments)). Specification:
[docs/SPEC.md](docs/SPEC.md) · demo script: [docs/DEMO.md](docs/DEMO.md) · submission text:
[docs/SUBMISSION.md](docs/SUBMISSION.md).

## The problem

The demo pair MON/FLD has two pools:

| Pool | Hook | What the quoter sees | What a swap pays |
|---|---|---|---|
| canonical | `FeeCommitHook`, cap 1%, fee 0.3% | 0.3% | 0.3% |
| look-alike | `QuoteAwareFeeHook` (attack) | 0.05% | **10%** |

The look-alike also sits one tick spacing above the canonical price, so it wins every quote comparison. On Monad
testnet, the same 0.001 MON trade:

| Route | Quoted | Received |
|---|---|---|
| Best quote (look-alike) | 386,995.97 FLD | **348,490.94 FLD (−9.94%)** ([tx](https://testnet.monadscan.com/tx/0xdda717bcd741c4f103f7b8cc456134d53216031d17a127f8c8e59f7ee4f0643b)) |
| FeeLock (canonical) | 382,486.63 FLD | **382,486.63 FLD (= quote)** ([tx](https://testnet.monadscan.com/tx/0x9b008fc975676db69cc719fc9d1ae68f4e62f202525c8150c503dadc5925cece)) |

At 5% slippage the naive swap reverts and the trader only loses gas; at 15% it goes through and the trader loses
about 10%. Slippage settings cannot fix this: the loss is whatever the tolerance allows.

## How it works

```text
            ┌──────────────────────────── before signing (SDK) ────────────────────────────┐
 candidate  │ CanonicalPoolRegistry   FeeCommitHook        V4Quoter quote   eth_call of the  │  verdict
 pools ────▶│ declared by issuer?     trusted hook, cap?   (what a router   real swap from   │──▶ per pool
            │                                              sees)            the user's addr  │
            └───────────────────────────────────────────────────────────────────────────────┘
                                                   │ SAFE pool + hookData (pinned fee) + gas limit
                                                   ▼
            ┌──────────────────────────── at execution (hook) ─────────────────────────────┐
            │ FeeCommitHook.beforeSwap: fee = committed current fee; revert if above the     │
            │ cap or above the fee pinned in hookData                                        │
            └───────────────────────────────────────────────────────────────────────────────┘
```

- **[`CanonicalPoolRegistry`](contracts/src/CanonicalPoolRegistry.sol)**: only a token's issuer (its CREATE2 deployer
  or its `owner()`) can declare the token's canonical pool, once. No owner, no upgrades.
- **[`FeeCommitHook`](contracts/src/FeeCommitHook.sol)**: pools can only be created through `initializePool`, which
  stores `maxFee`. The fee manager moves the fee within `[0, maxFee]`. `beforeSwap` charges the current fee and
  reverts with `FeeAboveUserLimit` when `hookData` carries a lower limit. V4Quoter forwards the same `hookData`, so a
  quote and its swap follow the same rule.
- **[`@feelock/sdk`](packages/sdk/src)**: `feelockGuard` runs the registry and commitment lookups, the quote and the
  simulation at one block, and judges each pool:

| Verdict | When | Recommended action |
|---|---|---|
| `SAFE` | Static pool, or trusted FeeCommitHook pool whose cap is within the user's limit | Proceed |
| `UNVERIFIED` | Any other hook or dynamic-fee pool (a canonical one too, if nothing caps its fee) | Requote over SAFE pools; warn if none |
| `FEE_MISMATCH` | Simulated execution pays less than the quote beyond tolerance (10 bps), or a committed pool charges above its cap | Block |
| `LOOKUP_FAILED` | Any registry, commitment, quote or simulation lookup failed | Hold and retry; the user cannot override |

A route is as bad as its worst hop: `FEE_MISMATCH > LOOKUP_FAILED > UNVERIFIED > SAFE`. A failed lookup never reads
as "not registered" or "not committed".

## Why Monad

- **Fast blocks, stale quotes.** Blocks come about every 400 ms, so the state a quote saw is quickly out of date. The
  guard reads at one pinned, uncached block, and the hook enforces the cap and the pinned fee at execution instead of
  trusting the quote.
- **The gas limit is billed.** On Monad testnet the receipts of the demo swaps show `gasUsed` equal to the gas limit.
  The guard sets the limit from a fresh estimate plus 10% (deploy scripts use `--gas-estimate-multiplier 110`).
- **Public RPC limits.** Monad's public RPC caps clients at 15 requests/sec and answers with a JSON-RPC error, not an
  HTTP 429. The SDK transport spaces requests (`maxRequestsPerSecond`) so the guard does not fail closed for that
  reason.
- **Mainnet stays official.** On Monad mainnet FeeLock targets the official Uniswap v4 deployment; the fork test runs
  against it (`FOUNDRY_PROFILE=fork forge test`).

## Quick start

Requirements: Foundry 1.8+, Node 22+, pnpm 10.

```sh
git clone --recurse-submodules https://github.com/EarthIsMine/FeeLock && cd FeeLock
cp .env.example .env && ln -s ../.env contracts/.env   # Foundry only reads contracts/.env
pnpm install
```

**Local demo (anvil):**

```sh
anvil                           # terminal 1
pnpm deploy:local               # terminal 2: deploys everything, same addresses as contracts/deployments/31337.json
pnpm -F @feelock/sdk demo       # naive vs FeeLock in the terminal
FEELOCK_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  pnpm -F @feelock/sdk demo --scenario flip --execute   # scenario 2, as anvil's default account (the hook owner)
VITE_CHAIN_ID=31337 pnpm -F web dev
```

**Monad testnet** (contracts already deployed):

```sh
pnpm -F @feelock/sdk demo --chain 10143             # simulation only
FEELOCK_PK=0x… pnpm -F @feelock/sdk demo --chain 10143 --execute
pnpm -F web dev                                      # http://localhost:5173, add ?feelock=on to start guarded
```

`?snapshot` shows the recorded testnet snapshot; the page also falls back to it, labelled, when the RPC is down.

## Tests

```sh
cd contracts && forge test                               # 74 tests: registry, hook, fuzz + invariant, both attacks, E2E, router
FOUNDRY_PROFILE=fork forge test                          # 6 tests against the official v4 deployment on Monad mainnet
pnpm -F @feelock/sdk test                                # 56 tests, on throwaway anvil chains deployed by the real scripts
```

## Repository layout

```text
contracts/      Foundry: CanonicalPoolRegistry, FeeCommitHook, demo contracts, deploy scripts, deployments/
packages/sdk/   @feelock/sdk: lookups, quote + simulation, judge, feelockGuard, CLI demo (cli/demo.ts)
apps/web/       Vite + React app: pool list, guard toggle, swap, verdicts, receipts, snapshot fallback
scripts/        sync-abi.ts (forge out → SDK ABIs), deploy-local.sh
docs/           SPEC.md, DEMO.md, SUBMISSION.md
```

## Design notes and limits

- `hookData` pins the **fee seen in the quote**, not only the user's limit: a fee manager raising the fee within the
  cap after the quote makes the swap revert instead of costing more.
- Execution-time enforcement covers FeeCommitHook pools only. Any other hook can ignore `hookData`; the guard keeps
  such pools out of the route (`UNVERIFIED`, or `FEE_MISMATCH` when the simulation shows the gap).
- The simulation cannot see a hook that branches on block values, or one whose state changes between simulation
  and execution. For FeeCommitHook pools the cap and the pinned fee still hold; for other pools this is why they are
  never `SAFE`. Scenario 2 shows it: [`StateFlipFeeHook`](contracts/src/demo/StateFlipFeeHook.sol) quotes and simulates
  the same 0.3% (0 bps apart, still `UNVERIFIED`), then its owner raises the fee to 10% and a naive swap at 15%
  slippage loses ~9.7%; the same move on the FeeCommitHook pool stops at the 1% cap and the swap carrying the pinned
  fee reverts with `FeeAboveUserLimit(10000, 3000)` ([test](contracts/test/StateFlipAttack.t.sol),
  `pnpm -F @feelock/sdk demo --scenario flip --execute`).
- `declareByOwner` trusts the token's current `owner()`; whoever owns it first and declares fixes the pool for good.
- The guard handles single-hop routes (DemoSwapRouter); the judge already combines multi-hop verdicts.
- v4 skips a hook's own callbacks when the hook calls PoolManager (`Hooks.noSelfCall`), so
  `FeeCommitHook.beforeInitialize` only ever runs for third-party initializations, and always reverts.

## Deployments

Monad testnet (10143), deployed from block 70435253. Full record: [contracts/deployments/10143.json](contracts/deployments/10143.json).

| Contract | Address | Deploy tx |
|---|---|---|
| PoolManager (v4-core, testnet copy) | [`0x8a464ab1f9fe9b63ac9600b8ad3e98d69b033db8`](https://testnet.monadscan.com/address/0x8a464ab1f9fe9b63ac9600b8ad3e98d69b033db8) | [`0xe1275d30…`](https://testnet.monadscan.com/tx/0xe1275d30e1d4e916760b6b95a0d9fd760919be15d86ab0c0f5feab0646afef9b) |
| V4Quoter (v4-periphery) | [`0x31909f3de05310bc39137e945cde05d8db3481ef`](https://testnet.monadscan.com/address/0x31909f3de05310bc39137e945cde05d8db3481ef) | [`0xb7bcfb4b…`](https://testnet.monadscan.com/tx/0xb7bcfb4bc42654c128817dbb1f44b8f66d7057770953dece3c180ea4eb5a6bbe) |
| StateView (v4-periphery) | [`0xd088d8ec06fe20a514535334fb0fcdaaf3cd4093`](https://testnet.monadscan.com/address/0xd088d8ec06fe20a514535334fb0fcdaaf3cd4093) | [`0x8159a928…`](https://testnet.monadscan.com/tx/0x8159a9284a99b5869229ee9604a97ba898deddb1efacb9e7a296860c83f76cd1) |
| DemoSwapRouter | [`0x0defcb2536555a077cca551017f410d3bdaf2fcb`](https://testnet.monadscan.com/address/0x0defcb2536555a077cca551017f410d3bdaf2fcb) | [`0xe88885f6…`](https://testnet.monadscan.com/tx/0xe88885f670662a12e986d8686106d2d4f8ed36163dfd9ebc2c4528e6728f4c9e) |
| CanonicalPoolRegistry | [`0xa97527da9e8b787e8793ac0a5e19fcb1a7d27586`](https://testnet.monadscan.com/address/0xa97527da9e8b787e8793ac0a5e19fcb1a7d27586) | [`0xc0ba1386…`](https://testnet.monadscan.com/tx/0xc0ba1386ea3f583ad29bf5e4a0a4b6034d77ce9ed8d3c7d83cb5e54edc0a71b0) |
| FeeCommitHook | [`0x3729e78c687307975b5eef4abc26905d50902080`](https://testnet.monadscan.com/address/0x3729e78c687307975b5eef4abc26905d50902080) | [`0x6c0bc07c…`](https://testnet.monadscan.com/tx/0x6c0bc07c7f0b5d8fb45d5fb4c4bf028d3653cd5d4e02652b8f3bf897994e2eb9) |
| DemoLaunchpad | [`0x7952f6ca5e2491ee23b0e443a5a3a8c60b27bdbf`](https://testnet.monadscan.com/address/0x7952f6ca5e2491ee23b0e443a5a3a8c60b27bdbf) | [`0x187a38d0…`](https://testnet.monadscan.com/tx/0x187a38d0d74c02777b061757fe2c71164f04910358cbe8efc3d232fae9d0758a) |
| PoolSeeder | [`0x1626180ddee783d675035b924bda07705c5f89b5`](https://testnet.monadscan.com/address/0x1626180ddee783d675035b924bda07705c5f89b5) | [`0x6a8e55ab…`](https://testnet.monadscan.com/tx/0x6a8e55ab1112b6d937a57315dd031795fe7df012fcbb97c86f818665b4025d2d) |
| QuoteAwareFeeHook (attack demo) | [`0x4620ba7142c9e88d3ac905a6bc1f85c440c54080`](https://testnet.monadscan.com/address/0x4620ba7142c9e88d3ac905a6bc1f85c440c54080) | [`0x17cedea2…`](https://testnet.monadscan.com/tx/0x17cedea27a052c9dbe129d205a733c98e088e9f0d8de3d891eaaacc808f6bd17) |

Demo token FLD: [`0x1556af603750fd504Bd044bDcd61439D1eBD71dF`](https://testnet.monadscan.com/address/0x1556af603750fd504Bd044bDcd61439D1eBD71dF). Pools:

| Pool | poolId | Hook |
|---|---|---|
| canonical | `0xb021a587a99dc657be5c2d013e3b5b776e07ec6c6557db90ac7fd517d5601af0` | `0x3729e78c687307975B5EEf4aBc26905d50902080` |
| look-alike | `0xb50665c0235b2690219a63e190fc9b2f9a690e9a236691dcafd3819f063dfa8e` | `0x4620ba7142C9e88d3Ac905A6bC1f85C440C54080` |

### Live demo swaps (testnet)

Same trade, 0.001 MON → FLD, sent with `pnpm -F @feelock/sdk demo --chain 10143 --execute`:

| Route | Pool | Quoted | Received | Tx |
|---|---|---|---|---|
| Naive best quote | look-alike (QuoteAwareFeeHook) | 386,995.97 FLD | 348,490.94 FLD (−9.94%) | [`0xdda717bc…`](https://testnet.monadscan.com/tx/0xdda717bcd741c4f103f7b8cc456134d53216031d17a127f8c8e59f7ee4f0643b) |
| FeeLock guard | canonical (FeeCommitHook, hookData pins 0.30%) | 382,486.63 FLD | 382,486.63 FLD (= quote) | [`0x9b008fc9…`](https://testnet.monadscan.com/tx/0x9b008fc975676db69cc719fc9d1ae68f4e62f202525c8150c503dadc5925cece) |

Monad mainnet uses only the official Uniswap v4 deployment (PoolManager `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e`); FeeLock does not deploy its own v4 copy there.

## Credits

The idea comes from [Klamp](https://github.com/EarthIsMine/klamp) (ETHGlobal
Tokyo 2026). FeeLock is a fresh codebase; files ported from Klamp record their
source in the file header and commit message.

## License

MIT for FeeLock code. Uniswap v4 dependencies are BUSL-1.1 until their change
date; FeeLock does not deploy its own copy of v4 to Monad mainnet and uses only
the official deployment there. See [LICENSE](LICENSE).
