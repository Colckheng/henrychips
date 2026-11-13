import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface Segment { start: number; end: number; done: boolean }
export interface SegmentTable { size: number; segments: Segment[] }

export function splitSegments(size: number, count: number): Segment[] {
  if (size <= 0 || count <= 0) return [];
  const total = Math.min(count, size);
  const base = Math.floor(size / total);
  const remainder = size % total;
  const segments: Segment[] = [];
  let start = 0;
  for (let index = 0; index < total; index++) {
    const length = base + (index < remainder ? 1 : 0);
    segments.push({ start, end: start + length - 1, done: false });
    start += length;
  }
  return segments;
}

export function serializeSegmentTable(table: SegmentTable): string {
  return JSON.stringify(table);
}

export function parseSegmentTable(text: string): SegmentTable | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const table = parsed as SegmentTable;
    if (!Number.isSafeInteger(table.size) || !Array.isArray(table.segments)) return null;
    if (!table.segments.every(segment => Number.isSafeInteger(segment.start) && Number.isSafeInteger(segment.end) && segment.end >= segment.start)) return null;
    return table;
  } catch { return null; }
}

export function completedBytes(table: SegmentTable): number {
  return table.segments.reduce((sum, segment) => sum + (segment.done ? segment.end - segment.start + 1 : 0), 0);
}

export async function readSegmentTable(file: string): Promise<SegmentTable | null> {
  try { return parseSegmentTable(await readFile(file, 'utf8')); }
  catch { return null; }
}

/**
 * The table is the only record of what has been downloaded, so a write that
 * is cut in half must not destroy it. The table is written to a temporary
 * file first and renamed afterwards, so the file on disk is always a table
 * that was written completely.
 */
export async function writeSegmentTable(file: string, table: SegmentTable): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serializeSegmentTable(table), 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => { /* the file may not exist */ });
    throw error;
  }
}
