import { readFile } from 'node:fs/promises';

/**
 * System CJK fonts, tried in order. TrueType outlines are required: the
 * bundled font subsetter cannot rewrite CFF/OTF tables.
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

export async function cjkFontCandidates(): Promise<FontBytes[]> {
  const result: FontBytes[] = [];
  for (const candidate of candidates) {
    if (!(await readable(candidate.regular))) continue;
    const regular = new Uint8Array(await readFile(candidate.regular));
    let bold = regular;
    if (candidate.bold && (await readable(candidate.bold))) bold = new Uint8Array(await readFile(candidate.bold));
    result.push({ regular, bold });
  }
  return result;
}
