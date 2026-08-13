import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  external: ['sql.js'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('⚡ Build complete!');
