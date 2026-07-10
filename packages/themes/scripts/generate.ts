/**
 * Regenerates src/generated/themes.css from src/tokens.ts.
 * Run via `pnpm --filter @pi-desktop/themes generate` (Node >= 24 runs
 * TypeScript directly via type stripping — no build step).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitThemesCss } from '../src/emit.ts';

const outPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/generated/themes.css',
);
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, emitThemesCss());
console.log(`wrote ${outPath}`);
