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

Monad mainnet uses only the official Uniswap v4 deployment (PoolManager `0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e`); FeeLock does not deploy its own v4 copy there.

## Credits

The idea comes from [Klamp](https://github.com/EarthIsMine/klamp) (ETHGlobal
Tokyo 2026). FeeLock is a fresh codebase; files ported from Klamp record their
source in the file header and commit message.

## License

MIT for FeeLock code. Uniswap v4 dependencies are BUSL-1.1 until their change
date; FeeLock does not deploy its own copy of v4 to Monad mainnet and uses only
the official deployment there. See [LICENSE](LICENSE).
