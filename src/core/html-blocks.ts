import { parseHTML } from 'linkedom';

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
}

export type Block =
  | { kind: 'heading'; level: number; runs: InlineRun[] }
  | { kind: 'paragraph'; runs: InlineRun[] }
  | { kind: 'list'; ordered: boolean; items: InlineRun[][] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'table'; header: boolean; rows: string[][] }
  | { kind: 'rule' };

const inlineTags = new Set(['B', 'STRONG', 'I', 'EM', 'CODE', 'A', 'SPAN', 'MARK', 'U', 'BR', 'S', 'DEL', 'SUB', 'SUP']);

function collectRuns(node: unknown, style: Omit<InlineRun, 'text'>, output: InlineRun[]): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (node) output.push({ ...style, text: node });
    return;
  }
  if (typeof node !== 'object') return;
  const element = node as { tagName?: string; childNodes?: unknown[]; textContent?: string; nodeType?: number };
  if (element.nodeType === 3) {
    const text = String(element.textContent ?? '');
    if (text) output.push({ ...style, text });
    return;
  }
  const tag = (element.tagName ?? '').toUpperCase();
  if (tag === 'BR') { output.push({ ...style, text: '\n' }); return; }
  if (tag === 'SCRIPT' || tag === 'STYLE') return;
  const next: Omit<InlineRun, 'text'> = {
    ...style,
    bold: style.bold || tag === 'B' || tag === 'STRONG',
    italic: style.italic || tag === 'I' || tag === 'EM',
    mono: style.mono || tag === 'CODE' || tag === 'KBD' || tag === 'SAMP',
  };
  const children = element.childNodes ?? [];
  if (!children.length && element.textContent) { output.push({ ...next, text: element.textContent }); return; }
  for (const child of children) collectRuns(child, next, output);
}

function runsOf(node: unknown): InlineRun[] {
  const runs: InlineRun[] = [];
  collectRuns(node, {}, runs);
  return runs.map(run => ({ ...run, text: run.text.replace(/\s+/g, ' ') })).filter(run => run.text.length > 0);
}

function rowsOfTable(table: unknown): { header: boolean; rows: string[][] } {
  const element = table as { querySelectorAll?: (selector: string) => ArrayLike<{ textContent?: string }> };
  const rowElements = element.querySelectorAll?.('tr') ?? [];
  const rows: string[][] = [];
  let header = false;
  for (const [index, row] of Array.from(rowElements).entries()) {
    const cells = Array.from((row as unknown as { querySelectorAll?: (selector: string) => ArrayLike<{ textContent?: string }> }).querySelectorAll?.('th, td') ?? []);
    const values = cells.map(cell => (cell.textContent ?? '').replace(/\s+/g, ' ').trim());
    if (!values.length) continue;
    if (index === 0 && cells.length && (cells[0] as { tagName?: string }).tagName?.toUpperCase() === 'TH') header = true;
    rows.push(values);
  }
  return { header, rows };
}

export function htmlToBlocks(html: string): Block[] {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body;
  const blocks: Block[] = [];
  const walk = (nodes: ArrayLike<unknown>): void => {
    for (const node of Array.from(nodes)) {
      const element = node as { tagName?: string; childNodes?: unknown[]; textContent?: string; nodeType?: number };
      if (element.nodeType === 3) {
        const text = (element.textContent ?? '').trim();
        if (text) blocks.push({ kind: 'paragraph', runs: [{ text }] });
        continue;
      }
      const tag = (element.tagName ?? '').toUpperCase();
      if (!tag) continue;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      if (/^H[1-6]$/.test(tag)) {
        blocks.push({ kind: 'heading', level: Number(tag.slice(1)), runs: runsOf(node) });
        continue;
      }
      if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'HEADER' || tag === 'FOOTER' || tag === 'MAIN' || tag === 'ASIDE') {
        const children = element.childNodes ?? [];
        const hasBlockChild = Array.from(children).some(child => {
          const childTag = ((child as { tagName?: string }).tagName ?? '').toUpperCase();
          return ['P', 'DIV', 'UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'SECTION', 'ARTICLE'].includes(childTag);
        });
        if (hasBlockChild) { walk(children); continue; }
        const runs = runsOf(node);
        if (runs.length) blocks.push({ kind: 'paragraph', runs });
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        const items: InlineRun[][] = [];
        const listItems = Array.from((element as unknown as { querySelectorAll?: (selector: string) => ArrayLike<unknown> }).querySelectorAll?.(':scope > li') ?? []);
        for (const item of listItems) items.push(runsOf(item));
        if (!items.length) {
          const children = element.childNodes ?? [];
          for (const child of children) {
            const childTag = ((child as { tagName?: string }).tagName ?? '').toUpperCase();
            if (childTag === 'LI') items.push(runsOf(child));
          }
        }
        if (items.length) blocks.push({ kind: 'list', ordered: tag === 'OL', items });
        continue;
      }
      if (tag === 'PRE') {
        const code = (element as unknown as { textContent?: string }).textContent ?? '';
        blocks.push({ kind: 'code', lines: code.replace(/\n$/, '').split('\n') });
        continue;
      }
      if (tag === 'BLOCKQUOTE') {
        blocks.push({ kind: 'quote', runs: runsOf(node) });
        continue;
      }
      if (tag === 'TABLE') {
        const table = rowsOfTable(node);
        if (table.rows.length) blocks.push({ kind: 'table', header: table.header, rows: table.rows });
        continue;
      }
      if (tag === 'HR') { blocks.push({ kind: 'rule' }); continue; }
      if (inlineTags.has(tag)) continue;
      walk(element.childNodes ?? []);
    }
  };
  walk(body.childNodes);
  return blocks;
}

export function blocksToPlainText(blocks: Block[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') lines.push(block.runs.map(run => run.text).join(''));
    else if (block.kind === 'paragraph') lines.push(block.runs.map(run => run.text).join(''));
    else if (block.kind === 'list') block.items.forEach((item, index) => lines.push(`${block.ordered ? `${index + 1}.` : '-'} ${item.map(run => run.text).join('')}`));
    else if (block.kind === 'code') lines.push(...block.lines);
    else if (block.kind === 'quote') lines.push(block.runs.map(run => run.text).join(''));
    else if (block.kind === 'table') block.rows.forEach(row => lines.push(row.join('\t')));
  }
  return lines.join('\n');
}
