// Extrai texto de arquivos anexados a um modo: PDF, DOCX e arquivos de texto.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAX_CHARS = 80000;
const MAX_BYTES = 25 * 1024 * 1024;

async function pdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 });
  const pages = [];
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''));
    }
  } finally {
    await task.destroy();
  }
  return pages.join('\n\n');
}

// Leitor minimo de ZIP: acha uma entrada pelo nome no diretorio central e devolve o conteudo.
function zipEntry(buffer, wanted) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Arquivo compactado inválido.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function docxText(buffer) {
  const xml = zipEntry(buffer, 'word/document.xml');
  if (!xml) throw new Error('Não é um documento do Word válido.');
  return xml
    .toString('utf8')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function extractFile(filePath) {
  const name = path.basename(filePath);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_BYTES) throw new Error('Arquivo maior que 25 MB.');
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(name).toLowerCase();
    let text;
    if (ext === '.pdf') text = await pdfText(buffer);
    else if (ext === '.docx') text = docxText(buffer);
    else {
      if (buffer.subarray(0, 4000).includes(0)) throw new Error('Formato não suportado. Use PDF, DOCX ou texto.');
      text = buffer.toString('utf8');
    }
    text = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) throw new Error('Não encontrei texto no arquivo (PDF de imagem não é lido).');
    const truncated = text.length > MAX_CHARS;
    return { name, text: truncated ? text.slice(0, MAX_CHARS) : text, truncated };
  } catch (error) {
    return { name, error: String(error.message || error) };
  }
}

module.exports = { extractFile };
