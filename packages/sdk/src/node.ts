// Node-only helpers (filesystem). Browser code imports deployments JSON at build time and calls parseDeployment.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DeploymentError, parseDeployment, type Deployment } from './config.js';

/** contracts/deployments in this repository. */
export const DEFAULT_DEPLOYMENTS_DIR = fileURLToPath(new URL('../../../contracts/deployments/', import.meta.url));

export async function loadDeployment(chainId: number, dir = DEFAULT_DEPLOYMENTS_DIR): Promise<Deployment> {
  const path = `${dir.replace(/\/$/, '')}/${chainId}.json`;
  if (!existsSync(path)) throw new DeploymentError(`no deployments file for chain ${chainId} (${path})`);
  return parseDeployment(JSON.parse(await readFile(path, 'utf8')), chainId);
}
