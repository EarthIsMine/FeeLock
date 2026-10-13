# FeeLock demo script

About 3 minutes. Everything runs on Monad testnet against the contracts in
[contracts/deployments/10143.json](../contracts/deployments/10143.json).

## Before recording

```sh
pnpm install
pnpm -F web dev                       # http://localhost:5173, or use https://feelock.vercel.app
pnpm -F @feelock/sdk demo --chain 10143   # sanity check: look-alike FEE_MISMATCH, canonical SAFE
```

- Wallet: MetaMask (or any EIP-6963 wallet) on Monad Testnet with ~0.1 MON.
- Amount: keep the default 0.001 MON. Larger trades move the thin demo pools and change the numbers.
- If the public RPC misbehaves, open `?snapshot`: the page shows the recorded run, labelled as such, with swapping
  disabled. The CLI is the other backup.

## Scenes

**1. The setup (20 s).** Open the page with FeeLock off. "One token, two pools. The canonical pool was declared by
the issuer and uses FeeCommitHook: its fee is 0.3% and can never exceed 1%. The look-alike uses a hook that sets its
own fee." Point at the pool list: the look-alike has the best quote.

**2. The naive swap (40 s).** FeeLock off, slippage 15%, swap 0.001 MON. "A best-quote router picks the look-alike."
After the receipt: "Quoted ~387k FLD, received ~348k. About 10% gone. The hook told the quoter 0.05% and charged the
swap 10%." Optional: set slippage to 0.5% and swap again: it reverts, and the receipt shows the gas paid for nothing.

**3. FeeLock on (40 s).** Toggle on. "Now every pool is quoted, and the real swap is simulated from my own address."
The look-alike turns `FEE_MISMATCH` (−9.94% vs quote); the canonical pool is `SAFE` (= quote). Point at the comparison
card: the best quote looks ~4k FLD better but really pays ~34k FLD less.

**4. The guarded swap (40 s).** Swap. "FeeLock checks the pool again right before I sign, pins the 0.3% fee in
hookData, and sets a tight gas limit, because Monad bills the whole limit." After the receipt: received equals the
quote; gas charged is shown.

**5. The backstop (30 s).** Terminal: `cd contracts && forge test --mc FeeLockE2E --mt testFeeRaiseAfterQuoteReverts -vvvv | grep -E "FeeAboveUserLimit|PASS"`. "Even if
the fee manager raises the fee within the cap after my quote, the hook reverts the swap: FeeAboveUserLimit(10000, 3000)."
Close on the Explainer: problem, how it works, why Monad.

**Optional 6. A fee change no simulation can see (40 s).** The state-flip pool is on testnet; run as the hook owner
(the deployer key):
`pnpm -F @feelock/sdk demo --chain 10143 --scenario flip --execute`. "This third pool quotes and simulates exactly
0.3%, zero gap, yet FeeLock still says UNVERIFIED, because nothing caps its fee. Watch: the owner raises it to 10%
and a naive swap loses ~9.7%. The same move on the FeeCommitHook pool stops at the 1% cap, and my pinned fee makes
the swap revert." Both fees are reset at the end.

## Terminal-only version

```sh
pnpm -F @feelock/sdk demo --chain 10143                    # both routes, simulated
FEELOCK_PK=0x… pnpm -F @feelock/sdk demo --chain 10143 --execute
```

The output prints the candidate quotes, the naive route's loss, the guard verdicts, and with `--execute` the two
transaction hashes and amounts received.
