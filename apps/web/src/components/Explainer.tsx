/** Problem, how FeeLock works, and why Monad (spec §5.8). */
export function Explainer() {
  return (
    <section className="explainer">
      <article className="card">
        <h2>The problem</h2>
        <p>
          A Uniswap v4 hook can set a different fee for every swap. In the attack pool here, the hook checks who is
          calling: when the quoter asks, it charges 0.05%; for real swaps it charges 10%. A router that picks the best
          quote picks this pool, and the trader loses the difference, up to whatever slippage they allowed.
        </p>
      </article>
      <article className="card">
        <h2>How FeeLock works</h2>
        <ul>
          <li>
            <strong>CanonicalPoolRegistry</strong>: only the token's issuer can declare its canonical pool, once.
          </li>
          <li>
            <strong>FeeCommitHook</strong>: a pool's fee cap is fixed when the pool is created. The swapper's hookData pins
            the fee seen in the quote, and the hook reverts if the fee is higher.
          </li>
          <li>
            <strong>SDK guard</strong>: before signing, every pool is quoted and the real swap is simulated from your
            address. A gap between the two blocks the pool; a lookup it cannot finish holds the swap.
          </li>
          <li>
            A matching simulation is not enough on its own: the state-flip pool quotes and simulates the same 0.3%, but
            its owner can raise the fee before your swap executes. Without a trusted cap it stays UNVERIFIED.
          </li>
        </ul>
      </article>
      <article className="card">
        <h2>Why Monad</h2>
        <ul>
          <li>
            Blocks come about every 400 ms, so the state a quote saw is quickly out of date. FeeLock does not rely on the
            quote alone: the cap and the pinned fee are enforced by the hook when the swap executes.
          </li>
          <li>
            Monad bills the gas limit, not the gas used: the receipts here show gasUsed equal to the limit. The guard sets
            the limit from a fresh estimate plus 10% instead of a wallet's wider buffer.
          </li>
        </ul>
      </article>
    </section>
  );
}
