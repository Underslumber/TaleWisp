"""Deterministic, review-gated FB2 series-base import primitives.

The caller owns semantic reading and supplies ``analysis.json`` to ``finalize``.
This module only extracts source structure, validates cited evidence/coverage,
renders shared series notes and per-book plots/scenes, and commits after review.
It uses only the standard library and performs no work at import time.

Analysis JSON contract (all paths are vault-relative):
  read_chapters: [{book_id, chapter_id, block_ids, images_read, images_uncertain}]
  image_transcripts: [{image_id, transcript, status: read|uncertain}]
  scenes: [{id, book_id, title, block_ids, participants, place, time, action,
            result, emotional_shift, new_information, evidence}]
  events: [{scene_id, cause, consequence, story_time, evidence}]
  entities: [{name, kind, definition, facts, evidence, basis, status, scope,
              valid_from, valid_until}]
  rules: [{name, price, limits, exceptions, evidence, status}]
  threads: [{book_number, name, goal, conflict, stakes, state, setups, payoffs,
             status: supported|uncertain|unknown, evidence}]
  knowledge: [{fact, holder, mode, learned_at, how, objective_status, evidence,
               valid_until}]
  style: [{observation, scope, examples, exceptions, evidence, status}]
  shared_layers: mapping of the nine shared layer names to
      {status: supported|uncertain|unknown, summary, evidence}.
Evidence is [{block_id, quote}] or [{image_id, quote}]. Each supported claim
must have evidence; unknown/uncertain claims remain explicitly labeled.
"""
from __future__ import annotations

import base64
from collections import Counter
import hashlib
import html
import json
import mimetypes
import os
import posixpath
import re
import shutil
import tempfile
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


class SeriesImportError(Exception):
    """A user-correctable import, validation, or conflict error."""


LAYERS = {
    "series_passport": "Паспорт серии",
    "world": "Мир и устройство",
    "rules": "Правила и цены",
    "entities": "Сущности",
    "glossary": "Глоссарий",
    "style": "Стиль источника",
    "chronology": "Хронология",
    "knowledge": "Знания персонажей",
    "uncertainties": "Неопределённости",
}
INVALID_COMPONENT = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED_COMPONENT = re.compile(r"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$", re.I)
BODY_TAGS = {"p", "v", "subtitle", "text-author"}
EVIDENCE_RE = re.compile(r"\[\[([^\]#|]+)(?:#([^\]|]+))?(?:\|[^\]]+)?\]\]")


def _json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SeriesImportError(f"Cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SeriesImportError(f"Expected a JSON object in {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    _atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".tw-import-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _component(value: str, label: str) -> str:
    value = str(value or "").strip()
    if (not value or value in {".", ".."} or value[-1:] in {".", " "}
            or INVALID_COMPONENT.search(value) or RESERVED_COMPONENT.match(value)):
        raise SeriesImportError(f"Invalid Windows {label}: {value!r}")
    return value


def _inside(root: Path, path: Path) -> Path:
    root = root.resolve()
    path = path.resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise SeriesImportError("Path escapes the active vault") from exc
    return path


def _rel(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _tag(elem: ET.Element) -> str:
    return elem.tag.rsplit("}", 1)[-1]


def _text(elem: ET.Element | None) -> str:
    if elem is None:
        return ""
    return " ".join(part.strip() for part in elem.itertext() if part.strip())


def _children(elem: ET.Element | None, name: str) -> list[ET.Element]:
    return [child for child in list(elem or []) if _tag(child) == name]


def _child(elem: ET.Element | None, name: str) -> ET.Element | None:
    return next(iter(_children(elem, name)), None)


def _parse_fb2(path: Path, book_index: int) -> dict[str, Any]:
    if path.suffix.lower() != ".fb2":
        raise SeriesImportError(f"Unsupported source format {path.suffix or '(none)'}; supported format: FB2")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise SeriesImportError(f"Cannot read source {path}: {exc}") from exc
    # FB2 has no need for DTD/entity declarations. Reject them to keep parsing local.
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise SeriesImportError(f"FB2 DTD/entity declarations are not accepted: {path.name}")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise SeriesImportError(f"Invalid FB2 XML {path.name}: {exc}") from exc
    description = _child(root, "description")
    title_info = _child(description, "title-info")
    doc_info = _child(description, "document-info")
    title = _text(_child(title_info, "book-title")) or path.stem
    author = _child(title_info, "author")
    source_author = " ".join(filter(None, (
        _text(_child(author, "first-name")), _text(_child(author, "middle-name")),
        _text(_child(author, "last-name")),
    ))) if author is not None else ""
    sequence = _child(title_info, "sequence")
    series = sequence.get("name", "").strip() if sequence is not None else ""
    seq_no = sequence.get("number", "").strip() if sequence is not None else ""
    genres = [_text(x) for x in _children(title_info, "genre") if _text(x)]
    doc_id = _text(_child(doc_info, "id"))
    doc_date = _text(_child(doc_info, "date"))
    meta = {"title": title, "source_author": source_author, "series": series,
            "series_number": seq_no, "genres": genres, "document_id": doc_id,
            "document_date": doc_date, "source_path": str(path.resolve()),
            "source_sha256": _sha(raw), "source_bytes": len(raw)}

    binaries: dict[str, tuple[str, bytes]] = {}
    images: list[dict[str, Any]] = []
    body_image_refs: dict[str, str] = {}
    for binary in (x for x in root.iter() if _tag(x) == "binary"):
        binary_id = binary.get("id", "")
        try:
            data = base64.b64decode("".join((binary.text or "").split()), validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise SeriesImportError(f"Invalid embedded image data in {path.name} ({binary_id})") from exc
        content_type = binary.get("content-type", "application/octet-stream")
        binaries[binary_id] = (content_type, data)

    bodies = [x for x in root.iter() if _tag(x) == "body" and x.get("name", "main").lower() == "main"]
    if not bodies:
        bodies = [x for x in root.iter() if _tag(x) == "body"][:1]
    if not bodies:
        raise SeriesImportError(f"FB2 has no body: {path.name}")

    image_ref_to_id: dict[str, str] = {}
    for image in (x for x in root.iter() if _tag(x) == "image"):
        href = image.get("{http://www.w3.org/1999/xlink}href") or image.get("href", "")
        if href and href not in image_ref_to_id:
            image_ref_to_id[href] = f"B{book_index:02d}-I{len(image_ref_to_id) + 1:04d}"
    # Include binaries even when only used as a cover or not referenced in body.
    binary_refs = {f"#{key}" for key in binaries}
    for ref in binary_refs:
        if ref not in image_ref_to_id:
            image_ref_to_id[ref] = f"B{book_index:02d}-I{len(image_ref_to_id) + 1:04d}"
    cover = _child(_child(title_info, "coverpage"), "image")
    cover_href = (cover.get("{http://www.w3.org/1999/xlink}href") or cover.get("href", "")) if cover is not None else ""
    for ref, image_id in image_ref_to_id.items():
        binary_id = ref[1:] if ref.startswith("#") else ""
        content_type, data = binaries.get(binary_id, ("", b""))
        image_path = None
        if data:
            ext = mimetypes.guess_extension(content_type) or ".bin"
            if ext == ".jpe":
                ext = ".jpg"
            image_path = f"00 Источники/Изображения/{image_id}{ext}"
        images.append({"id": image_id, "source_ref": ref, "binary_id": binary_id or None,
                       "content_type": content_type or None, "bytes": len(data),
                       "sha256": _sha(data) if data else None, "relative_path": image_path,
                       "is_cover": ref == cover_href, "body_occurrences": 0})
        body_image_refs[ref] = image_id

    chapters: list[dict[str, Any]] = []
    blocks_all: list[dict[str, Any]] = []
    block_no = 0

    def make_chapter(container: ET.Element, chapter_no: int, heading: str = "") -> None:
        nonlocal block_no
        chapter_id = f"B{book_index:02d}-C{chapter_no:03d}"
        blocks: list[dict[str, Any]] = []

        def visit(node: ET.Element) -> None:
            nonlocal block_no
            for child in list(node):
                tag = _tag(child)
                if tag == "section":
                    continue
                if tag == "image":
                    href = child.get("{http://www.w3.org/1999/xlink}href") or child.get("href", "")
                    if href and href in body_image_refs:
                        block_no += 1
                        block_id = f"B{book_index:02d}-C{chapter_no:03d}-P{block_no:04d}"
                        block = {"id": block_id, "tag": "image", "text": "", "image_ids": [body_image_refs[href]]}
                        blocks.append(block)
                        blocks_all.append(block)
                        next(x for x in images if x["id"] == body_image_refs[href])["body_occurrences"] += 1
                    continue
                if tag in BODY_TAGS:
                    text = _text(child)
                    refs = []
                    for image in child.iter():
                        if _tag(image) == "image":
                            href = image.get("{http://www.w3.org/1999/xlink}href") or image.get("href", "")
                            if href and href in body_image_refs:
                                refs.append(body_image_refs[href])
                    if text or refs:
                        block_no += 1
                        block_id = f"B{book_index:02d}-C{chapter_no:03d}-P{block_no:04d}"
                        block = {"id": block_id, "tag": tag, "text": text,
                                 "image_ids": refs}
                        blocks.append(block)
                        blocks_all.append(block)
                        for ref_id in block["image_ids"]:
                            item = next(x for x in images if x["id"] == ref_id)
                            item["body_occurrences"] += 1
                    continue
                visit(child)

        visit(container)
        chapters.append({"id": chapter_id, "title": heading, "blocks": blocks})

    for body in bodies:
        direct_sections = _children(body, "section")
        if direct_sections:
            for section in direct_sections:
                for nested in [section] + [x for x in section.iter() if _tag(x) == "section" and x is not section]:
                    # Each section forms a stable chapter boundary; text in a parent
                    # section is captured in that parent and nested content is skipped.
                    heading = _text(_child(_child(nested, "title"), "p"))
                    make_chapter(nested, len(chapters) + 1, heading)
        else:
            make_chapter(body, len(chapters) + 1, "")
    chapters = [c for c in chapters if c["blocks"]]
    # Renumber after dropping empty sections, preserving IDs on every block.
    if not chapters:
        raise SeriesImportError(f"No readable body paragraphs/verses found in {path.name}")
    corpus = {"book_id": f"B{book_index:02d}", "metadata": meta,
              "chapters": chapters, "blocks": blocks_all, "images": images,
              "body_block_count": len(blocks_all)}
    return {"metadata": meta, "raw": raw, "corpus": corpus,
            "image_bytes": {item["id"]: binaries.get((item.get("binary_id") or ""), ("", b""))[1]
                            for item in images if item.get("relative_path")}}


def _baseline(root: Path) -> dict[str, str]:
    result = {}
    if root.exists():
        for path in root.rglob("*"):
            if path.is_file() and ".talewisp/imports/" not in path.relative_to(root).as_posix():
                result[path.relative_to(root).as_posix()] = _sha(path.read_bytes())
    return result


def _session_dir(root: Path, session_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{20}", session_id):
        raise SeriesImportError("Invalid import session_id")
    return _inside(root, root / ".talewisp" / "imports" / session_id)


def _initial(args: dict[str, Any]) -> dict[str, Any]:
    pseudonym = str(args.get("author_pseudonym") or "").strip()
    if not pseudonym:
        return {"status": "needs_author", "question": "Под каким псевдонимом создать папку автора?"}
    return {"status": "needs_prepare", "author_pseudonym": _component(pseudonym, "author pseudonym"),
            "next_action": "prepare"}


def _prepare(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    pseudonym = _component(str(args.get("author_pseudonym") or ""), "author pseudonym")
    raw_paths = args.get("files")
    if not isinstance(raw_paths, list) or not raw_paths:
        raise SeriesImportError("prepare requires a non-empty absolute files array")
    paths = []
    for item in raw_paths:
        p = Path(str(item)).expanduser()
        if not p.is_absolute():
            raise SeriesImportError("Every source file must be an absolute path")
        paths.append(p.resolve())
    if len({str(p).casefold() for p in paths}) != len(paths):
        raise SeriesImportError("Duplicate source file path")
    parsed = [_parse_fb2(path, n) for n, path in enumerate(paths, 1)]
    series_names = sorted({p["metadata"]["series"] for p in parsed if p["metadata"]["series"]})
    series_name = str(args.get("series_name") or "").strip()
    if not series_name:
        if len(series_names) == 1:
            series_name = series_names[0]
        else:
            return {"status": "needs_series", "question": "Как называется серия?",
                    "source_series_names": series_names, "unresolved_books": [
                        {"path": p["metadata"]["source_path"], "title": p["metadata"]["title"]}
                        for p in parsed if not p["metadata"]["series"] or len(series_names) > 1]}
    series_name = _component(series_name, "series name")
    book_titles = [_component(p["metadata"]["title"], "book title") for p in parsed]
    norm_titles = [x.casefold() for x in book_titles]
    if len(set(norm_titles)) != len(norm_titles):
        raise SeriesImportError("Book title collision; resolve duplicate titles before import")
    author_dir = _inside(root, root / "00 Автор" / pseudonym)
    series_dir = _inside(root, author_dir / series_name)
    if series_dir.exists():
        # Only the exact same still-owned session may resume its prepared output.
        inputs = [{"path": str(p), "sha256": item["metadata"]["source_sha256"]}
                  for p, item in zip(paths, parsed)]
        fingerprint = json.dumps([pseudonym, series_name, inputs], ensure_ascii=False, separators=(",", ":"))
        sid = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:20]
        session_path = _session_dir(root, sid) / "session.json"
        if session_path.exists():
            old = _json(session_path)
            if old.get("input_fingerprint") == fingerprint and old.get("status") not in {"complete", "rejected"}:
                return _session_result(root, old)
        raise SeriesImportError(f"Series folder already exists; resolve before importing: {_rel(root, series_dir)}")
    inputs = [{"path": str(p), "sha256": item["metadata"]["source_sha256"]}
              for p, item in zip(paths, parsed)]
    fingerprint = json.dumps([pseudonym, series_name, inputs], ensure_ascii=False, separators=(",", ":"))
    sid = hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:20]
    sdir = _session_dir(root, sid)
    session_path = sdir / "session.json"
    if session_path.exists():
        old = _json(session_path)
        if old.get("input_fingerprint") == fingerprint:
            return _session_result(root, old)
        raise SeriesImportError("Import session ID collision")

    author_created = not author_dir.exists()
    before = _baseline(root)
    created: list[Path] = []
    try:
        series_dir.mkdir(parents=True, exist_ok=False)
        source_dir = series_dir / "00 Источники"
        (source_dir / "Изображения").mkdir(parents=True)
        for name in ("01 Книги", "03 Сущности", "04 Анализ", "05 Индексы", "99 Проверка"):
            (series_dir / name).mkdir()
        if author_created:
            author_dir.mkdir(parents=True, exist_ok=True)
            _atomic_write(author_dir / "00 Профиль автора.md",
                          f"---\ntype: author-profile\nsetup_status: draft\ncanon_status: draft\n---\n\n"
                          f"# {pseudonym}\n\nПсевдоним указан автором. Профиль ожидает заполнения и подтверждения.\n")
        author_hub = author_dir / "00 Автор.md"
        intentional_updates: dict[str, str] = {}
        series_link = f"- [[{series_name}/00 Паспорт серии]]"
        if not author_hub.exists():
            if author_created:
                _atomic_write(author_hub, f"# {pseudonym}\n\n## Серии\n\n{series_link}\n")
        else:
            old_hub = author_hub.read_text(encoding="utf-8")
            if series_link not in old_hub:
                updated_hub = old_hub.rstrip() + "\n\n" + series_link + "\n"
                _atomic_write(author_hub, updated_hub)
                intentional_updates[_rel(root, author_hub)] = _sha(updated_hub.encode("utf-8"))
        corpus_index = {"author_pseudonym": pseudonym, "series": series_name, "books": []}
        corpus_map = {}
        for idx, (source_path, item, book_title) in enumerate(zip(paths, parsed, book_titles), 1):
            book_id = f"B{idx:02d}"
            book_dir = series_dir / "01 Книги" / book_title
            (book_dir / "02 Сцены").mkdir(parents=True)
            source_name = f"{book_id} - {book_title}.fb2"
            dest_source = source_dir / source_name
            dest_source.write_bytes(item["raw"])
            corpus = item["corpus"]
            corpus["book_id"] = book_id
            for chapter in corpus["chapters"]:
                chapter["source_path"] = f"00 Источники/{book_id}/{chapter['id']}.md"
            corpus_rel = f"00 Источники/{book_id} - корпус.json"
            _write_json(series_dir / corpus_rel, corpus)
            for chapter in corpus["chapters"]:
                chapter_note = ["---\ntype: note\nrecord_kind: source-chapter\n",
                                f"book_id: {book_id}\nchapter_id: {chapter['id']}\n---\n\n",
                                f"# {chapter['title'] or chapter['id']}\n"]
                for block in chapter["blocks"]:
                    chapter_note.append(f"\n## {block['id']}\n\n{block['text'] or '(изображение без текста)'}\n")
                    for image_id in block["image_ids"]:
                        image = next(x for x in corpus["images"] if x["id"] == image_id)
                        if image.get("relative_path"):
                            chapter_note.append(f"\n![[../Изображения/{image_id}{Path(image['relative_path']).suffix}]]\n")
                        else:
                            chapter_note.append(f"\nИзображение `{image_id}`: бинарный оригинал отсутствует в исходнике.\n")
                _atomic_write(_inside(root, series_dir / chapter["source_path"]), "".join(chapter_note))
            for image in corpus["images"]:
                image_bytes = item["image_bytes"].get(image["id"])
                if image_bytes is not None:
                    out = series_dir / image["relative_path"]
                    out.parent.mkdir(parents=True, exist_ok=True)
                    out.write_bytes(image_bytes)
            _atomic_write(book_dir / "00 Навигация.md",
                          f"---\ntype: book\ntitle: {book_title}\nseries: \"[[../00 Паспорт серии]]\"\n"
                          f"canon_status: draft\nsetup_status: draft\n---\n\n# {book_title}\n\n"
                          f"Источник: [[../../00 Источники/{book_id} - {book_title}]]\n\n"
                          f"Корпус: [[../../00 Источники/{book_id} - корпус.json]]\n")
            corpus_map[book_id] = corpus
            corpus_index["books"].append({"book_id": book_id, "title": book_title,
                "source_author": item["metadata"]["source_author"],
                "source_path": str(source_path), "source_sha256": item["metadata"]["source_sha256"],
                "source_file": f"00 Источники/{source_name}", "corpus_file": corpus_rel,
                "chapter_files": [chapter["source_path"] for chapter in corpus["chapters"]],
                "series_number": item["metadata"]["series_number"],
                "chapter_count": len(corpus["chapters"]), "block_count": corpus["body_block_count"],
                "image_count": len(corpus["images"])})
        _write_json(source_dir / "corpus-index.json", corpus_index)
        sdir.mkdir(parents=True, exist_ok=True)
        prepared_paths = sorted(set(_baseline(root)) - set(before))
        prepared_hashes = {rel: _sha((root / rel).read_bytes()) for rel in prepared_paths}
        session = {"session_id": sid, "status": "prepared_for_analysis", "author_pseudonym": pseudonym,
            "series_name": series_name, "series_path": _rel(root, series_dir), "input_fingerprint": fingerprint,
            "inputs": inputs, "books": corpus_index["books"], "baseline": before,
            "prepared_paths": prepared_paths,
            "prepared_hashes": prepared_hashes,
            "intentional_baseline_updates": intentional_updates,
            "candidate_files": [], "candidate_sha256": None, "created_files": [],
            "active_manifest_before": None, "corpus": corpus_map}
        _write_json(session_path, session)
        return _session_result(root, session)
    except Exception:
        # The series path was preflighted as new. Remove only files/directories
        # created by this failed prepare, never anything that predated it.
        if series_dir.exists():
            shutil.rmtree(series_dir, ignore_errors=True)
        if author_created and author_dir.exists():
            shutil.rmtree(author_dir, ignore_errors=True)
        if sdir.exists():
            shutil.rmtree(sdir, ignore_errors=True)
        raise


def _session_result(root: Path, session: dict[str, Any]) -> dict[str, Any]:
    return {"status": session["status"], "session_id": session["session_id"],
        "author_pseudonym": session["author_pseudonym"], "series_name": session["series_name"],
        "series_path": session["series_path"], "source_path": f"{session['series_path']}/00 Источники",
        "corpus_index_path": f"{session['series_path']}/00 Источники/corpus-index.json",
        "analysis_paths": {name: f"{session['series_path']}/04 Анализ/{slug}.md"
                           for name, slug in LAYERS.items()},
        "independent_review_path": f".talewisp/imports/{session['session_id']}/independent-review.json",
        "books": [{k: v for k, v in b.items() if k in {"book_id", "title", "source_author", "chapter_count", "block_count", "image_count", "corpus_file", "chapter_files"}}
                  for b in session["books"]], "next_action": "finalize" if session["status"] == "prepared_for_analysis" else session["status"]}


def _evidence_ok(root: Path, series_path: Path, corpus: dict[str, Any], transcripts: dict[str, str], evidence: Any) -> None:
    if not isinstance(evidence, list) or not evidence:
        raise SeriesImportError("Every supported claim needs literal evidence")
    blocks = {b["id"]: b["text"] for item in corpus.values() for b in item["blocks"]}
    for ref in evidence:
        if not isinstance(ref, dict) or not isinstance(ref.get("quote"), str) or not ref["quote"].strip():
            raise SeriesImportError("Evidence entries require a literal quote and block_id or image_id")
        quote = ref["quote"]
        if ref.get("block_id"):
            text = blocks.get(ref["block_id"])
        elif ref.get("image_id"):
            text = transcripts.get(ref["image_id"])
        else:
            text = None
        if text is None or quote not in text:
            raise SeriesImportError(f"Evidence quote does not match corpus or image transcript: {quote[:80]!r}")


def _validate_analysis(session: dict[str, Any], analysis: dict[str, Any]) -> None:
    corpus = session["corpus"]
    expected_blocks = {bid: {ch["id"]: [b["id"] for b in ch["blocks"]] for ch in item["chapters"]}
                       for bid, item in corpus.items()}
    expected_images = {bid: {ch["id"]: [image_id for block in ch["blocks"] for image_id in block["image_ids"]]
                            for ch in item["chapters"]} for bid, item in corpus.items()}
    expected_book_blocks = {
        bid: [block_id for chapter in item["chapters"] for block_id in expected_blocks[bid][chapter["id"]]]
        for bid, item in corpus.items()
    }
    seen_chapters = set()
    book_blocks: dict[str, list[str]] = {bid: [] for bid in corpus}
    for row in analysis.get("read_chapters", []):
        bid = row.get("book_id")
        if bid not in corpus or row.get("chapter_id") not in expected_blocks[bid]:
            raise SeriesImportError("read_chapters contains an unknown book_id or chapter_id")
        chapter_id = row["chapter_id"]
        key = (bid, chapter_id)
        if key in seen_chapters:
            raise SeriesImportError(f"Duplicate read_chapters entry for {bid}/{chapter_id}")
        seen_chapters.add(key)
        if row.get("block_ids") != expected_blocks[bid][chapter_id]:
            raise SeriesImportError(f"Chapter block sequence does not exactly match source for {bid}/{chapter_id}")
        book_blocks[bid].extend(row["block_ids"])
        actual_image_occurrences = list(row.get("images_read", [])) + list(row.get("images_uncertain", []))
        expected_occurrences = expected_images[bid][chapter_id]
        if Counter(actual_image_occurrences) != Counter(expected_occurrences):
            raise SeriesImportError(f"Chapter image occurrences do not exactly match source for {bid}/{chapter_id}")
    expected_chapters = {(bid, chapter_id) for bid, chapters in expected_blocks.items() for chapter_id in chapters}
    if seen_chapters != expected_chapters:
        raise SeriesImportError("read_chapters must include every source chapter exactly once")
    for bid, chapters in expected_blocks.items():
        source_order = [block for chapter in corpus[bid]["chapters"] for block in chapters[chapter["id"]]]
        if book_blocks[bid] != source_order:
            raise SeriesImportError(f"Chapter reading does not preserve full source order for {bid}")
    transcripts = {}
    transcript_rows = analysis.get("image_transcripts", [])
    for row in transcript_rows:
        if row.get("status") not in {"read", "uncertain"}:
            raise SeriesImportError("Image transcript status must be read or uncertain")
        if row.get("status") == "read":
            transcripts[row["image_id"]] = str(row.get("transcript") or "")
    expected_image_ids = {image["id"] for item in corpus.values() for image in item["images"]}
    transcript_ids = [row.get("image_id") for row in transcript_rows]
    if set(transcript_ids) != expected_image_ids or len(transcript_ids) != len(expected_image_ids):
        raise SeriesImportError("image_transcripts must account for every imported image exactly once")

    scene_coverage = {bid: [] for bid in corpus}
    scene_ids = set()
    scene_required = ("title", "participants", "place", "time", "action", "result", "emotional_shift", "new_information")
    for scene in analysis.get("scenes", []):
        sid = scene.get("id")
        bid = scene.get("book_id")
        if not sid or sid in scene_ids or bid not in corpus:
            raise SeriesImportError("Scenes require unique id and a valid book_id")
        _component(str(sid), "scene id")
        scene_ids.add(sid)
        if any(scene.get(k) in (None, "", []) for k in scene_required):
            raise SeriesImportError(f"Scene {sid} is missing a required semantic field")
        blocks = scene.get("block_ids")
        if not isinstance(blocks, list) or not blocks:
            raise SeriesImportError(f"Scene {sid} must cite its complete block_ids")
        scene_coverage[bid].extend(blocks)
        _evidence_ok(Path("."), Path("."), corpus, transcripts, scene.get("evidence"))
    for bid in corpus:
        if set(scene_coverage[bid]) != set(expected_book_blocks[bid]) or len(scene_coverage[bid]) != len(expected_book_blocks[bid]):
            raise SeriesImportError(f"Scene partition does not cover every source block exactly once for {bid}")
    for event in analysis.get("events", []):
        if event.get("scene_id") not in scene_ids or any(not event.get(k) for k in ("cause", "consequence", "story_time")):
            raise SeriesImportError("Events require an existing scene, cause, consequence, and story_time")
        _evidence_ok(Path("."), Path("."), corpus, transcripts, event.get("evidence"))
    entity_names = set()
    for entity in analysis.get("entities", []):
        if not isinstance(entity.get("name"), str) or not entity["name"]:
            raise SeriesImportError("Entity canonical name must be a non-empty string")
        if entity["name"].casefold() in entity_names:
            raise SeriesImportError("Entity names must be unique within the shared series base")
        entity_names.add(entity["name"].casefold())
        required = ("name", "kind", "definition", "facts", "basis", "status", "scope", "valid_from", "valid_until")
        if any(k not in entity for k in required) or entity.get("status") not in {"supported", "uncertain", "unknown", "contradicted"}:
            raise SeriesImportError("Entities require definition, facts, source basis, status, scope, and temporal bounds")
        if entity["status"] == "supported":
            _evidence_ok(Path("."), Path("."), corpus, transcripts, entity.get("evidence"))
    for rule in analysis.get("rules", []):
        if any(k not in rule for k in ("name", "price", "limits", "exceptions", "status")):
            raise SeriesImportError("Rules require price, limits, exceptions, and status")
        if rule["status"] == "supported":
            _evidence_ok(Path("."), Path("."), corpus, transcripts, rule.get("evidence"))
    for thread in analysis.get("threads", []):
        if any(k not in thread for k in ("book_number", "name", "goal", "conflict", "stakes", "state", "setups", "payoffs", "status")):
            raise SeriesImportError("Plot threads require book number, goal, conflict, stakes, state, setups, payoffs, and status")
        if thread["status"] not in {"supported", "uncertain", "unknown"}:
            raise SeriesImportError("Plot-thread status must be supported, uncertain, or unknown")
        if thread["status"] == "supported":
            _evidence_ok(Path("."), Path("."), corpus, transcripts, thread.get("evidence"))
    for item in analysis.get("knowledge", []):
        if any(k not in item for k in ("fact", "holder", "mode", "learned_at", "how", "objective_status", "valid_until")):
            raise SeriesImportError("Knowledge entries require holder, learning point, mode, and temporal validity")
        if item.get("objective_status") == "supported":
            _evidence_ok(Path("."), Path("."), corpus, transcripts, item.get("evidence"))
    for item in analysis.get("style", []):
        if any(k not in item for k in ("observation", "scope", "examples", "exceptions", "status")):
            raise SeriesImportError("Style observations require scope, examples, exceptions, and status")
        if item.get("status") == "supported":
            _evidence_ok(Path("."), Path("."), corpus, transcripts, item.get("evidence"))
    shared = analysis.get("shared_layers")
    if not isinstance(shared, dict) or set(shared) != set(LAYERS):
        raise SeriesImportError("shared_layers must provide the nine named shared analysis layers")
    for name, layer in shared.items():
        if layer.get("status") not in {"supported", "uncertain", "unknown"}:
            raise SeriesImportError(f"Shared layer {name} needs supported, uncertain, or unknown status")
        if layer["status"] == "supported":
            _evidence_ok(Path("."), Path("."), corpus, transcripts, layer.get("evidence"))


def _md(text: Any) -> str:
    if isinstance(text, list):
        return ", ".join(str(x) for x in text) if text else "—"
    return str(text) if text not in (None, "") else "—"


def _display_name(value: Any) -> str:
    """Render canonical display text safely outside Obsidian link syntax."""
    text = str(value)
    escaped = html.escape(text, quote=False).replace("[[", "&#91;&#91;").replace("]]", "&#93;&#93;")
    return escaped.replace("\r\n", "<br>").replace("\r", "<br>").replace("\n", "<br>")


def _evidence_lines(evidence: list[dict[str, Any]], *, up: int = 1) -> str:
    lines = []
    source_root = "../" * up + "00 Источники"
    for item in evidence:
        ref = item.get("block_id") or item.get("image_id")
        if item.get("block_id"):
            book_id = item["block_id"].split("-", 1)[0]
            chapter_id = item["block_id"].rsplit("-P", 1)[0]
            target = f"{source_root}/{book_id}/{chapter_id}.md#{item['block_id']}"
        else:
            target = f"{source_root}/Изображения/{ref}"
        lines.append(f"- [[{target}|{ref}]]: “{item['quote']}”")
    return "\n".join(lines)


def _render(session: dict[str, Any], analysis: dict[str, Any]) -> dict[str, str]:
    base = session["series_path"]
    files: dict[str, str] = {}
    files[f"{base}/00 Паспорт серии.md"] = (
        f"---\ntype: series\ntitle: {session['series_name']}\ncanon_status: draft\nsetup_status: draft\n---\n\n"
        f"# {session['series_name']}\n\n{_md(analysis['shared_layers']['series_passport'].get('summary'))}\n\n"
        "## Книги\n\n" + "\n".join(f"- [[01 Книги/{b['title']}/00 Навигация]]" for b in session["books"]) + "\n")
    for key, title in LAYERS.items():
        layer = analysis["shared_layers"][key]
        evidence = _evidence_lines(layer.get("evidence", [])) if layer.get("evidence") else "- Нет подтверждённых цитат"
        files[f"{base}/04 Анализ/{title}.md"] = (
            f"---\ntype: note\nrecord_kind: {key}\nstatus: {layer['status']}\n---\n\n"
            f"# {title}\n\n{_md(layer.get('summary'))}\n\n## Источники\n\n{evidence}\n")
    entity_names = {}
    for i, entity in enumerate(analysis.get("entities", []), 1):
        slug = f"E{i:04d}"
        entity_names[entity["name"]] = slug
        facts = entity.get("facts", [])
        fact_lines = "\n".join(f"- {x}" for x in facts) if facts else "- Нет подтверждённых фактов"
        canonical_name = json.dumps(entity["name"], ensure_ascii=False)
        files[f"{base}/03 Сущности/{slug}.md"] = (
            f"---\ntype: note\nrecord_kind: entity\nid: {slug}\ntitle: {canonical_name}\nstatus: {entity['status']}\nscope: {entity['scope']}\n"
            f"valid_from: {entity['valid_from']}\nvalid_until: {entity['valid_until']}\n---\n\n"
            f"<h1>{_display_name(entity['name'])}</h1>\n\n{entity['definition']}\n\n## Факты\n\n{fact_lines}\n\n"
            f"## Основание и источники\n\n{entity['basis']}\n\n"
            f"{_evidence_lines(entity.get('evidence', [])) if entity.get('evidence') else 'Не подтверждено источником.'}\n")
    glossary = []
    for name, slug in entity_names.items():
        entity = next(item for item in analysis["entities"] if item["name"] == name)
        glossary.append(f"- [[../03 Сущности/{slug}]] — {_display_name(name)}: {entity['definition']}")
    files[f"{base}/04 Анализ/Глоссарий.md"] += "\n## Термины и карточки\n\n" + ("\n".join(glossary) or "Пока нет извлечённых терминов.") + "\n"
    rule_rows = []
    for rule in analysis.get("rules", []):
        evidence = _evidence_lines(rule.get("evidence", [])) if rule.get("evidence") else "Не подтверждено источником."
        rule_rows.append(f"### {rule['name']} ({rule['status']})\n\n- Цена: {_md(rule['price'])}\n- Пределы: {_md(rule['limits'])}\n- Исключения: {_md(rule['exceptions'])}\n\n{evidence}")
    files[f"{base}/04 Анализ/Правила и цены.md"] += "\n## Извлечённые правила\n\n" + ("\n\n".join(rule_rows) or "Правила не подтверждены корпусом.") + "\n"
    style_rows = []
    for item in analysis.get("style", []):
        evidence = _evidence_lines(item.get("evidence", [])) if item.get("evidence") else "Не подтверждено источником."
        style_rows.append(f"### {item['observation']} ({item['status']})\n\n- Область: {item['scope']}\n- Примеры: {_md(item['examples'])}\n- Исключения: {_md(item['exceptions'])}\n\n{evidence}")
    files[f"{base}/04 Анализ/Стиль источника.md"] += "\n## Наблюдения\n\n" + ("\n\n".join(style_rows) or "Наблюдения не подтверждены корпусом.") + "\n"
    knowledge_rows = []
    for item in analysis.get("knowledge", []):
        evidence = _evidence_lines(item.get("evidence", [])) if item.get("evidence") else "Не подтверждено источником."
        knowledge_rows.append(f"### {item['fact']}\n\n- Персонаж: {item['holder']}\n- Объективный статус: {item['objective_status']}\n- Способ знания: {item['mode']}\n- Узнал в: {item['learned_at']}\n- Как узнал: {item['how']}\n- Действует до: {item['valid_until']}\n- Доступ читателя: {_md(item.get('reader_access'))}\n\n{evidence}")
    files[f"{base}/04 Анализ/Знания персонажей.md"] += "\n## Реестр знаний\n\n" + ("\n\n".join(knowledge_rows) or "Подтверждённые знания не извлечены.") + "\n"
    event_rows = []
    scenes = {scene["id"]: scene for scene in analysis.get("scenes", [])}
    order = 0
    for event in analysis.get("events", []):
        order += 1
        scene = scenes[event["scene_id"]]
        book_title = next(b["title"] for b in session["books"] if b["book_id"] == scene["book_id"])
        evidence = _evidence_lines(event.get("evidence", [])) if event.get("evidence") else "Не подтверждено источником."
        event_rows.append(f"### Порядок повествования {order}: {event['story_time']}\n\n"
            f"- Время истории: {event['story_time']}\n- Сцена: [[../01 Книги/{book_title}/02 Сцены/{scene['id']}|{scene['title']}]]\n"
            f"- Причина: {event['cause']}\n- Следствие: {event['consequence']}\n\n{evidence}")
    files[f"{base}/04 Анализ/Хронология.md"] += "\n## События по порядку повествования\n\n" + ("\n\n".join(event_rows) or "События не размечены.") + "\n"
    uncertainties = []
    for item in analysis.get("contradictions", []):
        uncertainties.append(f"### Противоречие\n\n{_md(item)}")
    for item in analysis.get("open_questions", []):
        uncertainties.append(f"### Открытый вопрос\n\n{_md(item)}")
    files[f"{base}/99 Проверка/Неопределённости и противоречия.md"] = (
        "---\ntype: note\nrecord_kind: import-uncertainties\nstatus: draft\n---\n\n# Неопределённости и противоречия\n\n" +
        ("\n\n".join(uncertainties) if uncertainties else "Явные противоречия и открытые вопросы не указаны.") + "\n")
    for book in session["books"]:
        bid, title = book["book_id"], book["title"]
        book_root = f"{base}/01 Книги/{title}"
        threads = [x for x in analysis.get("threads", []) if str(x.get("book_number")) in {bid, bid[1:], str(int(bid[1:]))}]
        thread_lines = []
        for i, t in enumerate(threads, 1):
            thread_lines.append(f"### {i}. {t['name']}\n\n- Цель: {t['goal']}\n- Конфликт: {t['conflict']}\n- Ставки: {t['stakes']}\n- Состояние: {t['state']}\n- Завязки: {_md(t['setups'])}\n- Выплаты: {_md(t['payoffs'])}")
        files[f"{book_root}/01 Сюжет.md"] = (
            f"---\ntype: note\nrecord_kind: book-plot\nbook: {bid}\nstatus: draft\n---\n\n"
            f"# Сюжет книги: {title}\n\n" + ("\n\n".join(thread_lines) if thread_lines else "Для этой книги не указаны сюжетные линии.") + "\n")
        for scene in (x for x in analysis.get("scenes", []) if x["book_id"] == bid):
            evidence = _evidence_lines(scene["evidence"], up=3)
            related = "\n".join(f"- [[../../../03 Сущности/{entity_names[n]}]] — {_display_name(n)}" for n in scene["participants"] if n in entity_names) or "- —"
            rel = f"02 Сцены/{scene['id']}.md"
            files[f"{book_root}/{rel}"] = (
                f"---\ntype: note\nrecord_kind: scene-analysis\nbook: {bid}\nscene_id: {scene['id']}\n"
                f"source_blocks: [{', '.join(scene['block_ids'])}]\nstatus: draft\n---\n\n"
                f"# {scene['title']}\n\n- Участники: {_md(scene['participants'])}\n- Место: {scene['place']}\n"
                f"- Время истории: {scene['time']}\n- Действие: {scene['action']}\n- Результат: {scene['result']}\n"
                f"- Эмоциональный сдвиг: {scene['emotional_shift']}\n- Новая информация: {scene['new_information']}\n\n"
                f"## Сущности\n\n{related}\n\n## Источники\n\n{evidence}\n")
        nav = f"{book_root}/00 Навигация.md"
        files[nav] = files.get(nav, "") + f"\n## Сюжет и сцены\n\n[[01 Сюжет]]\n\n" + "\n".join(
            f"- [[02 Сцены/{s['id']}|{s['title']}]]" for s in analysis["scenes"] if s["book_id"] == bid) + "\n"
    # Shared cross-book indexes use links so book-local plots remain book-specific.
    files[f"{base}/05 Индексы/Хронология-книг.md"] = (
        "---\ntype: note\nrecord_kind: chronology-index\nstatus: draft\n---\n\n# События и книги\n\n" +
        "\n".join(f"- {e['story_time']}: [[../01 Книги/{next(b['title'] for b in session['books'] if any(s['id']==e['scene_id'] and s['book_id']==b['book_id'] for s in analysis['scenes']) )}/02 Сцены/{e['scene_id']}|{e['scene_id']}]] — {e['consequence']}" for e in analysis.get("events", [])) + "\n")
    return files


def _file_hashes(files: dict[str, str]) -> dict[str, str]:
    return {path: _sha(text.encode("utf-8")) for path, text in sorted(files.items())}


def _wiki_link_errors(root: Path, session: dict[str, Any]) -> list[str]:
    candidate = session["candidate_files"]
    known = set(session["baseline"]) | set(session.get("prepared_paths", [])) | set(candidate)
    contents: dict[str, str] = dict(candidate)
    for rel in known - set(contents):
        path = root / rel
        if path.is_file() and path.suffix.lower() == ".md":
            try:
                contents[rel] = path.read_text(encoding="utf-8")
            except OSError:
                pass
    errors = []
    for source, text in candidate.items():
        for target, anchor in EVIDENCE_RE.findall(text):
            normalized = posixpath.normpath(posixpath.join(posixpath.dirname(source), target.replace("\\", "/")))
            candidates = [normalized]
            if not Path(normalized).suffix:
                candidates.append(normalized + ".md")
                candidates.extend(rel for rel in known if posixpath.splitext(rel)[0] == normalized)
            matches = [rel for rel in dict.fromkeys(candidates) if rel in known]
            if len(matches) != 1:
                errors.append(f"{source}: unresolved or ambiguous wikilink {target}")
                continue
            if anchor:
                target_text = contents.get(matches[0], "")
                headings = {line.lstrip("# ").strip().casefold() for line in target_text.splitlines() if line.startswith("#")}
                if anchor.strip().lstrip("^").casefold() not in headings:
                    errors.append(f"{source}: missing anchor {anchor} in {matches[0]}")
    return errors


def _finalize(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    sid = str(args.get("session_id") or "")
    sdir = _session_dir(root, sid)
    session = _json(sdir / "session.json")
    if session.get("status") == "complete":
        return _session_result(root, session)
    if session.get("status") not in {"prepared_for_analysis", "candidate_ready_for_review"}:
        raise SeriesImportError(f"Session cannot finalize from status {session.get('status')}")
    analysis_rel = str(args.get("analysis_path") or "")
    analysis_path = _inside(root, root / analysis_rel)
    if not analysis_path.is_file() or not analysis_path.resolve().is_relative_to(sdir.resolve()):
        raise SeriesImportError("analysis_path must point to analysis.json under this session directory")
    analysis = _json(analysis_path)
    _validate_analysis(session, analysis)
    files = _render(session, analysis)
    candidate_root = sdir / "candidate"
    candidate_root.mkdir(parents=True, exist_ok=True)
    for relative_path, text in files.items():
        out = _inside(candidate_root, candidate_root / "files" / relative_path)
        _atomic_write(out, text)
    hashes = _file_hashes(files)
    candidate_sha = _sha(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    session.update({"status": "candidate_ready_for_review", "candidate_files": files,
                    "candidate_hashes": hashes, "candidate_sha256": candidate_sha,
                    "analysis_sha256": _sha(analysis_path.read_bytes()), "created_files": []})
    _write_json(sdir / "candidate-manifest.json", {"candidate_sha256": candidate_sha,
        "files": hashes, "status": "candidate_ready_for_review"})
    _write_json(sdir / "session.json", session)
    return {"status": session["status"], "session_id": sid, "series_path": session["series_path"],
            "candidate_sha256": candidate_sha, "candidate_files": list(hashes),
            "candidate_paths": {canonical: f".talewisp/imports/{sid}/candidate/files/{canonical}" for canonical in hashes},
            "candidate_manifest_path": f".talewisp/imports/{sid}/candidate-manifest.json",
            "independent_review_path": f".talewisp/imports/{sid}/independent-review.json", "next_action": "check"}


def _check(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    sid = str(args.get("session_id") or "")
    sdir = _session_dir(root, sid)
    session = _json(sdir / "session.json")
    if session.get("status") != "candidate_ready_for_review":
        raise SeriesImportError("No review candidate exists; finalize semantic analysis first")
    drift = {}
    intentional_updates = session.get("intentional_baseline_updates", {})
    for path, expected in session["baseline"].items():
        target = root / path
        if not target.is_file():
            drift[path] = "missing"
            continue
        actual = _sha(target.read_bytes())
        if actual != expected and actual != intentional_updates.get(path):
            drift[path] = actual
    new_base_paths = set(_baseline(root)) - set(session["baseline"])
    unexpected_new = sorted(new_base_paths - set(session.get("prepared_paths", [])))
    bad_candidate = []
    for rel, expected_hash in session.get("prepared_hashes", {}).items():
        prepared = root / rel
        if not prepared.is_file() or _sha(prepared.read_bytes()) != expected_hash:
            bad_candidate.append(f"prepared source/scaffold changed: {rel}")
    files = session["candidate_files"]
    if _file_hashes(files) != session["candidate_hashes"]:
        bad_candidate.append("candidate hashes changed")
    for canonical, expected_hash in session["candidate_hashes"].items():
        staged = _inside(root, sdir / "candidate" / "files" / canonical)
        if not staged.is_file() or _sha(staged.read_bytes()) != expected_hash:
            bad_candidate.append(f"staged candidate changed: {canonical}")
    bad_candidate.extend(_wiki_link_errors(root, session))
    source_errors = []
    for source in session["inputs"]:
        try:
            if _sha(Path(source["path"]).read_bytes()) != source["sha256"]:
                source_errors.append(source["path"])
        except OSError:
            source_errors.append(source["path"])
    series = _inside(root, root / session["series_path"])
    active = series / "05 Индексы" / "active-import.json"
    if active.exists() != bool(session.get("active_manifest_before")):
        bad_candidate.append("active manifest state changed")
    issues = {"baseline_drift": sorted(drift), "unexpected_new_paths": unexpected_new,
              "candidate_errors": bad_candidate, "source_errors": source_errors}
    passed = not any(issues.values())
    machine = {"status": "PASS" if passed else "FAIL", "session_id": sid,
              "candidate_sha256": session["candidate_sha256"], "issues": issues}
    machine_path = sdir / "machine-checks.json"
    _write_json(machine_path, machine)
    return {"status": "PASS" if passed else "FAIL", "session_id": sid,
            "candidate_sha256": session["candidate_sha256"],
            "machine_checks_path": _rel(root, machine_path),
            "independent_review_path": f".talewisp/imports/{sid}/independent-review.json",
            "issues": issues, "next_action": "independent_review" if passed else "resolve_issues"}


def _accept(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    sid = str(args.get("session_id") or "")
    sdir = _session_dir(root, sid)
    session = _json(sdir / "session.json")
    if session.get("status") == "complete":
        return _session_result(root, session)
    if session.get("status") != "candidate_ready_for_review":
        raise SeriesImportError("Only a checked candidate can be accepted")
    review_path = _inside(root, root / str(args.get("review_path") or ""))
    expected_review_path = (sdir / "independent-review.json").resolve()
    if review_path != expected_review_path:
        raise SeriesImportError("review_path must name the independent-review.json for this session")
    if not review_path.is_file():
        raise SeriesImportError("Independent review is required before accepting the candidate")
    review = _json(review_path)
    if (review.get("status") != "PASS" or review.get("review_type") != "independent"
            or review.get("session_id") != sid or review.get("candidate_sha256") != session["candidate_sha256"]):
        raise SeriesImportError("Review is missing, failed, or stale for this candidate")
    # Re-run core drift/source checks at the commit boundary.
    checked = _check(root, {"session_id": sid})
    if checked["status"] != "PASS" or checked["candidate_sha256"] != review["candidate_sha256"]:
        raise SeriesImportError("Candidate changed after review; check again")
    series = _inside(root, root / session["series_path"])
    dests = {path: _inside(series, root / path) for path in session["candidate_files"]}
    active_path = series / "05 Индексы" / "active-import.json"
    prepared_hashes = session.get("prepared_hashes", {})
    conflicting = []
    for rel, path in dests.items():
        if path.exists():
            expected = prepared_hashes.get(rel)
            if expected is None or _sha(path.read_bytes()) != expected:
                conflicting.append(rel)
    if active_path.exists() or conflicting:
        raise SeriesImportError("A candidate destination already exists; refusing to overwrite material")
    created = []
    try:
        for rel, text in session["candidate_files"].items():
            dest = dests[rel]
            _atomic_write(dest, text)
            created.append(dest)
        manifest = {"status": "complete", "session_id": sid,
                    "candidate_sha256": session["candidate_sha256"],
                    "files": session["candidate_hashes"], "accepted_review": _rel(root, review_path)}
        _write_json(active_path, manifest)
        created.append(active_path)
    except Exception:
        for path in created:
            try:
                path.unlink()
            except OSError:
                pass
        raise
    session["status"] = "complete"
    session["created_files"] = [_rel(root, p) for p in created]
    session["accepted_review"] = _rel(root, review_path)
    _write_json(sdir / "session.json", session)
    return _session_result(root, session) | {"active_manifest_path": _rel(root, active_path), "candidate_sha256": session["candidate_sha256"]}


def _status(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    sid = str(args.get("session_id") or "")
    session = _json(_session_dir(root, sid) / "session.json")
    return _session_result(root, session) | {"candidate_sha256": session.get("candidate_sha256"),
        "machine_checks_path": f".talewisp/imports/{sid}/machine-checks.json" if session.get("candidate_sha256") else None}


def build_series_base(root: Path, args: dict[str, Any]) -> dict[str, Any]:
    """Run one import state-machine action against an active TaleWisp vault."""
    action = str(args.get("action") or "start").casefold()
    # This branch deliberately returns before resolving, stat'ing, or reading root.
    if action in {"start", "files"}:
        return _initial(args)
    vault = Path(root).expanduser().resolve()
    if action == "prepare":
        return _prepare(vault, args)
    if action == "status":
        return _status(vault, args)
    if action == "finalize":
        return _finalize(vault, args)
    if action == "check":
        return _check(vault, args)
    if action == "accept":
        return _accept(vault, args)
    raise SeriesImportError(f"Unknown import action: {action}")
