"""Local, bounded source extraction. External extraction enters as verified JSON.

No network access, account discovery, OCR, or silent binary-to-text fallback.
"""
from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import posixpath
import re
import zipfile
from html.parser import HTMLParser
from html import unescape
from pathlib import Path
import xml.etree.ElementTree as ET


class SourceAdapterError(ValueError):
    pass


def xml(raw):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise SourceAdapterError('DTD/entity declarations are not accepted')
    try:
        return ET.fromstring(raw)
    except ET.ParseError as exc:
        raise SourceAdapterError(f'Malformed XML: {exc}') from exc


def archive(path):
    try:
        z = zipfile.ZipFile(path)
        names = set()
        size = 0
        for info in z.infolist():
            name = info.filename
            if (name in names or '\\' in name or name.startswith('/') or ':' in name
                    or '..' in name.split('/') or (info.external_attr >> 16) & 0o170000 == 0o120000):
                raise SourceAdapterError(f'Unsafe/duplicate ZIP member: {name}')
            names.add(name)
            size += info.file_size
            if info.flag_bits & 1 or info.file_size > 64 * 1024 * 1024 or size > 256 * 1024 * 1024:
                raise SourceAdapterError('Encrypted or oversized source archive')
        return z
    except (OSError, zipfile.BadZipFile) as exc:
        raise SourceAdapterError(f'Unreadable archive: {exc}') from exc


def member(base, target):
    target = target.split('#', 1)[0]
    if not target or re.match(r'^[a-z]+:', target, re.I) or target.startswith('/') or '\\' in target:
        raise SourceAdapterError(f'Unsupported archive reference: {target}')
    result = posixpath.normpath(posixpath.join(posixpath.dirname(base), target))
    if result.startswith('../') or result == '..':
        raise SourceAdapterError('Archive reference escapes package')
    return result


def image(ref, data=None, content_type=None):
    return {'id': ref, 'source_ref': ref, 'content_type': content_type or mimetypes.guess_type(ref)[0] or 'application/octet-stream',
            **({'data_base64': base64.b64encode(data).decode('ascii')} if data is not None else {})}


class Markup(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks, self.images, self.parts = [], [], []
        self.skip = 0

    def flush(self):
        text = ''.join(self.parts).strip()
        if text:
            self.blocks.append({'text': text})
        self.parts = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' or any(k.startswith('on') or str(v or '').strip().lower().startswith('javascript:') for k, v in attrs.items()):
            raise SourceAdapterError('Script-bearing HTML requires verified extraction snapshot')
        if tag in {'picture', 'source'}:
            raise SourceAdapterError('HTML picture/source alternatives require verified extraction snapshot')
        if tag in {'style', 'head'}:
            self.skip += 1
        if self.skip:
            return
        if tag in {'video', 'audio', 'iframe', 'object', 'embed', 'svg', 'canvas', 'math'}:
            raise SourceAdapterError(f'HTML {tag} requires verified extraction snapshot')
        if tag in {'p', 'div', 'h1', 'h2', 'h3', 'li', 'tr', 'br', 'section'}:
            self.flush()
        if tag == 'img':
            ref = attrs.get('src')
            if not ref or attrs.get('srcset'):
                raise SourceAdapterError('Missing/variant image source requires verified extraction')
            self.flush()
            self.images.append(image(ref))
            self.blocks.append({'text': attrs.get('alt', ''), 'tag': 'image', 'image_refs': [ref]})

    def handle_endtag(self, tag):
        if tag in {'script', 'style', 'head'} and self.skip:
            self.skip -= 1
        elif not self.skip and tag in {'td', 'th'}:
            self.parts.append('\t')
        elif not self.skip and tag in {'p', 'div', 'h1', 'h2', 'h3', 'li', 'tr', 'section'}:
            self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def markup(text):
    parser = Markup()
    parser.feed(text)
    parser.close()
    parser.flush()
    # One image may occur repeatedly; occurrences remain in blocks.
    return parser.blocks, list({i['id']: i for i in parser.images}.values())


def markdown_image_refs(text):
    """Accept only completely recognized simple inline image destinations.

    Reference, escaped, titled, nested-label and parenthesized URL forms need
    a verified snapshot rather than an incomplete approximation of Markdown.
    Every image opener must match; no unmatched syntax silently becomes text.
    """
    pattern = re.compile(r'!\[[^\[\]\\\r\n]*\]\(([^\s()<>\\]+)\)')
    matches = list(pattern.finditer(text))
    if [m.start() for m in matches] != [m.start() for m in re.finditer(r'!\[', text)]:
        raise SourceAdapterError('Complex/reference Markdown images require verified extraction snapshot')
    refs = [m.group(1) for m in matches]
    if any(unescape(ref) != ref for ref in refs):
        raise SourceAdapterError('Entity-encoded Markdown images require verified extraction snapshot')
    return refs


def snapshot(path, raw):
    try:
        value = json.loads(raw.decode('utf-8-sig'))
    except (ValueError, UnicodeError) as exc:
        raise SourceAdapterError(f'Invalid UTF-8 snapshot: {exc}') from exc
    if not isinstance(value, dict) or value.get('schema') != 'talewisp-source-snapshot-v1':
        raise SourceAdapterError('Expected talewisp-source-snapshot-v1 JSON snapshot')
    provenance = value.get('provenance', {})
    if (not isinstance(provenance, dict) or not isinstance(provenance.get('origin'), str)
            or not provenance['origin'].strip() or not isinstance(provenance.get('extractor'), str)
            or not provenance['extractor'].strip() or provenance.get('extraction_status') != 'complete'
            or provenance.get('completeness') != {'text': True, 'images': True, 'media': True}
            or provenance.get('limitations') != []):
        raise SourceAdapterError('Snapshot provenance must attest complete text/images/media with no extraction limitations')
    return value


def extract(path):
    raw = path.read_bytes()
    suffix = path.suffix.lower()
    meta = {'title': path.stem, 'source_kind': 'notes', 'source_author': '', 'series': '', 'series_number': '', 'genres': [], 'document_id': '', 'document_date': ''}
    prov = {'origin': str(path.resolve()), 'extractor': f'talewisp-stdlib:{suffix[1:]}:v1', 'extraction_status': 'complete',
            'completeness': {'text': True, 'images': True, 'media': True}, 'limitations': []}
    sections, images = [], []
    if suffix == '.json':
        value = snapshot(path, raw)
        if not isinstance(value.get('metadata'), dict):
            raise SourceAdapterError('Snapshot metadata object required')
        meta.update(value['metadata'])
        prov, sections, images = value['provenance'], value.get('sections'), value.get('images', [])
    elif suffix in {'.txt', '.md', '.html', '.htm'}:
        text = raw.decode('utf-8-sig')
        if '\x00' in text:
            raise SourceAdapterError('Binary or unreadable text source')
        if suffix in {'.html', '.htm'}:
            blocks, images = markup(text)
            meta['source_kind'] = 'article'
        else:
            blocks = [{'text': x} for x in re.split(r'\n\s*\n', text) if x.strip()]
            if suffix == '.md':
                if '<' in text:
                    raise SourceAdapterError('Markdown HTML/reference media requires verified extraction snapshot')
                for block in blocks:
                    refs = markdown_image_refs(block['text'])
                    block['image_refs'] = refs
                    images.extend(image(ref) for ref in refs)
                images = list({i['id']: i for i in images}.values())
        sections = [{'title': path.stem, 'blocks': blocks}]
    elif suffix == '.docx':
        with archive(path) as z:
            names = z.namelist()
            if 'docProps/core.xml' in names:
                for elem in xml(z.read('docProps/core.xml')).iter():
                    field = {'title': 'title', 'creator': 'source_author', 'created': 'document_date', 'identifier': 'document_id'}.get(elem.tag.rsplit('}', 1)[-1])
                    if field and elem.text:
                        meta[field] = elem.text
            if any(re.match(r'word/(header|footer|footnotes|endnotes|comments)', n) for n in names):
                raise SourceAdapterError('DOCX ancillary text requires verified extraction snapshot')
            doc = xml(z.read('word/document.xml'))
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
            if any(e.tag.rsplit('}', 1)[-1] in {'altChunk', 'object', 'pict', 'del', 'ins', 'txbxContent', 'sym', 'chart', 'oMath', 'oMathPara', 'diagram'} for e in doc.iter()):
                raise SourceAdapterError('DOCX embedded/revision content requires verified extraction snapshot')
            if any(e.tag.rsplit('}', 1)[-1] == 'graphicData' and not e.get('uri', '').endswith('/picture') for e in doc.iter()):
                raise SourceAdapterError('DOCX non-picture graphics require verified snapshot')
            word_tag = '{' + ns['w'] + '}'
            run_content = {'rPr', 't', 'tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen', 'drawing'}
            allowed_run_tags = {word_tag + tag for tag in run_content}
            for run in doc.iter(word_tag + 'r'):
                for child in run:
                    if child.tag not in allowed_run_tags:
                        raise SourceAdapterError(f'DOCX unsupported direct run content {child.tag} requires verified extraction snapshot')
            rels = {}
            if 'word/_rels/document.xml.rels' in names:
                rels = {r.get('Id'): r for r in xml(z.read('word/_rels/document.xml.rels'))}
            blocks = []
            for p in doc.findall('.//w:body//w:p', ns):
                parts = []
                for run in p.iter(word_tag + 'r'):
                    for child in run:
                        # Direct, namespace-qualified run tokens preserve order.
                        # Formatting metadata and drawings contribute no text.
                        if child.tag == word_tag + 't': parts.append(child.text or '')
                        elif child.tag == word_tag + 'tab': parts.append('\t')
                        elif child.tag in {word_tag + 'br', word_tag + 'cr'}: parts.append('\n')
                        elif child.tag == word_tag + 'noBreakHyphen': parts.append('\u2011')
                        elif child.tag == word_tag + 'softHyphen': parts.append('\u00ad')
                refs = []
                for e in p.findall('.//a:blip', ns):
                    rid = next((v for k, v in e.attrib.items() if k.rsplit('}', 1)[-1] in {'embed', 'link'}), None)
                    r = rels.get(rid)
                    if r is None or r.get('TargetMode') == 'External':
                        raise SourceAdapterError('DOCX external/missing image requires verified snapshot')
                    ref = member('word/document.xml', r.get('Target', ''))
                    refs.append(ref)
                    images.append(image(ref, z.read(ref)))
                text = ''.join(parts)
                if text.strip() or refs: blocks.append({'text': text, 'image_refs': refs})
            images = list({i['id']: i for i in images}.values())
            sections = [{'title': path.stem, 'blocks': blocks}]
    elif suffix == '.epub':
        meta['source_kind'] = 'book'
        with archive(path) as z:
            container = xml(z.read('META-INF/container.xml'))
            roots = [e.get('full-path') for e in container.iter() if e.tag.rsplit('}', 1)[-1] == 'rootfile']
            if len(roots) != 1: raise SourceAdapterError('EPUB requires exactly one package')
            package_path = member('anchor', roots[0])
            package = xml(z.read(package_path))
            for e in package.iter():
                tag = e.tag.rsplit('}', 1)[-1]
                if tag == 'title' and e.text: meta['title'] = e.text
                elif tag == 'creator' and e.text: meta['source_author'] = e.text
            manifest = {e.get('id'): e for e in package.iter() if e.tag.rsplit('}', 1)[-1] == 'item'}
            spine = [e for e in package.iter() if e.tag.rsplit('}', 1)[-1] == 'itemref']
            if not spine: raise SourceAdapterError('EPUB missing spine')
            for row in spine:
                item = manifest.get(row.get('idref'))
                if item is None or item.get('media-type') not in {'application/xhtml+xml', 'text/html'} or item.get('media-overlay'):
                    raise SourceAdapterError('EPUB unreadable/media spine requires verified snapshot')
                ref = member(package_path, item.get('href', ''))
                data = z.read(ref)
                xml(data)
                blocks, local_images = markup(data.decode('utf-8-sig'))
                mapping = {}
                for img in local_images:
                    target = member(ref, img['source_ref'])
                    mapping[img['id']] = target
                    images.append(image(target, z.read(target)))
                for block in blocks: block['image_refs'] = [mapping[r] for r in block.get('image_refs', [])]
                sections.append({'title': ref, 'blocks': blocks})
            images = list({i['id']: i for i in images}.values())
            # Non-spine textual resources may be omitted by a simplistic extractor.
            used = {member(package_path, manifest[r.get('idref')].get('href', '')) for r in spine}
            for item in manifest.values():
                media_type = item.get('media-type', '')
                resource = member(package_path, item.get('href', ''))
                if media_type.startswith(('audio/', 'video/')) or media_type in {'application/javascript', 'text/javascript', 'application/ecmascript'}:
                    raise SourceAdapterError('EPUB manifest audio/video/script requires verified extraction snapshot')
                if 'scripted' in item.get('properties', '').split():
                    raise SourceAdapterError('EPUB scripted resource requires verified extraction snapshot')
                if media_type.startswith('image/') and resource not in {img['source_ref'] for img in images}:
                    raise SourceAdapterError('EPUB unrepresented manifest image/cover requires verified extraction snapshot')
                if media_type in {'application/xhtml+xml', 'text/html'} and resource not in used and 'nav' not in item.get('properties', '').split():
                    raise SourceAdapterError('EPUB non-spine text requires verified snapshot')
                if media_type in {'application/xhtml+xml', 'text/html'} and resource not in used and 'nav' in item.get('properties', '').split():
                    # Navigation is not narrative text, but its scripts/media
                    # must not bypass the same source-completeness preflight.
                    data = z.read(resource)
                    xml(data)
                    _, nav_images = markup(data.decode('utf-8-sig'))
                    if nav_images:
                        raise SourceAdapterError('EPUB navigation images require verified extraction snapshot')
    else:
        raise SourceAdapterError(f'Unsupported raw format {suffix or "(none)"}; provide a verified extraction JSON snapshot')
    return raw, meta, prov, sections, images


def parse_source(path, index):
    try:
        raw, meta, provenance, sections, source_images = extract(path)
        for field in ('title', 'source_kind', 'source_author', 'series', 'series_number', 'document_id', 'document_date'):
            if not isinstance(meta.get(field), str):
                raise SourceAdapterError(f'Metadata {field} must be a string')
        if not meta['title'].strip():
            raise SourceAdapterError('Metadata title must be non-empty')
        if not isinstance(sections, list) or not sections or not isinstance(source_images, list):
            raise SourceAdapterError('Source requires sections and images arrays')
        if meta.get('source_kind') not in {'book', 'article', 'notes', 'document', 'web', 'audio', 'video', 'other'}:
            raise SourceAdapterError('Invalid source_kind')
        images, image_bytes, mapping = [], {}, {}
        for n, img in enumerate(source_images, 1):
            if not isinstance(img, dict) or not isinstance(img.get('id'), str) or not img['id'] or img['id'] in mapping or not img.get('source_ref'):
                raise SourceAdapterError('Images require unique id and source_ref')
            iid = f'B{index:02d}-I{n:04d}'
            mapping[img['id']] = iid
            data = base64.b64decode(img['data_base64'], validate=True) if 'data_base64' in img else None
            ext = mimetypes.guess_extension(img.get('content_type', '')) or '.bin'
            rel = f'00 Источники/Изображения/{iid}{ext}' if data is not None else None
            images.append({'id': iid, 'source_ref': img['source_ref'], 'content_type': img.get('content_type'),
                           'relative_path': rel, 'body_occurrences': 0, 'sha256': hashlib.sha256(data).hexdigest() if data is not None else None})
            if data is not None: image_bytes[iid] = data
        chapters, all_blocks = [], []
        for n, section in enumerate(sections, 1):
            if not isinstance(section, dict) or not isinstance(section.get('blocks'), list) or not section['blocks']:
                raise SourceAdapterError('Every section requires non-empty blocks')
            cid, blocks = f'B{index:02d}-C{n:03d}', []
            for k, block in enumerate(section['blocks'], 1):
                if not isinstance(block, dict) or not isinstance(block.get('text'), str) or not isinstance(block.get('image_refs', []), list):
                    raise SourceAdapterError('Blocks require text and optional image_refs array')
                refs = [mapping[r] for r in block.get('image_refs', [])]
                if not block['text'].strip() and not refs: raise SourceAdapterError('Empty source block')
                out = {'id': f'{cid}-P{k:04d}', 'tag': block.get('tag', 'p'), 'text': block['text'], 'image_ids': refs}
                blocks.append(out)
                all_blocks.append(out)
                for ref in refs: next(i for i in images if i['id'] == ref)['body_occurrences'] += 1
            chapters.append({'id': cid, 'title': str(section.get('title', '')), 'blocks': blocks})
        meta.update(source_path=str(path.resolve()), source_sha256=hashlib.sha256(raw).hexdigest(), source_bytes=len(raw), provenance=provenance)
        corpus = {'book_id': f'B{index:02d}', 'metadata': meta, 'chapters': chapters, 'blocks': all_blocks, 'images': images, 'body_block_count': len(all_blocks)}
        return {'raw': raw, 'metadata': meta, 'corpus': corpus, 'image_bytes': image_bytes}
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, RuntimeError) as exc:
        raise SourceAdapterError(f'{path.name}: {exc}') from exc
