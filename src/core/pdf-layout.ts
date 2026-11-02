import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Block, InlineRun } from './html-blocks.js';
import { cjkFontCandidates } from './fonts.js';

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 56;

interface Style { size: number; bold: boolean; mono: boolean; indent: number; spaceBefore: number; }

const headingSizes = [22, 18, 15, 13, 12, 11];

interface FontSet {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

/** Fonts must be embedded into the very document that draws them. */
async function embedFonts(document: PDFDocument): Promise<FontSet> {
  document.registerFontkit(fontkit);
  for (const candidate of await cjkFontCandidates()) {
    try {
      const regular = await document.embedFont(candidate.regular, { subset: true });
      const bold = candidate.bold === candidate.regular ? regular : await document.embedFont(candidate.bold, { subset: true });
      return { regular, bold, mono: regular };
    } catch {
      // Some system fonts cannot be subset; fall through to the next candidate.
    }
  }
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  return { regular, bold, mono: regular };
}

interface Piece { text: string; font: PDFFont; size: number; }

function isCjk(character: string): boolean {
  return /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(character);
}

function atomsOf(runs: InlineRun[], fonts: FontSet, style: Style): Piece[] {
  const pieces: Piece[] = [];
  for (const run of runs) {
    const font = run.mono ? fonts.mono : run.bold ? fonts.bold : fonts.regular;
    const size = style.size;
    const text = run.text;
    let buffer = '';
    const flush = () => { if (buffer) { pieces.push({ text: buffer, font, size }); buffer = ''; } };
    for (const character of text) {
      if (isCjk(character) || character === '\n') { flush(); pieces.push({ text: character, font, size }); continue; }
      buffer += character;
      if (character === ' ') flush();
    }
    flush();
  }
  return pieces;
}

function widthOf(piece: Piece): number {
  return piece.font.widthOfTextAtSize(piece.text, piece.size);
}

interface Line { pieces: Piece[]; width: number; }

function wrap(pieces: Piece[], maxWidth: number): Line[] {
  const lines: Line[] = [];
  let current: Piece[] = [];
  let width = 0;
  const push = () => { lines.push({ pieces: current, width }); current = []; width = 0; };
  for (const piece of pieces) {
    if (piece.text === '\n') { push(); continue; }
    const pieceWidth = widthOf(piece);
    if (width + pieceWidth > maxWidth && current.length) {
      // Prefer to break before the current atom; Latin words are already split on spaces.
      push();
    }
    current.push(piece);
    width += pieceWidth;
  }
  if (current.length) push();
  return lines.length ? lines : [{ pieces: [], width: 0 }];
}

export interface RenderOptions {
  title?: string;
  footer?: string;
}

export async function renderBlocksToPdf(blocks: Block[], options: RenderOptions = {}): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const fonts = await embedFonts(document);
  document.setTitle(options.title ?? '转换结果');
  const pages: PDFPage[] = [];
  let page = document.addPage([pageWidth, pageHeight]);
  pages.push(page);
  let cursor = pageHeight - margin;

  const newPage = () => {
    page = document.addPage([pageWidth, pageHeight]);
    pages.push(page);
    cursor = pageHeight - margin;
  };

  const drawLine = (line: Line, style: Style) => {
    const leading = style.size * 1.55;
    if (cursor - leading < margin) newPage();
    let x = margin + style.indent;
    for (const piece of line.pieces) {
      page.drawText(piece.text, { x, y: cursor - style.size, size: piece.size, font: piece.font, color: rgb(0.14, 0.19, 0.17) });
      x += widthOf(piece);
    }
    cursor -= leading;
  };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      const size = headingSizes[Math.min(block.level, headingSizes.length) - 1];
      cursor -= 6;
      wrap(atomsOf(block.runs, fonts, { size, bold: true, mono: false, indent: 0, spaceBefore: 0 }), pageWidth - margin * 2)
        .forEach(line => drawLine(line, { size, bold: true, mono: false, indent: 0, spaceBefore: 0 }));
      cursor -= 4;
      continue;
    }
    if (block.kind === 'paragraph') {
      const style: Style = { size: 11, bold: false, mono: false, indent: 0, spaceBefore: 0 };
      wrap(atomsOf(block.runs, fonts, style), pageWidth - margin * 2).forEach(line => drawLine(line, style));
      cursor -= 4;
      continue;
    }
    if (block.kind === 'list') {
      block.items.forEach((item, index) => {
        const marker = block.ordered ? `${index + 1}.` : '·';
        const style: Style = { size: 11, bold: false, mono: false, indent: 16, spaceBefore: 0 };
        const lines = wrap(atomsOf(item, fonts, style), pageWidth - margin * 2 - 16);
        lines.forEach((line, lineIndex) => {
          if (lineIndex === 0) {
            const leading = style.size * 1.55;
            if (cursor - leading < margin) newPage();
            page.drawText(marker, { x: margin, y: cursor - style.size, size: style.size, font: fonts.regular, color: rgb(0.14, 0.19, 0.17) });
            drawLine(line, style);
          } else drawLine(line, style);
        });
      });
      cursor -= 4;
      continue;
    }
    if (block.kind === 'quote') {
      const style: Style = { size: 11, bold: false, mono: false, indent: 18, spaceBefore: 0 };
      wrap(atomsOf(block.runs, fonts, style), pageWidth - margin * 2 - 18).forEach(line => drawLine(line, style));
      cursor -= 4;
      continue;
    }
    if (block.kind === 'code') {
      const style: Style = { size: 9.5, bold: false, mono: true, indent: 12, spaceBefore: 0 };
      for (const raw of block.lines) {
        const lines = wrap(atomsOf([{ text: raw || ' ' }], fonts, style), pageWidth - margin * 2 - 12);
        lines.forEach(line => drawLine(line, style));
      }
      cursor -= 4;
      continue;
    }
    if (block.kind === 'rule') {
      if (cursor - 12 < margin) newPage();
      page.drawLine({ start: { x: margin, y: cursor - 6 }, end: { x: pageWidth - margin, y: cursor - 6 }, thickness: 0.6, color: rgb(0.78, 0.81, 0.77) });
      cursor -= 12;
      continue;
    }
    const columns = Math.max(...block.rows.map(row => row.length), 1);
    const cellWidth = (pageWidth - margin * 2) / columns;
    const style: Style = { size: 9.5, bold: false, mono: false, indent: 0, spaceBefore: 0 };
    for (const row of block.rows) {
      const cellLines = row.map(cell => wrap(atomsOf([{ text: cell }], fonts, style), cellWidth - 12));
      const rowHeight = Math.max(...cellLines.map(lines => lines.length)) * style.size * 1.45 + 8;
      if (cursor - rowHeight < margin) newPage();
      const top = cursor;
      row.forEach((_cell, columnIndex) => {
        const lines = cellLines[columnIndex] ?? [];
        const x = margin + columnIndex * cellWidth;
        page.drawRectangle({ x, y: top - rowHeight, width: cellWidth, height: rowHeight, borderColor: rgb(0.85, 0.87, 0.83), borderWidth: 0.5 });
        lines.forEach((line, lineIndex) => {
          let offset = x + 6;
          for (const piece of line.pieces) {
            page.drawText(piece.text, { x: offset, y: top - 8 - lineIndex * style.size * 1.45 - piece.size, size: piece.size, font: piece.font, color: rgb(0.14, 0.19, 0.17) });
            offset += widthOf(piece);
          }
        });
      });
      cursor -= rowHeight;
    }
    cursor -= 4;
  }

  pages.forEach((item, index) => {
    item.drawText(options.footer ?? `${options.title ?? ''}  ·  第 ${index + 1} / ${pages.length} 页`, {
      x: margin, y: margin - 18, size: 8, font: fonts.regular, color: rgb(0.45, 0.49, 0.46),
    });
  });

  return new Uint8Array(await document.save());
}
