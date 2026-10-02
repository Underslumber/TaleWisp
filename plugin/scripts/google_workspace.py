"""Pure Google Workspace helpers. Authentication and all cloud I/O belong to Drive.

Snapshots are full get_document structuredContent wrapped as
{document: ..., complete: true}. Comments are {document_id: ..., complete: true,
pages: [{page_token: null, comments: [...], nextPageToken: ...}, ...]}.
Completeness is an explicit caller receipt, never inferred from a short response.
Existing manuscript edits default to native-suggestion plans without mutation payloads.
Only explicit direct_edit mode generates a DIRECT EDIT batchUpdate payload.
"""
from __future__ import annotations

import copy
import hashlib
import json
from urllib.parse import quote as urlquote


class GoogleWorkspaceError(ValueError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def contains_opaque_marker(text):
    return any(0xE000 <= ord(c) <= 0xF8FF or 0xF0000 <= ord(c) <= 0xFFFFD
               or 0x100000 <= ord(c) <= 0x10FFFD for c in text)


def require(condition, message):
    if not condition:
        raise GoogleWorkspaceError(message)


def doc_link(document_id, tab_id=None):
    url = "https://docs.google.com/document/d/" + urlquote(document_id, safe="") + "/edit"
    return url + ("?tab=" + urlquote(tab_id, safe="") if tab_id else "")


def normalize_document(args):
    """Retain raw structures as well as indexed, editable body paragraphs."""
    snapshot = args["snapshot"]
    document = snapshot.get("document")
    require(isinstance(document, dict), "snapshot.document must be the full document object")
    document_id = document.get("documentId")
    require(isinstance(document_id, str) and document_id, "Missing documentId")
    tabs, seen = [], set()

    def walk_content(content, paragraphs, controls, path):
        require(isinstance(content, list), "Body content must be a structural-element array")
        for position, item in enumerate(content):
            location = path + [position]
            if "paragraph" in item:
                paragraph = item["paragraph"]
                runs = []
                for element in paragraph.get("elements", []):
                    start, end = element.get("startIndex"), element.get("endIndex")
                    text_run = element.get("textRun")
                    text = text_run.get("content", "") if text_run else None
                    suggestion = any("suggest" in key.lower() and value
                                     for node in (paragraph, element, text_run or {}) for key, value in node.items())
                    protected = text_run is None or suggestion or contains_opaque_marker(text or "") or any(
                        key in element for key in ("person", "richLink", "inlineObjectElement", "autoText", "footnoteReference"))
                    valid = (isinstance(start, int) and isinstance(end, int) and
                             isinstance(text, str) and end - start == utf16_length(text))
                    run = {"start_index": start, "end_index": end, "text": text,
                           "text_style": copy.deepcopy((text_run or {}).get("textStyle", {})),
                           "protected": protected or not valid, "suggested": bool(suggestion),
                           "raw": copy.deepcopy(element)}
                    runs.append(run)
                    if run["protected"]:
                        controls.append({"path": location, "start_index": start, "end_index": end,
                                         "kind": "suggestion" if suggestion else "control_or_unsupported_element"})
                paragraphs.append({"path": location, "start_index": item.get("startIndex"),
                                   "end_index": item.get("endIndex"), "text": "".join(r["text"] or "" for r in runs),
                                   "runs": runs, "paragraph_style": copy.deepcopy(paragraph.get("paragraphStyle", {})),
                                   "bullet": copy.deepcopy(paragraph.get("bullet")), "raw": copy.deepcopy(item)})
            elif "table" in item:
                for row_no, row in enumerate(item["table"].get("tableRows", [])):
                    for cell_no, cell in enumerate(row.get("tableCells", [])):
                        walk_content(cell.get("content", []), paragraphs, controls,
                                     location + ["table", row_no, cell_no])
            elif "tableOfContents" in item:
                # Generated TOC text can be read, but should not be overwritten.
                controls.append({"path": location, "start_index": item.get("startIndex"),
                                 "end_index": item.get("endIndex"), "kind": "tableOfContents"})

    def walk_tabs(raw_tabs, parent=None):
        for raw in raw_tabs:
            properties = raw.get("tabProperties", raw)
            tab_id = properties.get("tabId")
            require(isinstance(tab_id, str) and tab_id and tab_id not in seen,
                    "Missing or duplicate tabId; full tabProperties are required")
            seen.add(tab_id)
            data = raw.get("documentTab", raw)
            body = data.get("body") or {}
            paragraphs, controls = [], []
            walk_content(body.get("content", []), paragraphs, controls, ["body"])
            tabs.append({"tab_id": tab_id, "title": properties.get("title", ""),
                         "parent_tab_id": properties.get("parentTabId", parent),
                         "paragraphs": paragraphs, "controls": controls,
                         "body": copy.deepcopy(body),
                         "structures": {key: copy.deepcopy(data.get(key)) for key in
                                        ("headers", "footers", "footnotes", "lists", "namedRanges",
                                         "inlineObjects", "namedStyles", "documentStyle")},
                         "link": doc_link(document_id, tab_id)})
            walk_tabs(raw.get("childTabs", []), tab_id)

    if document.get("tabs"):
        walk_tabs(document["tabs"])
    else:
        require(document.get("body") is not None, "Document has no readable body or tabs")
        # Legacy Docs responses lack tab identity and cannot be used for a tab-safe write.
        paragraphs, controls = [], []
        walk_content(document["body"].get("content", []), paragraphs, controls, ["body"])
        tabs.append({"tab_id": None, "title": document.get("title", ""), "parent_tab_id": None,
                     "paragraphs": paragraphs, "controls": controls,
                     "body": copy.deepcopy(document["body"]), "structures": {}, "link": doc_link(document_id)})
    return {"document_id": document_id, "title": document.get("title", ""),
            "revision_id": document.get("revisionId"), "complete": snapshot.get("complete") is True,
            "suggestions_view_mode": document.get("suggestionsViewMode"), "tabs": tabs,
            "snapshot_sha256": digest(document),
            "raw_document": copy.deepcopy(document),
            "verification": "local normalization of supplied data; no live read or write performed"}


def read_comments(comments, document_id):
    require(comments.get("document_id") == document_id, "Comments belong to another document")
    require(comments.get("complete") is True, "Complete comments read is required")
    pages = comments.get("pages")
    require(isinstance(pages, list) and pages, "Supply every comments page, including an empty final page")
    expected, seen_tokens, threads = None, set(), []
    for number, page in enumerate(pages):
        require(page.get("page_token") == expected, "Comments page token chain is incomplete")
        require(isinstance(page.get("comments"), list), "Each comments page must contain comments array")
        for thread in page["comments"]:
            require(not thread.get("nextPageToken") and not thread.get("repliesNextPageToken"),
                    "Comment replies are incomplete")
            threads.append(copy.deepcopy(thread))
        expected = page.get("nextPageToken") or None
        if expected:
            require(expected not in seen_tokens, "Repeated comments page token")
            seen_tokens.add(expected)
        require(number == len(pages) - 1 or expected is not None, "Extra page after comments pagination ended")
    require(expected is None, "More comments pages must be read before editing")
    return {"threads": threads, "sha256": digest(threads)}


STYLE_FIELDS = {"bold", "italic", "underline", "strikethrough", "smallCaps", "backgroundColor",
                "foregroundColor", "fontSize", "weightedFontFamily", "baselineOffset", "link"}


def plan_edit(args):
    edit_mode = args.get("edit_mode", "native_suggestion")
    require(edit_mode in ("native_suggestion", "direct_edit"), "edit_mode must be native_suggestion or direct_edit")
    normalized = normalize_document(args)
    require(normalized["complete"], "Full untruncated document snapshot is required for editing")
    require(normalized["suggestions_view_mode"] == "SUGGESTIONS_INLINE",
            "Read with SUGGESTIONS_INLINE; alternate suggestion views have unsafe write indexes")
    revision = normalized["revision_id"]
    require(isinstance(revision, str) and revision, "revisionId is required for a safe edit")
    if args.get("expected_revision_id") is not None:
        require(args["expected_revision_id"] == revision, "Stale document revision")
    comments = read_comments(args["comments"], normalized["document_id"])
    tab_id = args["tab_id"]
    tabs = [tab for tab in normalized["tabs"] if tab["tab_id"] == tab_id and tab_id]
    require(len(tabs) == 1, "Select a known tabId from a full document read")
    source, replacement = args["quote"], args["replacement"]
    require(isinstance(source, str) and source and isinstance(replacement, str), "Nonempty quote and text replacement required")
    require(not any(c in source + replacement for c in "\n\r\u2028\u2029"),
            "Bounded edits must stay within one paragraph and preserve paragraph/list boundaries")
    require(not any(ord(c) < 32 for c in replacement), "Control characters are unsupported in replacement")
    require(not contains_opaque_marker(replacement), "Opaque control markers are unsupported in replacement")
    candidates = []
    for paragraph in tabs[0]["paragraphs"]:
        # Search only contiguous native text runs. Controls and gaps break searchable spans.
        groups = []
        for run in paragraph["runs"]:
            if run["protected"]:
                groups.append([])
                continue
            if not groups or not groups[-1] or groups[-1][-1]["end_index"] != run["start_index"]:
                groups.append([])
            groups[-1].append(run)
        for group in groups:
            if not group:
                continue
            text = "".join(run["text"] for run in group)
            offset = 0
            while True:
                offset = text.find(source, offset)
                if offset < 0:
                    break
                start = group[0]["start_index"] + utf16_length(text[:offset])
                end = start + utf16_length(source)
                touched = [r for r in group if r["start_index"] < end and r["end_index"] > start]
                candidates.append((start, end, touched, paragraph))
                offset += 1
    if args.get("start_index") is not None:
        candidates = [c for c in candidates if c[0] == args["start_index"]]
    require(candidates, "Exact quote absent or spans protected/unsupported elements")
    require(len(candidates) == 1, "Duplicate quote: supply explicit UTF-16 start_index to disambiguate")
    start, end, touched, paragraph = candidates[0]
    styles = [r["text_style"] for r in touched]
    require(all(s == styles[0] for s in styles), "Mixed text styles require a narrower edit or a dedicated structural route")
    require(set(styles[0]).issubset(STYLE_FIELDS), "Unsupported text style cannot be faithfully preserved")
    for control in tabs[0]["controls"]:
        cstart, cend = control["start_index"], control["end_index"]
        require(not (isinstance(cstart, int) and isinstance(cend, int) and cstart < end and cend > start),
                "Edit intersects a protected control")
    span = {"startIndex": start, "endIndex": end, "tabId": tab_id}
    operation = {key: args[key] for key in ("tab_id", "quote", "replacement")}
    operation.update(start_index=start, edit_mode=edit_mode)
    result = {"kind": edit_mode, "native_suggestion": edit_mode == "native_suggestion",
              "status": "planned_not_committed", "document_id": normalized["document_id"],
              "revision_id": revision, "snapshot_sha256": normalized["snapshot_sha256"],
              "comments_sha256": comments["sha256"], "operation": operation,
              "paragraph_path": paragraph["path"],
              "source": {"url": tabs[0]["link"], "tab_id": tab_id, "quote": source,
                         "start_index": start, "end_index": end}}
    if edit_mode == "native_suggestion":
        result["native_replacement"] = {"range": span, "original": source, "replacement": replacement,
                                        "text_style": copy.deepcopy(styles[0])}
        result["required_verification"] = [
            "Use only an exposed supported suggestion API; the installed connector lacks writeMode. Browser use requires separate author authorization.",
            "Immediately revalidate full document, revision, exact tab/quote and all comments before saving; replan if they changed.",
            "Verify saved pending insertion/deletion suggestion IDs tied to this original and replacement through supported API readback or authorized editor evidence.",
            "Verify author accept/reject controls, preserved styles, nearby controls and tab structure; changed body text alone is insufficient."]
        result["verification"] = "local native-suggestion plan only; no supported native write performed and no direct mutation payload generated"
    else:
        requests = [{"deleteContentRange": {"range": span}}]
        if replacement:
            requests.append({"insertText": {"location": {"index": start, "tabId": tab_id}, "text": replacement}})
            # fields='*' resets inherited properties to the original style, including empty style.
            requests.append({"updateTextStyle": {"range": {"startIndex": start,
                             "endIndex": start + utf16_length(replacement), "tabId": tab_id},
                             "textStyle": styles[0], "fields": "*"}})
        result["connector_tool"] = "google_drive.batch_update_document"
        result["connector_arguments"] = {"document_id": normalized["document_id"], "requests": requests,
                                         "write_control": {"requiredRevisionId": revision}}
        result["verification"] = "local explicit direct-edit plan only; revalidate fresh document AND comments before connector commit"
    result["plan_sha256"] = digest(result)
    return result


def revalidate_edit(args):
    plan = args["plan"]
    original = copy.deepcopy(plan)
    claimed = original.pop("plan_sha256", None)
    require(claimed == digest(original), "Plan integrity check failed")
    current = plan_edit({**plan["operation"], "snapshot": args["snapshot"], "comments": args["comments"],
                         "expected_revision_id": plan["revision_id"]})
    require(current["document_id"] == plan["document_id"], "Fresh snapshot belongs to another document")
    require(current["snapshot_sha256"] == plan["snapshot_sha256"], "Document changed; reread and replan")
    require(current["comments_sha256"] == plan["comments_sha256"], "Comments changed; review them and replan")
    require(current == plan, "Plan differs from fresh safe plan, including edit mode and payload")
    result = {"status": "revalidated_not_committed", "kind": current["kind"],
              "native_suggestion": current["native_suggestion"], "operation": copy.deepcopy(current["operation"])}
    if current["kind"] == "direct_edit":
        result.update(connector_tool=current["connector_tool"], connector_arguments=current["connector_arguments"],
                      verification="supplied fresh reads match; requiredRevisionId guards the subsequent external write; comments have no atomic revision guard")
    else:
        result.update(source=copy.deepcopy(current["source"]), native_replacement=copy.deepcopy(current["native_replacement"]),
                      required_verification=copy.deepcopy(current["required_verification"]),
                      verification="supplied fresh reads match; native suggestion remains uncommitted; no direct mutation payload; native route must guard concurrency at save time")
    return result


def linked_context(args):
    """Select bounded Sheets rows and supplied notes, preserving provenance and status."""
    limit = args.get("limit", 50)
    require(isinstance(limit, int) and 1 <= limit <= 200, "limit must be 1..200")
    records = []
    for sheet in args.get("sheets", []):
        headers = sheet["headers"]
        require(isinstance(headers, list) and all(isinstance(h, str) and h for h in headers)
                and len(set(headers)) == len(headers), "Sheet headers must be unique nonempty strings")
        for offset, row in enumerate(sheet["rows"]):
            require(isinstance(row, list) and len(row) <= len(headers), "Row width exceeds supplied headers")
            fields = dict(zip(headers, row))
            row_index = sheet.get("start_row", 2) + offset
            source = {"kind": "google_sheet", "spreadsheet_id": sheet["spreadsheet_id"],
                      "sheet_title": sheet["sheet_title"], "row": row_index,
                      "read_range": sheet["range"], "complete": sheet.get("complete") is True}
            source["url"] = "https://docs.google.com/spreadsheets/d/" + urlquote(sheet["spreadsheet_id"], safe="") + "/edit"
            if sheet.get("sheet_id") is not None:
                source["url"] += "#gid=" + str(sheet["sheet_id"]) + "&range=" + str(row_index) + ":" + str(row_index)
            records.append({"fields": fields, "source": source})
    for note in args.get("notes", []):
        require(isinstance(note.get("source"), dict) and note["source"], "Notes need explicit source provenance")
        require(isinstance(note.get("fields"), dict), "Notes need fields object")
        records.append(copy.deepcopy(note))
    selected, total = [], 0
    for record in records:
        fields = record["fields"]
        matched = []
        active = []
        for plural in ("characters", "events", "states"):
            wanted = args.get(plural, [])
            if not wanted:
                continue
            active.append(plural)
            require(plural in fields, f"Filter requires canonical '{plural}' field; explicitly map sheet headers/notes first")
            value = fields.get(plural, [])
            values = value if isinstance(value, list) else [v.strip() for v in str(value).split(",")]
            if set(wanted).intersection(values):
                matched.append(plural)
        if active and not matched:
            continue
        total += 1
        if len(selected) >= limit:
            continue
        item = copy.deepcopy(record)
        item["canon_status"] = fields.get("canon_status", "unknown")
        item["confirmed"] = item["canon_status"] == "confirmed"
        item["knowledge_holder"] = fields.get("knowledge_holder")
        item["story_time"] = fields.get("story_time")
        item["matched_by"] = matched
        item["warnings"] = []
        if item["canon_status"] not in {"confirmed", "draft", "hypothesis", "unknown", "rejected"}:
            item["warnings"].append("Unrecognized status retained; not confirmed")
        if fields.get("kind") == "knowledge" and (not item["knowledge_holder"] or not item["story_time"]):
            item["warnings"].append("Knowledge lacks holder or story-time binding; do not transfer to a character")
        document_id = fields.get("document_id")
        if document_id:
            item["document_source"] = {"document_id": document_id, "tab_id": fields.get("tab_id"),
                                       "quote": fields.get("quote"), "url": doc_link(document_id, fields.get("tab_id"))}
            if not fields.get("quote"):
                item["warnings"].append("Document link has no exact source quote")
        selected.append(item)
    return {"records": selected, "matched_count": total, "omitted_count": total - len(selected),
            "input_record_count": len(records), "filter_rule": "OR across requested entity categories; exact names",
            "verification": "local supplied rows/notes only; canon status preserved, not independently verified",
            "keep_integration": "unavailable; use explicitly supplied notes or linked Docs/Sheets"}


def capabilities(args):
    return {"local": ["structural normalization", "UTF-16 exact native-suggestion planning by default", "explicit direct-edit planning", "fresh-read revalidation", "linked Sheets/notes context"],
            "network_owner": "installed Google Drive connector; this server performs no authenticated network operations",
            "native_suggestions": {"connector_available": False,
                                   "reason": "Installed write_control accepts requiredRevisionId/targetRevisionId, not writeMode",
                                   "route": "supported native API if exposed; native Google Docs Suggesting UI only with separate browser authorization",
                                   "acceptance": "saved pending suggestion IDs linked to exact original/replacement and author accept/reject controls; plan is not a saved suggestion"},
            "manuscript_comments": {"required": "native range-anchored comment linked to the exact manuscript quote",
                                    "acceptance": "supported API or authorized editor evidence of exact quote, target tab/range and editor linkage, plus saved thread readback",
                                    "limitations": "quotedFileContent or quote in body alone is not an anchor; opaque anchor readback cannot independently validate an arbitrary user-supplied anchor"},
            "direct_edit": "explicit author direct-edit request only; one paragraph, one uniform text style, no protected controls; other operations require a separate structural route",
            "keep_integration": "unavailable", "live_verification": "none performed by local tools"}


def tool(name, description, properties, required=()):
    return {"name": "talewisp_google_" + name, "description": description,
            "inputSchema": {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False},
            "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}}


OBJECT = {"type": "object"}
SNAPSHOT = {"type": "object", "description": "{document: full get_document structuredContent, complete: true after untruncated full read; omit fields selector}"}
COMMENTS = {"type": "object", "description": "{document_id, complete:true, pages:[{page_token:null, comments:[], nextPageToken?...}, ...]}; read every nextPageToken"}
TOOLS = [
    tool("capabilities", "Report local planning, connector and native suggestions limitations. No cloud operations.", {}),
    tool("normalize_document", "Normalize native nested or connector flattened Docs tabs, tables, styles, lists, controls and suggestions; retains raw structures.", {"snapshot": SNAPSHOT}, ["snapshot"]),
    tool("plan_edit", "Plan one exact native suggestion by default with no mutation payload. Explicit direct_edit mode requires an author direct-edit request and returns direct batchUpdate arguments. Requires full inline snapshot, revision and comments; commits nothing.",
         {"snapshot": SNAPSHOT, "comments": COMMENTS, "tab_id": {"type": "string"}, "quote": {"type": "string"},
          "replacement": {"type": "string"}, "edit_mode": {"type": "string", "enum": ["native_suggestion", "direct_edit"], "default": "native_suggestion", "description": "direct_edit only for an explicit author request to replace directly without suggestions"}, "start_index": {"type": "integer", "description": "Explicit UTF-16 index for duplicate quote"},
          "expected_revision_id": {"type": "string"}}, ["snapshot", "comments", "tab_id", "quote", "replacement"]),
    tool("revalidate_edit", "Revalidate a local edit plan against newly read full document and all comment pages. Preserves the selected mode: native plans never return direct mutation payloads; explicit direct plans return revision-guarded connector arguments. Caller verifies the saved requested product.",
         {"plan": OBJECT, "snapshot": SNAPSHOT, "comments": COMMENTS}, ["plan", "snapshot", "comments"]),
    tool("linked_context", "Filter bounded supplied Sheets rows and notes by character/event/state, preserving canon status, knowledge holder, story time, row provenance and Docs tab/quote links. No Sheets or Keep I/O.",
         {"sheets": {"type": "array", "items": {"type": "object", "description": "{spreadsheet_id,sheet_title,sheet_id?,range,headers,rows,start_row,complete}"}},
          "notes": {"type": "array", "items": {"type": "object", "description": "{source:{...},fields:{canon_status,characters,events,states,kind,knowledge_holder,story_time,document_id,tab_id,quote,...}}"}},
          **{key: {"type": "array", "items": {"type": "string"}} for key in ("characters", "events", "states")},
          "limit": {"type": "integer", "minimum": 1, "maximum": 200}}),
]
HANDLERS = {"talewisp_google_" + name: function for name, function in
            (("capabilities", capabilities), ("normalize_document", normalize_document),
             ("plan_edit", plan_edit), ("revalidate_edit", revalidate_edit), ("linked_context", linked_context))}


def main():
    import argparse
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["capabilities", "normalize", "plan", "revalidate", "context"])
    parser.add_argument("--input", type=Path, help="JSON arguments file; required except for capabilities")
    parser.add_argument("--output", type=Path, help="Write local JSON result here; defaults to stdout")
    parsed = parser.parse_args()
    if parsed.action != "capabilities" and parsed.input is None:
        parser.error("--input is required")
    actions = {"capabilities": capabilities, "normalize": normalize_document, "plan": plan_edit,
               "revalidate": revalidate_edit, "context": linked_context}
    try:
        args = json.loads(parsed.input.read_text(encoding="utf-8-sig")) if parsed.input else {}
        result = actions[parsed.action](args)
        output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if parsed.output:
            parsed.output.write_text(output, encoding="utf-8")
        else:
            import sys
            sys.stdout.buffer.write(output.encode("utf-8"))
            sys.stdout.buffer.flush()
    except (GoogleWorkspaceError, KeyError, TypeError, UnicodeError, OSError, json.JSONDecodeError) as exc:
        parser.exit(2, f"Google Workspace input rejected: {exc}\n")


if __name__ == "__main__":
    main()
