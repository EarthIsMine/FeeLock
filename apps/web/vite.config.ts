import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// One .env at the repo root for everything. Vite only exposes VITE_* variables to the page, so FEELOCK_PK and the
// *_FALLBACK provider URLs there never reach the bundle.
export default defineConfig({
  plugins: [react()],
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  // viem plus the contract ABIs make one ~580 kB chunk (170 kB gzipped); fine for a single-screen demo.
  build: { chunkSizeWarningLimit: 700 },
});
