"""Synthetic multi-source extraction and unchanged evidence/review gates."""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import unittest
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'plugin/scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


adapters = load('source_adapters')
importer = load('series_import')


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / '.agent/source-adapter-tests' / uuid.uuid4().hex
        self.work.mkdir(parents=True)
        self.vault = self.work / 'vault'
        self.vault.mkdir()

    def tearDown(self):
        shutil.rmtree(self.work)

    def source(self, name, text):
        path = self.work / name
        path.write_text(text, encoding='utf-8')
        return path

    def snap(self, **updates):
        value = {'schema': 'talewisp-source-snapshot-v1', 'metadata': {'title': 'Запись', 'source_kind': 'web', 'source_author': 'Source Author'},
                 'provenance': {'origin': 'https://example.org/item', 'extractor': 'connector:test-v1', 'extraction_status': 'complete',
                                'completeness': {'text': True, 'images': True, 'media': True}, 'limitations': []},
                 'sections': [{'title': 'Часть', 'blocks': [{'text': 'Точное утверждение.'}]}], 'images': []}
        value.update(updates)
        return value

    def prepare(self, paths, **kw):
        return importer.build_series_base(self.vault, {'action': 'prepare', 'author_pseudonym': 'Synthetic', 'series_name': 'Коллекция', 'files': [str(p) for p in paths], **kw})

    def session(self, result):
        return json.loads((self.vault / '.talewisp/imports' / result['session_id'] / 'session.json').read_text(encoding='utf-8'))

    def analysis(self, session):
        rows = []
        for bid, corpus in session['corpus'].items():
            for chapter in corpus['chapters']:
                rows.append({'book_id': bid, 'chapter_id': chapter['id'], 'block_ids': [b['id'] for b in chapter['blocks']],
                             'images_read': [], 'images_uncertain': [i for b in chapter['blocks'] for i in b['image_ids']]})
        return {'read_chapters': rows, 'image_transcripts': [{'image_id': i['id'], 'status': 'uncertain', 'transcript': ''} for c in session['corpus'].values() for i in c['images']],
                'scenes': [], 'events': [], 'shared_layers': {k: {'status': 'unknown', 'summary': 'No unsupported claims'} for k in importer.LAYERS}}

    def test_mixed_prepare_preserves_unicode_suffix_metadata_and_provenance(self):
        txt = self.source('notes.txt', 'Заметка первая.\n\nЗаметка вторая.')
        md = self.source('facts.md', '# Факты\n\nТочное утверждение.')
        snap = self.source('external.json', json.dumps(self.snap(), ensure_ascii=False))
        result = self.prepare([txt, md, snap])
        self.assertEqual(result['status'], 'prepared_for_analysis')
        session = self.session(result)
        for row, suffix in zip(session['books'], ['.txt', '.md', '.json']):
            copied = self.vault / session['series_path'] / row['source_file']
            self.assertEqual(copied.suffix, suffix)
            self.assertEqual(copied.read_bytes(), Path(row['source_path']).read_bytes())
        corpus = session['corpus']['B03']
        self.assertEqual(corpus['metadata']['source_author'], 'Source Author')
        self.assertEqual(corpus['metadata']['provenance']['origin'], 'https://example.org/item')
        analysis = self.analysis(session)
        importer._validate_analysis(session, analysis)
        analysis['read_chapters'][0]['block_ids'].pop()
        with self.assertRaisesRegex(importer.SeriesImportError, 'sequence'):
            importer._validate_analysis(session, analysis)

    def test_native_narrative_override_requires_scene_partition(self):
        path = self.source('novel.txt', 'Герой вошёл.')
        session = self.session(self.prepare([path], source_kinds={str(path): 'book'}))
        self.assertEqual(session['inputs'][0]['source_kind'], 'book')
        with self.assertRaisesRegex(importer.SeriesImportError, 'Scene partition'):
            importer._validate_analysis(session, self.analysis(session))

    def test_default_fingerprint_legacy_compatibility_and_kind_change(self):
        path = self.source('note.txt', 'Запись.')
        result = self.prepare([path])
        session = self.session(result)
        expected = json.dumps(['Synthetic', 'Коллекция', [{'path': str(path.resolve()), 'sha256': importer._sha(path.read_bytes())}]], ensure_ascii=False, separators=(',', ':'))
        self.assertEqual(session['input_fingerprint'], expected)
        self.assertEqual(self.prepare([path])['session_id'], result['session_id'])
        with self.assertRaisesRegex(importer.SeriesImportError, 'already exists'):
            self.prepare([path], source_kinds={str(path): 'book'})

    def test_mixed_lifecycle_requires_review_and_accepts_current_candidate(self):
        paths = [self.source('notes.txt', 'Факт.'), self.source('novel.md', 'Герой вошёл.')]
        result = self.prepare(paths, source_kinds={str(paths[1]): 'book'})
        session = self.session(result)
        analysis = self.analysis(session)
        block = session['corpus']['B02']['blocks'][0]
        analysis['scenes'] = [{'id': 'S01', 'book_id': 'B02', 'title': 'Вход', 'block_ids': [block['id']],
                              'participants': ['Герой'], 'place': 'Комната', 'time': 'Начало', 'action': 'Вошёл', 'result': 'Внутри',
                              'emotional_shift': 'Не указан', 'new_information': 'Герой внутри', 'evidence': [{'block_id': block['id'], 'quote': block['text']}]}]
        analysis_path = f".talewisp/imports/{result['session_id']}/analysis.json"
        (self.vault / analysis_path).write_text(json.dumps(analysis, ensure_ascii=False), encoding='utf-8')
        candidate = importer.build_series_base(self.vault, {'action': 'finalize', 'session_id': result['session_id'], 'analysis_path': analysis_path})
        checked = importer.build_series_base(self.vault, {'action': 'check', 'session_id': result['session_id']})
        self.assertEqual(checked['status'], 'PASS', checked['issues'])
        review_path = candidate['independent_review_path']
        with self.assertRaisesRegex(importer.SeriesImportError, 'Independent review'):
            importer.build_series_base(self.vault, {'action': 'accept', 'session_id': result['session_id'], 'review_path': review_path})
        # Test fixture for protocol semantics, not a real independent acceptance.
        review = {'status': 'PASS', 'review_type': 'independent', 'session_id': result['session_id'], 'candidate_sha256': 'stale'}
        (self.vault / review_path).write_text(json.dumps(review), encoding='utf-8')
        with self.assertRaisesRegex(importer.SeriesImportError, 'stale'):
            importer.build_series_base(self.vault, {'action': 'accept', 'session_id': result['session_id'], 'review_path': review_path})
        review['candidate_sha256'] = candidate['candidate_sha256']
        (self.vault / review_path).write_text(json.dumps(review), encoding='utf-8')
        accepted = importer.build_series_base(self.vault, {'action': 'accept', 'session_id': result['session_id'], 'review_path': review_path})
        self.assertEqual(accepted['status'], 'complete')
        self.assertEqual(importer.build_series_base(self.vault, {'action': 'accept', 'session_id': result['session_id']})['status'], 'complete')

    def test_incomplete_snapshot_and_unknown_kind_fail_before_placement(self):
        value = self.snap()
        value['provenance']['completeness']['media'] = False
        path = self.source('incomplete.json', json.dumps(value))
        with self.assertRaisesRegex(importer.SeriesImportError, 'complete'):
            self.prepare([path])
        self.assertEqual(list(self.vault.iterdir()), [])
        with self.assertRaisesRegex(importer.SeriesImportError, 'source_kinds'):
            self.prepare([path], source_kinds={'wrong': 'book'})
        for field in ('title', 'series', 'source_author'):
            value = self.snap()
            value['metadata'][field] = ['invalid']
            path = self.source('invalid.json', json.dumps(value))
            with self.assertRaisesRegex(importer.SeriesImportError, 'must be a string'):
                self.prepare([path])

    def test_snapshot_images_occurrences_and_literal_evidence(self):
        value = self.snap(sections=[{'blocks': [{'text': 'Подпись', 'image_refs': ['picture', 'picture']}]}],
                          images=[{'id': 'picture', 'source_ref': 'document:image:1', 'content_type': 'image/png', 'data_base64': base64.b64encode(b'fake').decode()}])
        path = self.source('images.json', json.dumps(value))
        session = self.session(self.prepare([path]))
        analysis = self.analysis(session)
        importer._validate_analysis(session, analysis)
        analysis['read_chapters'][0]['images_uncertain'].pop()
        with self.assertRaisesRegex(importer.SeriesImportError, 'image occurrences'):
            importer._validate_analysis(session, analysis)
        with self.assertRaisesRegex(importer.SeriesImportError, 'quote does not match'):
            importer._evidence_ok(self.vault, self.vault, session['corpus'], {}, [{'block_id': 'B01-C001-P0001', 'quote': 'Invented'}])

    def test_html_keeps_images_and_rejects_media(self):
        path = self.source('article.html', '<html><body><p>Первый</p><img src="https://example.org/x.png" alt="Схема"><p>Второй</p></body></html>')
        item = adapters.parse_source(path, 1)
        self.assertEqual([b['text'] for b in item['corpus']['blocks']], ['Первый', 'Схема', 'Второй'])
        self.assertEqual(item['corpus']['images'][0]['body_occurrences'], 1)
        path = self.source('video.html', '<video src="x.mp4"></video>')
        with self.assertRaisesRegex(adapters.SourceAdapterError, 'verified'):
            adapters.parse_source(path, 1)

    def test_html_picture_alternatives_and_dynamic_scripts_fail_closed(self):
        fixtures = [
            '<picture><source srcset="meaningful.webp"><img src="fallback.png"></picture>',
            '<source srcset="meaningful.webp">',
            '<html><head><script>document.write("meaningful body")</script></head><body><p>Fallback</p></body></html>',
            '<p onclick="renderStory()">Fallback</p>',
            '<a href="javascript:renderStory()">Fallback</a>',
        ]
        for text in fixtures:
            with self.subTest(text=text):
                path = self.source('dynamic.html', text)
                with self.assertRaisesRegex(adapters.SourceAdapterError, 'verified extraction snapshot'):
                    adapters.parse_source(path, 1)

    def test_markdown_simple_inline_preserves_exact_refs_and_occurrences(self):
        text = 'Карта: ![map](https://example.org/map.png?version=1&part=north)\n\nПовтор: ![map](https://example.org/map.png?version=1&part=north)'
        path = self.source('simple.md', text)
        session = self.session(self.prepare([path]))
        corpus = session['corpus']['B01']
        self.assertEqual([i['source_ref'] for i in corpus['images']], ['https://example.org/map.png?version=1&part=north'])
        self.assertEqual(corpus['images'][0]['body_occurrences'], 2)
        analysis = self.analysis(session)
        importer._validate_analysis(session, analysis)
        analysis['read_chapters'][0]['images_uncertain'].pop()
        with self.assertRaisesRegex(importer.SeriesImportError, 'image occurrences'):
            importer._validate_analysis(session, analysis)

    def test_markdown_reference_and_parenthesized_images_fail_before_placement(self):
        uses = ['![map]', '![map][]', '![label][map]']
        definitions = '[map]: https://example.org/map.png'
        fixtures = [f'{definitions}\n\n{use}' for use in uses] + [f'{use}\n\n{definitions}' for use in uses]
        fixtures += ['![map](https://example.org/(part).png)', '![map](https://example.org/map_(north).png)',
                     '![map](https://example.org/a_(b_(c)).png)', '![map](https://example.org/map.png "Title")',
                     r'![map](https://example.org/map_\(north\).png)', '![map](https://example.org/map.png?x=1&amp;y=2)']
        for text in fixtures:
            with self.subTest(text=text):
                path = self.source('complex.md', text)
                with self.assertRaisesRegex(importer.SeriesImportError, 'verified extraction snapshot'):
                    self.prepare([path])
                self.assertEqual(list(self.vault.iterdir()), [])

    def test_docx_table_paragraphs_and_unsafe_zip(self):
        path = self.work / 'sample.docx'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('docProps/core.xml', '<core><title>Документ</title><creator>Metadata author</creator><created>2026-10-02</created></core>')
            z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Первый</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Ячейка</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
        self.assertEqual([b['text'] for b in adapters.parse_source(path, 1)['corpus']['blocks']], ['Первый', 'Ячейка'])
        self.assertEqual(adapters.parse_source(path, 1)['metadata']['source_author'], 'Metadata author')
        with zipfile.ZipFile(path, 'a') as z: z.writestr('../escape', 'bad')
        with self.assertRaisesRegex(adapters.SourceAdapterError, 'Unsafe'):
            adapters.parse_source(path, 1)

    def docx(self, name, run_content, resources=None):
        path = self.work / name
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p>' + run_content + '</w:p></w:body></w:document>')
            for ref, data in (resources or {}).items(): z.writestr(ref, data)
        return path

    def test_docx_exact_unicode_hyphens_and_run_order(self):
        path = self.docx('hyphens.docx', '<w:r><w:t>Северо</w:t><w:noBreakHyphen/><w:t>запад</w:t></w:r><w:r><w:t> мяг</w:t><w:softHyphen/><w:t>кий</w:t><w:tab/><w:t>🌲</w:t><w:br/><w:t>Ёлка</w:t><w:cr/><w:t>Конец</w:t></w:r>')
        item = adapters.parse_source(path, 1)
        self.assertEqual(item['corpus']['blocks'][0]['text'], 'Северо\u2011запад мяг\u00adкий\t🌲\nЁлка\nКонец')

    def test_docx_unknown_direct_run_content_fails_before_placement(self):
        for token in ['<w:instrText>FIELD</w:instrText>', '<w:fldChar w:fldCharType="begin"/>', '<w:contentPart r:id="x"/>',
                      '<w:ptab/>', '<w:unknown/>', '<a:t>Foreign text</a:t>']:
            with self.subTest(token=token):
                path = self.docx('unknown.docx', '<w:r><w:t>До</w:t>' + token + '<w:t>После</w:t></w:r>')
                with self.assertRaisesRegex(importer.SeriesImportError, 'unsupported direct run content.*verified extraction snapshot'):
                    self.prepare([path])
                self.assertEqual(list(self.vault.iterdir()), [])

    def test_docx_run_properties_are_metadata_and_image_path_remains(self):
        path = self.docx('formatted.docx', '<w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:t>Metadata must not enter body</w:t></w:rPr><w:t>Читаемый текст</w:t></w:r><w:r><w:drawing><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><a:blip r:embed="image1"/></a:graphicData></a:graphic></w:drawing></w:r>',
                         {'word/_rels/document.xml.rels': '<Relationships><Relationship Id="image1" Target="media/image.png"/></Relationships>', 'word/media/image.png': b'synthetic image'})
        item = adapters.parse_source(path, 1)
        self.assertEqual(item['corpus']['blocks'][0]['text'], 'Читаемый текст')
        self.assertEqual(item['corpus']['images'][0]['source_ref'], 'word/media/image.png')
        self.assertEqual(item['corpus']['images'][0]['body_occurrences'], 1)
        self.assertEqual(item['image_bytes']['B01-I0001'], b'synthetic image')

    def test_epub_spine_order(self):
        path = self.work / 'sample.epub'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>')
            z.writestr('OEBPS/package.opf', '<package><metadata><title>Книга</title><creator>Источник</creator></metadata><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>')
            z.writestr('OEBPS/a.xhtml', '<html><body><p>А</p></body></html>')
            z.writestr('OEBPS/b.xhtml', '<html><body><p>Б</p></body></html>')
        item = adapters.parse_source(path, 1)
        self.assertEqual([b['text'] for b in item['corpus']['blocks']], ['Б', 'А'])
        self.assertEqual(item['metadata']['title'], 'Книга')

    def test_epub_manifest_only_cover_audio_video_and_scripts_fail_closed(self):
        fixtures = [('cover.jpg', 'image/jpeg', 'properties="cover-image"'), ('voice.mp3', 'audio/mpeg', ''),
                    ('clip.mp4', 'video/mp4', ''), ('dynamic.js', 'text/javascript', '')]
        for name, media_type, properties in fixtures:
            with self.subTest(name=name):
                path = self.work / 'manifest.epub'
                with zipfile.ZipFile(path, 'w') as z:
                    z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>')
                    z.writestr('package.opf', f'<package><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="extra" href="{name}" media-type="{media_type}" {properties}/></manifest><spine><itemref idref="text"/></spine></package>')
                    z.writestr('text.xhtml', '<html><body><p>Static text</p></body></html>')
                    z.writestr(name, b'synthetic resource')
                with self.assertRaisesRegex(adapters.SourceAdapterError, 'verified extraction snapshot'):
                    adapters.parse_source(path, 1)

    def test_epub_dynamic_body_script_fails_closed(self):
        path = self.work / 'dynamic.epub'
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>')
            z.writestr('package.opf', '<package><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="text"/></spine></package>')
            z.writestr('text.xhtml', '<html><head><script>renderStory()</script></head><body><p>Fallback</p></body></html>')
        with self.assertRaisesRegex(adapters.SourceAdapterError, 'Script-bearing'):
            adapters.parse_source(path, 1)
        with zipfile.ZipFile(path, 'w') as z:
            z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="package.opf"/></rootfiles></container>')
            z.writestr('package.opf', '<package><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="text"/></spine></package>')
            z.writestr('text.xhtml', '<html><body><p>Static text</p></body></html>')
            z.writestr('nav.xhtml', '<html><head><script>renderStory()</script></head><body><p>Navigation</p></body></html>')
        with self.assertRaisesRegex(adapters.SourceAdapterError, 'Script-bearing'):
            adapters.parse_source(path, 1)

    def test_fb2_regression_and_pseudonym_gate(self):
        path = self.source('book.fb2', '<FictionBook><description><title-info><book-title>FB2</book-title><sequence name="Synthetic" number="1"/></title-info></description><body><section><p>Исходный абзац.</p></section></body></FictionBook>')
        gate = importer.build_series_base(self.vault, {'action': 'start', 'files': [str(self.work / 'absent.fb2')]})
        self.assertEqual(gate['status'], 'needs_author')
        session = self.session(self.prepare([path]))
        self.assertEqual(session['corpus']['B01']['blocks'][0]['text'], 'Исходный абзац.')
        with self.assertRaisesRegex(importer.SeriesImportError, 'Scene partition'):
            importer._validate_analysis(session, self.analysis(session))

    def test_unsupported_and_malformed_inputs_fail(self):
        for name, content in [('raw.pdf', '%PDF fake'), ('bad.docx', 'not a zip'), ('bad.epub', 'not a zip'), ('bad.json', '{'), ('binary.txt', '\x00')]:
            with self.subTest(name=name):
                with self.assertRaises(adapters.SourceAdapterError):
                    adapters.parse_source(self.source(name, content), 1)


if __name__ == '__main__':
    unittest.main()
