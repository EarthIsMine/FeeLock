# FeeLock: submission text

**One-liner:** The fee you see in the quote is the fee you pay: a Uniswap v4 fee-commitment hook and a pre-sign guard
for Monad.

## Description

Uniswap v4 hooks can set a different fee on every swap. A hook can answer the quoter with a 0.05% fee and charge a
real swap 10%, so the pool wins every best-quote comparison and the trader loses whatever their slippage tolerance
allows. On Monad testnet, the same 0.001 MON trade received 9.94% less than quoted through such a pool, and exactly
its quote through FeeLock.

FeeLock fixes this in two layers:

- **On chain.** `FeeCommitHook` pools fix a fee cap when they are created; the fee manager can only move the fee
  inside it. The swapper passes the fee seen in the quote as `maxFee` in `hookData`, and `beforeSwap` reverts if the
  fee at execution is higher. `CanonicalPoolRegistry` lets only a token's issuer declare its canonical pool, once.
- **Before signing.** The `@feelock/sdk` guard reads the registry and the fee commitment, quotes each pool through
  V4Quoter, simulates the real swap from the user's address, and blocks the transaction before it is signed. The
  on-chain checks are the backstop. Verdicts:
  - `SAFE`: static pool, or committed pool whose cap is within the user's limit. Proceed.
  - `UNVERIFIED`: a hook or dynamic fee with no trusted cap. Route over SAFE pools only.
  - `FEE_MISMATCH`: the simulated swap pays less than the quote. Block.
  - `LOOKUP_FAILED`: a lookup could not be completed. Hold and retry; the user cannot override it.

## How it is built

- Solidity 0.8.26 on Uniswap v4-core / v4-periphery, Foundry tests: unit, fuzz, an invariant over random fee changes
  and swaps, the attack, end-to-end, and a fork test against the official v4 deployment on Monad mainnet.
- TypeScript SDK on viem, tested against anvil chains deployed by the real scripts; a CLI demo.
- Vite + React app with EIP-6963 wallets: the swap runs as visible steps (find pools, quote, simulate from your
  address, choose a pool), then a review sheet and a result card; a labelled snapshot fallback if the RPC is down.

## Why Monad

- About 400 ms blocks: quotes go stale quickly, so the fee is enforced at execution, not trusted from the quote.
- Monad bills the gas limit (receipts show `gasUsed` equal to the limit), so the guard sets a tight limit from a fresh
  estimate plus 10%.
- On mainnet FeeLock works with the official Uniswap v4 deployment.

## Built in the build window

FeeLock is a new codebase built on 2026-10-12 and 2026-10-13. The idea comes from our ETHGlobal Tokyo project Klamp,
which kept canonical pools in ENS records on Sepolia and could only route around bad pools. New for Monad: an
on-chain `CanonicalPoolRegistry` instead of ENS (CREATE2 issuer check ported from Klamp, token-`owner()` path new,
`NotIssuer` for anyone else, declared inside the launch transaction), `FeeCommitHook` with execution-time
enforcement, the dual-simulation guard and its four verdicts, and the Monad deployment work (gas limits, RPC limits,
official v4 on mainnet). Ported files are listed in the README.

## Prior code and AI use

Ported Klamp files record their source in the file header and commit message. Much of the code, tests and docs were
written with Claude Code (Anthropic) under the author's direction and review; those commits carry a
`Co-Authored-By: Claude` line.

## Links

- Live product (Monad testnet): https://feelock.vercel.app (no login; judge steps in README → For judges)
- Code: https://github.com/EarthIsMine/FeeLock
- Contracts on Monad testnet: see README → Deployments
- Demo swaps: [naive, −9.94%](https://testnet.monadscan.com/tx/0xdda717bcd741c4f103f7b8cc456134d53216031d17a127f8c8e59f7ee4f0643b) ·
  [FeeLock, = quote](https://testnet.monadscan.com/tx/0x9b008fc975676db69cc719fc9d1ae68f4e62f202525c8150c503dadc5925cece)
- Origin: the idea comes from [Klamp](https://github.com/EarthIsMine/klamp) (ETHGlobal Tokyo 2026); FeeLock is a new
  codebase and credits the ported files.
