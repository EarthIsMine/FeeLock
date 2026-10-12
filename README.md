# FeeLock

> The fee you see in the quote is the fee you pay at execution.

FeeLock is a Uniswap v4 fee-commitment guard for Monad. Pools created through
`FeeCommitHook` lock a maximum LP fee at initialization, and swappers can pass
their own `maxFee` in `hookData` so `beforeSwap` reverts if the applied fee is
higher. The `@feelock/sdk` guard checks candidate pools before signing and
routes away from pools whose quoted fee differs from what execution would charge.

Monad Metropolis submission. Full specification: [docs/SPEC.md](docs/SPEC.md).

## Problem

<!-- TODO(#24): quote-divergence attack (0.05% quoted, 10% executed), demo numbers -->

## How it works

<!-- TODO(#24): CanonicalPoolRegistry, FeeCommitHook, SDK verdicts -->

| Verdict | Meaning | Recommended action |
|---|---|---|
| `SAFE` | Static pool, or trusted FeeCommitHook pool with `maxFee` within the user's limit | Proceed |
| `UNVERIFIED` | Dynamic-fee hook pool without a fee commitment | Requote over SAFE pools, warn if none |
| `FEE_MISMATCH` | Quote and simulated execution diverge, or quoted fee exceeds commitment | Block |
| `LOOKUP_FAILED` | Any registry, commitment, quote or simulation lookup failed | Hold and retry |

## Why Monad

<!-- TODO(#24): async execution, gas-limit charging -->

## Repository layout

```text
contracts/      Foundry: registry, FeeCommitHook, demo contracts, scripts
packages/sdk/   @feelock/sdk (TypeScript, viem)
apps/web/       Vite + React demo app
apps/worker/    Optional pool indexer
docs/           SPEC.md, DEMO.md
```

## Getting started

Requirements: Foundry v1.8.0+, Node 22+, pnpm.

```sh
git submodule update --init --recursive
cp .env.example .env

cd contracts && forge build && forge test
pnpm install && pnpm -F @feelock/sdk test
```

## Deployments

<!-- TODO(#16): Monad testnet (10143) addresses -->

| Contract | Monad testnet (10143) |
|---|---|
| PoolManager | — |
| V4Quoter | — |
| DemoSwapRouter | — |
| CanonicalPoolRegistry | — |
| FeeCommitHook | — |

## Credits

The idea comes from [Klamp](https://github.com/EarthIsMine/klamp) (ETHGlobal
Tokyo 2026). FeeLock is a fresh codebase; files ported from Klamp record their
source in the file header and commit message.

## License

MIT for FeeLock code. Uniswap v4 dependencies are BUSL-1.1 until their change
date; FeeLock does not deploy its own copy of v4 to Monad mainnet and uses only
the official deployment there. See [LICENSE](LICENSE).
