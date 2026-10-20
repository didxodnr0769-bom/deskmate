import { build as buildRenderer } from 'vite';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await Promise.all([
  buildRenderer(),
  build({ entryPoints: ['src/main/bootstrap.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/main/bootstrap.cjs', target: 'node22', sourcemap: true }),
  build({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: 'dist/preload/index.cjs', target: 'node22', sourcemap: true }),
]);
