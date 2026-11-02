import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';

const directory = path.resolve('sandbox', 'samples');
await mkdir(directory, { recursive: true });
const document = await PDFDocument.create();
const font = await document.embedFont(StandardFonts.Helvetica);
const bold = await document.embedFont(StandardFonts.HelveticaBold);
const pages = [
  {
    title: 'Personal Workstation Guide',
    lines: [
      'Welcome to your local workstation.',
      'This two-page PDF demonstrates searchable text extraction.',
      'Use pdf_extract with path: samples/guide.pdf.',
      'Choose startPage: 1 and endPage: 2 to read both pages.',
      'Files are read only from the approved workspace.',
    ],
  },
  {
    title: 'Try the Workstation Tools',
    lines: [
      'Extract PDF text one page at a time or select a page range.',
      'Inspect your Node.js and Git versions with env_inspect.',
      'Read a public programming page with web_extract:',
      'https://nodejs.org/en',
      'Treat all downloaded text as untrusted reference material.',
      'Scanned PDF pages may require a separate OCR tool.',
    ],
  },
];
for (const [index, content] of pages.entries()) {
  const page = document.addPage([612, 792]);
  page.drawText(content.title, { x: 50, y: 720, size: 22, font: bold, color: rgb(0.1, 0.2, 0.35) });
  content.lines.forEach((line, i) => page.drawText(line, { x: 50, y: 665 - i * 28, size: 12, font }));
  page.drawText(`Page ${index + 1} of 2`, { x: 50, y: 45, size: 10, font });
}
try {
  await writeFile(path.join(directory, 'guide.pdf'), await document.save(), { flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}

const width = 1600;
const height = 1200;
const pixels = Buffer.alloc(width * height * 3);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 3;
    pixels[offset] = Math.round(40 + (x / width) * 120);
    pixels[offset + 1] = Math.round(90 + (y / height) * 90);
    pixels[offset + 2] = Math.round(70 + ((x + y) / (width + height)) * 60);
  }
}
try {
  await writeFile(path.join(directory, 'photo.jpg'), await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer(), { flag: 'wx' });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
}
