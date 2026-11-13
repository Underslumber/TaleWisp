// Builds a book file (EPUB 3, DOCX or FB2) from chapters with plain text and optional formatting ranges.
// No dependencies: the ZIP container is written here with node:zlib.
import { crc32, deflateRawSync } from 'node:zlib';

export const EXPORT_FORMATS = Object.freeze(['epub', 'docx', 'fb2']);
const xml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

/** Minimal ZIP writer. Entries with `store: true` are written uncompressed (EPUB needs that for `mimetype`). */
export function zip(entries) {
  const parts = [], central = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store ? data : deflateRawSync(data, { level: 9 }), method = entry.store ? 0 : 8, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(method, 10);
    header.writeUInt16LE(0, 12); header.writeUInt16LE(0x21, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    parts.push(local, name, body); central.push(header, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

/** Splits a chapter into paragraphs of runs: [{ text, bold, italic, underline, strike }]. Ranges are offsets in the chapter text. */
export function paragraphsOf(body, rich) {
  const ranges = Array.isArray(rich?.ranges) ? rich.ranges.filter(r => Number.isSafeInteger(r?.start) && Number.isSafeInteger(r?.end) && r.end > r.start && r.style) : [];
  const paragraphs = []; let offset = 0;
  for (const line of String(body).split('\n')) {
    const start = offset, end = offset + line.length; offset = end + 1;
    if (!line.trim()) continue;
    const cuts = new Set([start, end]);
    for (const r of ranges) { if (r.start > start && r.start < end) cuts.add(r.start); if (r.end > start && r.end < end) cuts.add(r.end); }
    const points = [...cuts].sort((a, b) => a - b), runs = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i], to = points[i + 1], style = {};
      for (const r of ranges) if (r.start <= from && to <= r.end) for (const key of ['bold', 'italic', 'underline', 'strike']) if (r.style[key] === true) style[key] = true;
      const text = String(body).slice(from, to);
      if (text) runs.push({ text, ...style });
    }
    if (runs.length) paragraphs.push(runs);
  }
  return paragraphs;
}

const htmlRun = run => { let out = xml(run.text); if (run.strike) out = `<s>${out}</s>`; if (run.underline) out = `<u>${out}</u>`; if (run.italic) out = `<em>${out}</em>`; if (run.bold) out = `<strong>${out}</strong>`; return out; };
const fb2Run = run => { let out = xml(run.text); if (run.strike) out = `<strikethrough>${out}</strikethrough>`; if (run.italic) out = `<emphasis>${out}</emphasis>`; if (run.bold) out = `<strong>${out}</strong>`; return out; };
const docxRun = run => `<w:r>${run.bold || run.italic || run.underline || run.strike ? `<w:rPr>${run.bold ? '<w:b/>' : ''}${run.italic ? '<w:i/>' : ''}${run.underline ? '<w:u w:val="single"/>' : ''}${run.strike ? '<w:strike/>' : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
const safeName = value => (String(value).normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'book');

function epub({ title, author, series, language, chapters, identifier, modifiedAt }) {
  const stamp = modifiedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const page = (heading, inner) => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${xml(language)}" lang="${xml(language)}">\n<head><meta charset="utf-8"/><title>${xml(heading)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n<body>${inner}</body>\n</html>\n`;
  const files = chapters.map((chapter, index) => ({ id: `chapter-${index + 1}`, href: `chapter-${String(index + 1).padStart(3, '0')}.xhtml`, title: chapter.title,
    data: page(chapter.title, `<section epub:type="chapter"><h1>${xml(chapter.title)}</h1>\n${paragraphsOf(chapter.body, chapter.rich).map(runs => `<p>${runs.map(htmlRun).join('')}</p>`).join('\n')}</section>`) }));
  const nav = page(title, `<nav epub:type="toc" id="toc"><h1>Оглавление</h1><ol>${files.map(file => `<li><a href="${file.href}">${xml(file.title)}</a></li>`).join('')}</ol></nav>`);
  const titlePage = page(title, `<section class="title-page" epub:type="titlepage">${author ? `<p class="author">${xml(author)}</p>` : ''}<h1>${xml(title)}</h1>${series ? `<p class="series">${xml(series)}</p>` : ''}</section>`);
  const opf = `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${xml(language)}">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n<dc:identifier id="book-id">urn:talewisp:${xml(identifier)}</dc:identifier>\n<dc:title>${xml(title)}</dc:title>\n<dc:language>${xml(language)}</dc:language>\n${author ? `<dc:creator>${xml(author)}</dc:creator>\n` : ''}${series ? `<meta property="belongs-to-collection" id="series">${xml(series)}</meta>\n` : ''}<meta property="dcterms:modified">${stamp}</meta>\n</metadata>\n<manifest>\n<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>\n<item id="style" href="style.css" media-type="text/css"/>\n<item id="title-page" href="title.xhtml" media-type="application/xhtml+xml"/>\n${files.map(file => `<item id="${file.id}" href="${file.href}" media-type="application/xhtml+xml"/>`).join('\n')}\n</manifest>\n<spine>\n<itemref idref="title-page"/>\n${files.map(file => `<itemref idref="${file.id}"/>`).join('\n')}\n</spine>\n</package>\n`;
  const css = 'body { font-family: serif; line-height: 1.5; margin: 5%; }\nh1 { font-size: 1.6em; text-align: center; margin: 2em 0 1.2em; }\np { margin: 0; text-indent: 1.5em; text-align: justify; }\nh1 + p { text-indent: 0; }\n.title-page { text-align: center; margin-top: 30%; }\n.title-page p { text-indent: 0; text-align: center; }\n.author { font-size: 1.2em; }\n.series { font-style: italic; margin-top: 2em; }\n';
  return zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n' },
    { name: 'OEBPS/content.opf', data: opf }, { name: 'OEBPS/nav.xhtml', data: nav }, { name: 'OEBPS/style.css', data: css }, { name: 'OEBPS/title.xhtml', data: titlePage },
    ...files.map(file => ({ name: `OEBPS/${file.href}`, data: file.data })),
  ]);
}

function docx({ title, author, chapters }) {
  const paragraph = (runs, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs.map(docxRun).join('')}</w:p>`;
  const body = [paragraph([{ text: title }], 'Title'), ...(author ? [paragraph([{ text: author }], 'Subtitle')] : []),
    ...chapters.flatMap(chapter => [paragraph([{ text: chapter.title }], 'Heading1'), ...paragraphsOf(chapter.body, chapter.rich).map(runs => paragraph(runs, 'BodyText'))])].join('');
  const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${ns}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault></w:docDefaults>`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="2400" w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:after="480"/></w:pPr><w:rPr><w:sz w:val="28"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:pPr><w:keepNext/><w:pageBreakBefore/><w:jc w:val="center"/><w:spacing w:before="480" w:after="360"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="BodyText"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:firstLine="567"/><w:jc w:val="both"/><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:style></w:styles>';
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${ns}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1418" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>` },
  ]);
}

function fb2({ title, author, series, language, chapters, identifier, modifiedAt }) {
  const names = String(author).trim().split(/\s+/).filter(Boolean), first = names.length > 1 ? names.slice(0, -1).join(' ') : '', last = names.at(-1) ?? '';
  const sections = chapters.map(chapter => `<section><title><p>${xml(chapter.title)}</p></title>\n${paragraphsOf(chapter.body, chapter.rich).map(runs => `<p>${runs.map(fb2Run).join('')}</p>`).join('\n')}</section>`).join('\n');
  const date = modifiedAt.toISOString().slice(0, 10);
  return Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">\n<description><title-info><genre>prose_contemporary</genre><author><first-name>${xml(first)}</first-name><last-name>${xml(last)}</last-name></author><book-title>${xml(title)}</book-title><lang>${xml(language)}</lang>${series ? `<sequence name="${xml(series)}"/>` : ''}</title-info><document-info><author><nickname>TaleWisp</nickname></author><program-used>TaleWisp</program-used><date value="${date}">${date}</date><id>${xml(identifier)}</id><version>1.0</version></document-info></description>\n<body><title><p>${xml(title)}</p></title>\n${sections}\n</body>\n</FictionBook>\n`, 'utf8');
}

const MIME = { epub: 'application/epub+zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fb2: 'application/x-fictionbook+xml' };
/** Returns { filename, mimeType, bytes }. */
export function buildBookFile(book) {
  if (!EXPORT_FORMATS.includes(book.format)) throw new TypeError('Unknown export format.');
  const bytes = book.format === 'epub' ? epub(book) : book.format === 'docx' ? docx(book) : fb2(book);
  return { filename: `${safeName(book.title)}.${book.format}`, mimeType: MIME[book.format], bytes };
}
