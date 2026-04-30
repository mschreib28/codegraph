#!/usr/bin/env node
/**
 * Copy non-TS assets into dist/ after `tsc`.
 * - SQL schema
 * - tree-sitter WASM grammars
 * - web UI public/ directory
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}

// SQL schema
fs.mkdirSync(path.join(root, 'dist/db'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'src/db/schema.sql'),
  path.join(root, 'dist/db/schema.sql')
);

// tree-sitter WASM grammars
const wasmSrc = path.join(root, 'src/extraction/wasm');
const wasmDst = path.join(root, 'dist/extraction/wasm');
fs.mkdirSync(wasmDst, { recursive: true });
for (const f of fs.readdirSync(wasmSrc)) {
  if (f.endsWith('.wasm')) {
    fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDst, f));
  }
}

// Web UI assets
const publicSrc = path.join(root, 'public');
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, path.join(root, 'dist/public'));
}
