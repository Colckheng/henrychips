import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import type { Block, InlineRun } from './html-blocks.js';

function runsOf(inline: InlineRun[]): TextRun[] {
  return inline.map(run => new TextRun({
    text: run.text,
    bold: run.bold,
    italics: run.italic,
    font: run.mono ? 'Courier New' : undefined,
  }));
}

function cellOf(text: string): TableCell {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text })] })] });
}

export async function renderBlocksToDocx(blocks: Block[], title?: string): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  const tables: Table[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][Math.min(block.level, 6) - 1];
      children.push(new Paragraph({ heading: level, children: runsOf(block.runs) }));
      continue;
    }
    if (block.kind === 'paragraph') {
      children.push(new Paragraph({ children: runsOf(block.runs) }));
      continue;
    }
    if (block.kind === 'list') {
      block.items.forEach((item, index) => {
        const text = item.map(run => run.text).join('');
        const runs = item.length ? runsOf(item) : [];
        children.push(new Paragraph({
          bullet: block.ordered ? undefined : { level: 0 },
          indent: block.ordered ? { left: 720 } : undefined,
          children: block.ordered ? [new TextRun({ text: `${index + 1}. `, bold: true }), ...runs] : runs.length ? runs : [new TextRun({ text })],
        }));
      });
      continue;
    }
    if (block.kind === 'code') {
      for (const line of block.lines) {
        children.push(new Paragraph({ children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 18 })] }));
      }
      continue;
    }
    if (block.kind === 'quote') {
      children.push(new Paragraph({ indent: { left: 720 }, children: runsOf(block.runs.map(run => ({ ...run, italic: true }))) }));
      continue;
    }
    if (block.kind === 'table') {
      const rows = block.rows.map((row, index) => new TableRow({
        tableHeader: block.header && index === 0,
        children: row.map(cell => cellOf(cell)),
      }));
      tables.push(new Table({ rows }));
      continue;
    }
  }
  const document = new Document({
    title,
    sections: [{ children: [...children, ...tables] }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
