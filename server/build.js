import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 内嵌 Termux 桥接脚本：App 通过 /api/v1/bridge/script 提供给 Termux（离线一键安装）
const bridgeSrc = path.join(__dirname, '..', 'tools', 'codex-bridge', 'server.js');
const bridgeOut = path.join(__dirname, 'src', 'bridgeScript.generated.ts');
const bridgeContent = fs.existsSync(bridgeSrc)
  ? fs.readFileSync(bridgeSrc, 'utf8')
  : '// tools/codex-bridge/server.js 缺失，请检查仓库';

fs.writeFileSync(
  bridgeOut,
  `// 自动生成：由 build.js 从 ../tools/codex-bridge/server.js 生成，请勿手动修改\nexport const BRIDGE_SCRIPT = ${JSON.stringify(bridgeContent)};\n`
);

await esbuild.build({
  entryPoints: ['./src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(__dirname, 'dist', 'index.cjs'),
  absWorkingDir: __dirname,
  define: { 'process.env.NODE_ENV': '"production"' },
});

// Copy sql.js wasm alongside the bundle so the DB can load offline.
const wasmSrc = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.copyFileSync(wasmSrc, path.join(__dirname, 'dist', 'sql-wasm.wasm'));
console.log('⚡ Build complete!');
