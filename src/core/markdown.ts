const AMP = String.fromCharCode(38) + 'amp;';
const LT = String.fromCharCode(38) + 'lt;';
const GT = String.fromCharCode(38) + 'gt;';

const escapeHtml = (value: string): string => value
  .replace(/&/g, AMP)
  .replace(/</g, LT)
  .replace(/>/g, GT);

function inline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Minimal Markdown to HTML conversion covering headings, lists, code, quotes and paragraphs. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^```\s*(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) { code.push(lines[index]); index++; }
      index++;
      output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      index++;
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*+])\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*([-*+])\s+/, ''))}</li>`);
        index++;
      }
      output.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        index++;
      }
      output.push(`<ol>${items.join('')}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index++;
      }
      output.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1])) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const header = cells(line);
      index += 2;
      const rows: string[] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(`<tr>${cells(lines[index]).map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`);
        index++;
      }
      output.push(`<table><thead><tr>${header.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { output.push('<hr />'); index++; continue; }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[index])) {
      paragraph.push(lines[index].trim());
      index++;
    }
    output.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return output.join('\n');
}
