import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectRoot } from './config.js';

/**
 * Bundled CJK font, shipped in the repo so PDF output works on any OS.
 * Noto Sans SC variable font (SIL Open Font License 1.1, see OFL.txt):
 * TrueType outlines that `@pdf-lib/fontkit` can subset-embed. `.ttc`
 * collections (including Noto CJK) cannot be subset by the current
 * pdf-lib/fontkit stack, so they are not candidates anywhere.
 */
export const bundledFontFileName = 'NotoSansSC.ttf';
const bundledFontRelative = path.join('assets', 'fonts', bundledFontFileName);

/**
 * System CJK fonts, tried in order as a fallback only. TrueType outlines
 * are required: the bundled font subsetter cannot rewrite CFF/OTF tables.
 */
const candidates: Array<{ regular: string; bold?: string }> = [
  { regular: 'C:/Windows/Fonts/simhei.ttf' },
  { regular: 'C:/Windows/Fonts/Deng.ttf', bold: 'C:/Windows/Fonts/Dengb.ttf' },
  { regular: 'C:/Windows/Fonts/msyh.ttc' },
];

export interface FontBytes {
  regular: Uint8Array;
  bold: Uint8Array;
}

async function readable(file: string): Promise<boolean> {
  try { await readFile(file); return true; }
  catch { return false; }
}

let cachedBundledFontPath: string | undefined | null = null;

/**
 * Locates the bundled font. Two lookups, in order:
 *
 * 1. Walk up from this module: works in dev (`src/core`), in compiled
 *    output (`dist/server/core`) and inside a packaged `app.asar`, where no
 *    `workstation.config.json` exists so `getProjectRoot()` cannot run.
 * 2. The project root from the config file (dev / CLI layouts), reusing the
 *    same `getProjectRoot()` lookup as the rest of the codebase.
 *
 * Returns `undefined` when the bundled font is absent; callers keep going
 * down the system-font fallback chain instead of crashing.
 */
export function bundledFontPath(): string | undefined {
  if (cachedBundledFontPath !== null) return cachedBundledFontPath;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(dir, bundledFontRelative);
    if (existsSync(candidate)) {
      cachedBundledFontPath = candidate;
      return cachedBundledFontPath;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const fromRoot = path.join(getProjectRoot(), bundledFontRelative);
    if (existsSync(fromRoot)) {
      cachedBundledFontPath = fromRoot;
      return cachedBundledFontPath;
    }
  } catch {
    // Packaged builds keep no config file inside the bundle; fall through.
  }
  cachedBundledFontPath = undefined;
  return undefined;
}

export async function cjkFontCandidates(): Promise<FontBytes[]> {
  const result: FontBytes[] = [];
  const bundled = bundledFontPath();
  if (bundled) {
    try {
      // One variable font covers both weights; keep a single Uint8Array
      // reference so the PDF layout reuses the embedded font for bold.
      const bytes = new Uint8Array(await readFile(bundled));
      result.push({ regular: bytes, bold: bytes });
    } catch {
      // Bundled font unreadable: keep going down the fallback chain.
    }
  }
  for (const candidate of candidates) {
    if (!(await readable(candidate.regular))) continue;
    const regular = new Uint8Array(await readFile(candidate.regular));
    let bold = regular;
    if (candidate.bold && (await readable(candidate.bold))) bold = new Uint8Array(await readFile(candidate.bold));
    result.push({ regular, bold });
  }
  return result;
}
