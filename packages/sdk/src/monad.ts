import type { Address } from 'viem';
import type { UniversalRouterTarget } from './universalRouter.js';

/**
 * The official Uniswap v4 deployment on Monad mainnet (chain 143), from
 * https://developers.uniswap.org/docs/protocols/v4/deployments. Code checked on chain; the Universal Router layouts
 * were checked by sending both layouts to each router on a mainnet fork.
 */
export const MONAD_MAINNET_V4 = {
  poolManager: '0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e' as Address,
  quoter: '0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891' as Address,
  stateView: '0x77395F3b2E73aE90843717371294fa97cC419D64' as Address,
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address,
};

/** Universal Routers on Monad mainnet and the V4Router param layout each one decodes. */
export const MONAD_MAINNET_UNIVERSAL_ROUTERS = {
  /** 2.1.2: the latest. */
  latest: { address: '0xa6CE4F10d83dBdDAc17E68e1837ca9cE6a1b596e', layout: 'min-hop-price' },
  'v2.1.1': { address: '0xFdf682F51FE81Aa4898F0AE2163d8A55c127fbC7', layout: 'min-hop-price' },
  /** Listed first in Uniswap's table; decodes the five-field layout. */
  legacy: { address: '0x0D97Dc33264bfC1c226207428A79b26757fb9dc3', layout: 'legacy' },
} as const satisfies Record<string, UniversalRouterTarget>;
