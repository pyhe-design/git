#!/usr/bin/env node
/* Inline every local <script src> / <link rel=stylesheet href> of index.html into one
 * self-contained file: dist/musiksparring_v3.html (works from file:// with no server). */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(join(root, 'index.html'), 'utf8');

const isLocal = (p) => !/^(https?:)?\/\//.test(p) && !p.startsWith('data:');
const escapeScript = (code) => code.replace(/<\/script/gi, '<\\/script');

let out = src;
const styles = [...src.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g)];
for (const m of styles) {
  if (!isLocal(m[1])) continue;
  const css = await readFile(join(root, m[1]), 'utf8');
  out = out.replace(m[0], () => `<style>\n${css}\n</style>`);
}
const scripts = [...src.matchAll(/<script\s+src="([^"]+)"><\/script>/g)];
for (const m of scripts) {
  if (!isLocal(m[1])) continue;
  const js = await readFile(join(root, m[1]), 'utf8');
  out = out.replace(m[0], () => `<script>/* ${m[1]} */\n${escapeScript(js)}\n</script>`);
}

await mkdir(join(root, 'dist'), { recursive: true });
const target = join(root, 'dist', 'musiksparring_v3.html');
await writeFile(target, out, 'utf8');
console.log(`built ${target} (${(Buffer.byteLength(out) / 1024).toFixed(1)} kB)`);
