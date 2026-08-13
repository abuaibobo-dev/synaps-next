import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  external: ['sql.js'],
  define: { 'process.env.NODE_ENV': '"production"' },
});

// Copy sql.js wasm alongside the bundle so the DB can load offline.
const wasmSrc = path.join(path.dirname(require.resolve('sql.js/package.json')), 'dist', 'sql-wasm.wasm');
fs.copyFileSync(wasmSrc, path.join('dist', 'sql-wasm.wasm'));
console.log('⚡ Build complete!');
