/** Problem, how FeeLock works and why Monad, folded away until asked for. */
export function Explainer() {
  return (
    <section className="glass explainer" aria-label="How FeeLock works">
      <details>
        <summary>Why a quote can lie</summary>
        <p>
          A Uniswap v4 hook can set a different fee for every swap. The look-alike pool here checks who is calling: the
          quoter is charged 0.05%, a real swap 10%. A router that picks the best quote picks this pool, and the trader
          loses the difference, up to whatever slippage they allowed.
        </p>
      </details>
      <details>
        <summary>How FeeLock works</summary>
        <ul>
          <li><strong>CanonicalPoolRegistry</strong>: only the token's issuer can declare its canonical pool, once.</li>
          <li>
            <strong>FeeCommitHook</strong>: a pool's fee cap is fixed when the pool is created. Your transaction pins the
            fee you saw in the quote, and the hook reverts if the fee is higher.
          </li>
          <li>
            <strong>The check before you sign</strong>: every pool is quoted and the real swap is simulated from your
            address. A gap blocks the pool; a pool with no fee cap is never used; a lookup that fails holds the swap.
          </li>
          <li>
            A matching simulation is not enough on its own: the state-flip pool quotes and simulates the same 0.3%, but its
            owner can raise the fee before your swap executes.
          </li>
        </ul>
      </details>
      <details>
        <summary>Why Monad</summary>
        <ul>
          <li>
            Monad orders transactions before executing them and runs simulations on speculative state, so the quote and
            the swap can see different state. The fee is enforced by the hook when the swap runs.
          </li>
          <li>
            Monad bills the gas limit, not the gas used. FeeLock blocks bad routes before you pay for them and sets the
            limit from a fresh estimate plus 10%.
          </li>
        </ul>
      </details>
    </section>
  );
}
