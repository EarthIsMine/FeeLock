import { parseDeployment, type Deployment } from '@feelock/sdk';
import { CHAIN_ID } from './chain';

// contracts/deployments/<chainId>.json, bundled at build time and validated by the SDK.
const files = import.meta.glob<unknown>('../../../../contracts/deployments/*.json', { eager: true, import: 'default' });

export const deployments = new Map<number, Deployment>();
for (const [path, json] of Object.entries(files)) {
  const id = Number(/(\d+)\.json$/.exec(path)?.[1]);
  if (Number.isSafeInteger(id)) deployments.set(id, parseDeployment(json, id));
}

/** The deployment for the app's chain, or undefined if this chain has none. */
export const deployment: Deployment | undefined = deployments.get(CHAIN_ID);
