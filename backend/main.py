from __future__ import annotations

import io
import hashlib
import importlib.util
import json
import mimetypes
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import uuid
from queue import Queue
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit


ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT.parent / "frontend"
DIST_DIR = FRONTEND_DIR / "dist"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
PROCESSED_DIR = DATA_DIR / "processed"
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_STATE_BYTES = 8 * 1024 * 1024
OCR_ENGINE_VALUES = {"auto", "mineru", "pymupdf", "tesseract", "pdfjs"}
MINERU_TIMEOUT_SECONDS = 1800


class DocumentStore:
    """Durable document/task store; SQLite is built in, Chroma is an optional index."""

    def __init__(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(DATA_DIR / "noteflow.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.lock:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    job_id TEXT UNIQUE NOT NULL,
                    filename TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    content_hash TEXT,
                    engine TEXT NOT NULL,
                    status TEXT NOT NULL,
                    result_path TEXT,
                    result_json TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS document_annotations (
                    document_id TEXT PRIMARY KEY,
                    annotations_json TEXT NOT NULL,
                    groups_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS document_ocr_regions (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    page INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    bbox_json TEXT NOT NULL,
                    items_json TEXT NOT NULL,
                    page_width REAL NOT NULL DEFAULT 0,
                    page_height REAL NOT NULL DEFAULT 0,
                    provider TEXT,
                    engine TEXT,
                    source TEXT NOT NULL DEFAULT 'user-region',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
                );
            """)
            columns = {row["name"] for row in self.db.execute("PRAGMA table_info(documents)")}
            if "content_hash" not in columns:
                self.db.execute("ALTER TABLE documents ADD COLUMN content_hash TEXT")
            for row in self.db.execute("SELECT id, file_path FROM documents WHERE content_hash IS NULL OR content_hash = ''").fetchall():
                path = Path(row["file_path"])
                if path.is_file():
                    self.db.execute("UPDATE documents SET content_hash = ? WHERE id = ?", (self._file_hash(path), row["id"]))
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_documents_content_engine ON documents(content_hash, engine, status)")
            self.db.execute("CREATE INDEX IF NOT EXISTS idx_document_ocr_regions_document ON document_ocr_regions(document_id, page, updated_at)")
            self.db.commit()
        self.vector = None
        try:
            import chromadb  # type: ignore
            client = chromadb.PersistentClient(path=str(DATA_DIR / "chroma"))
            self.vector = client.get_or_create_collection("noteflow_documents")
        except Exception:
            # Chroma is intentionally optional; SQLite remains the source of truth.
            self.vector = None

    @staticmethod
    def _now():
        return __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()

    @staticmethod
    def _content_hash(data):
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _file_hash(path):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def create(self, data, filename, engine):
        engine = _ocr_engine(engine)
        content_hash = self._content_hash(data)
        with self.lock:
            existing = self.db.execute(
                """
                SELECT * FROM documents
                WHERE content_hash = ? AND engine = ?
                  AND (status IN ('queued', 'processing')
                       OR (status = 'completed' AND (result_json IS NOT NULL OR result_path IS NOT NULL)))
                ORDER BY updated_at DESC LIMIT 1
                """,
                (content_hash, engine),
            ).fetchone()
            if existing:
                payload = self.public(existing)
                payload["reused"] = True
                payload["cached"] = existing["status"] == "completed" and payload.get("result") is not None
                if payload["cached"]:
                    payload["message"] = "已复用保存的 OCR 结果"
                return payload
        document_id = uuid.uuid4().hex
        job_id = uuid.uuid4().hex
        safe_name = Path(filename or "document.pdf").name or "document.pdf"
        file_path = UPLOAD_DIR / f"{document_id}-{safe_name}"
        file_path.write_bytes(data)
        now = self._now()
        with self.lock:
            self.db.execute(
                "INSERT INTO documents (id, job_id, filename, file_path, content_hash, engine, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (document_id, job_id, safe_name, str(file_path), content_hash, engine, "queued", now, now),
            )
            self.db.commit()
        return {"document_id": document_id, "job_id": job_id, "filename": safe_name, "engine": engine, "status": "queued", "message": "PDF 已加入 MinerU 处理队列", "reused": False, "cached": False}

    def _row(self, where, value):
        with self.lock:
            return self.db.execute(f"SELECT * FROM documents WHERE {where}", (value,)).fetchone()

    def get_by_job(self, job_id):
        return self._row("job_id = ?", job_id)

    def get(self, document_id):
        return self._row("id = ?", document_id)

    def all(self):
        with self.lock:
            return self.db.execute("SELECT * FROM documents ORDER BY created_at DESC").fetchall()

    def pending(self):
        with self.lock:
            return self.db.execute("SELECT * FROM documents WHERE status IN ('queued', 'processing') ORDER BY created_at").fetchall()

    def set_status(self, document_id, status, message=None, error=None):
        now = self._now()
        with self.lock:
            self.db.execute("UPDATE documents SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?", (status, error, now, document_id))
            self.db.commit()

    def save_result(self, document_id, result):
        result_path = PROCESSED_DIR / f"{document_id}.json"
        temporary_path = result_path.with_suffix(".json.tmp")
        with self.lock:
            # Region writes use this same lock, so a worker completion cannot
            # overwrite a crop that arrived while the PDF was processing.
            result = self._merge_ocr_regions(document_id, result)
            serialized = json.dumps(result, ensure_ascii=False)
            temporary_path.write_text(serialized, encoding="utf-8")
            temporary_path.replace(result_path)
            text = " ".join(item.get("text", "") for page in result.get("pages", []) for item in page.get("items", []))
            text = " ".join([text, *[item.get("text", "") for item in result.get("user_regions", [])]]).strip()
            row = self.db.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
            self.db.execute("UPDATE documents SET result_path = ?, result_json = ?, status = ?, error = ?, updated_at = ? WHERE id = ?", (str(result_path), serialized, "completed" if result.get("ok") else "failed", None if result.get("ok") else result.get("message"), self._now(), document_id))
            self.db.commit()
        if self.vector and text.strip():
            try:
                self.vector.upsert(ids=[document_id], documents=[text[:100000]], metadatas=[{"filename": row["filename"] if row else ""}])
            except Exception:
                pass

    def retryable_documents(self):
        """Return queued/processing files so a restarted worker can resume them."""
        return self.pending()

    def public(self, row):
        if not row:
            return None
        result = None
        if row["result_json"]:
            try:
                result = json.loads(row["result_json"])
            except (TypeError, json.JSONDecodeError):
                result = None
        if result is None and row["result_path"]:
            try:
                result = json.loads(Path(row["result_path"]).read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                result = None
        if result is not None:
            result = self._merge_ocr_regions(row["id"], result)
        message = "PDF 已加入 MinerU 处理队列" if row["status"] == "queued" else "MinerU 正在处理 PDF..." if row["status"] == "processing" else (result or {}).get("message") or row["error"] or ""
        return {"document_id": row["id"], "job_id": row["job_id"], "filename": row["filename"], "engine": row["engine"], "status": row["status"], "message": message, "result": result, "error": row["error"]}

    def _ocr_regions_unlocked(self, document_id):
        rows = self.db.execute(
            """
            SELECT id, document_id, page, text, bbox_json, items_json,
                   page_width, page_height, provider, engine, source,
                   created_at, updated_at
            FROM document_ocr_regions
            WHERE document_id = ?
            ORDER BY page, created_at, id
            """,
            (document_id,),
        ).fetchall()
        regions = []
        for row in rows:
            try:
                bbox = json.loads(row["bbox_json"])
                items = json.loads(row["items_json"])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(bbox, list) or len(bbox) < 4:
                continue
            regions.append({
                "id": row["id"],
                "document_id": row["document_id"],
                "page": row["page"],
                "text": row["text"],
                "bbox": bbox,
                "items": items if isinstance(items, list) else [],
                "page_width": row["page_width"],
                "page_height": row["page_height"],
                "provider": row["provider"],
                "engine": row["engine"],
                "source": row["source"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            })
        return regions

    def get_ocr_regions(self, document_id):
        with self.lock:
            return self._ocr_regions_unlocked(document_id)

    def _merge_ocr_regions(self, document_id, result, replace=False):
        if not isinstance(result, dict):
            return result
        with self.lock:
            regions = self._ocr_regions_unlocked(document_id)
        if not regions and not replace:
            return result
        merged = dict(result)
        existing = merged.get("user_regions")
        existing = existing if isinstance(existing, list) else []
        by_id = {item.get("id"): item for item in existing if isinstance(item, dict) and item.get("id")} if not replace else {}
        for region in regions:
            by_id[region["id"]] = region
        merged["user_regions"] = list(by_id.values())
        return merged

    def _persist_merged_ocr_result_unlocked(self, document_id, now, replace_regions=False):
        """Materialize user regions into result_json/result_path when a base result exists."""
        row = self.db.execute("SELECT result_json, result_path FROM documents WHERE id = ?", (document_id,)).fetchone()
        result = None
        if row and row["result_json"]:
            try:
                result = json.loads(row["result_json"])
            except (TypeError, json.JSONDecodeError):
                result = None
        if result is None and row and row["result_path"]:
            try:
                result = json.loads(Path(row["result_path"]).read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                result = None
        if not isinstance(result, dict):
            return
        result = self._merge_ocr_regions(document_id, result, replace=replace_regions)
        serialized = json.dumps(result, ensure_ascii=False)
        result_path = PROCESSED_DIR / f"{document_id}.json"
        temporary_path = result_path.with_suffix(".json.tmp")
        temporary_path.write_text(serialized, encoding="utf-8")
        temporary_path.replace(result_path)
        self.db.execute(
            "UPDATE documents SET result_path = ?, result_json = ?, updated_at = ? WHERE id = ?",
            (str(result_path), serialized, now, document_id),
        )

    def save_ocr_region(self, document_id, region):
        """Persist a user OCR crop independently so a later PDF OCR save cannot erase it."""
        if not self.get(document_id):
            raise ValueError("文档不存在")
        region_id = str(region.get("id") or uuid.uuid4().hex).strip()
        text = re.sub(r"\s+", " ", _text_value(region.get("text"))).strip()
        if not text:
            raise ValueError("区域 OCR 文本为空")
        bbox = _bbox(region.get("bbox"))
        if not bbox:
            raise ValueError("区域 OCR 坐标无效")
        page = max(1, int(_number(region.get("page"), 1)))
        items = region.get("items") if isinstance(region.get("items"), list) else []
        items = [item for item in items[:2000] if isinstance(item, dict)]
        page_width = max(0.0, _number(region.get("page_width")))
        page_height = max(0.0, _number(region.get("page_height")))
        provider = str(region.get("provider") or "ocr").strip()[:64]
        engine = _ocr_engine(region.get("engine"))
        now = self._now()
        payload = {
            "id": region_id,
            "document_id": document_id,
            "page": page,
            "text": text,
            "bbox": bbox,
            "items": items,
            "page_width": page_width,
            "page_height": page_height,
            "provider": provider,
            "engine": engine,
            "source": "user-region",
            "updated_at": now,
        }
        with self.lock:
            created = self.db.execute("SELECT created_at FROM document_ocr_regions WHERE id = ?", (region_id,)).fetchone()
            created_at = created["created_at"] if created else now
            self.db.execute(
                """
                INSERT INTO document_ocr_regions
                    (id, document_id, page, text, bbox_json, items_json,
                     page_width, page_height, provider, engine, source,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    document_id = excluded.document_id,
                    page = excluded.page,
                    text = excluded.text,
                    bbox_json = excluded.bbox_json,
                    items_json = excluded.items_json,
                    page_width = excluded.page_width,
                    page_height = excluded.page_height,
                    provider = excluded.provider,
                    engine = excluded.engine,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                """,
                (
                    region_id,
                    document_id,
                    page,
                    text,
                    json.dumps(bbox, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(items, ensure_ascii=False, separators=(",", ":")),
                    page_width,
                    page_height,
                    provider,
                    engine,
                    "user-region",
                    created_at,
                    now,
                ),
            )
            self._persist_merged_ocr_result_unlocked(document_id, now)
            self.db.commit()
        return {**payload, "created_at": created_at}

    def file_path(self, document_id):
        row = self.get(document_id)
        if not row:
            return None
        path = Path(row["file_path"])
        return path if path.is_file() else None

    def get_annotations(self, document_id):
        with self.lock:
            row = self.db.execute(
                "SELECT annotations_json, groups_json, updated_at FROM document_annotations WHERE document_id = ?",
                (document_id,),
            ).fetchone()
        if not row:
            return None
        try:
            annotations = json.loads(row["annotations_json"])
            groups = json.loads(row["groups_json"])
        except (TypeError, json.JSONDecodeError):
            return None
        return {
            "annotations": annotations if isinstance(annotations, list) else [],
            "groups": groups if isinstance(groups, dict) else {},
            "updated_at": row["updated_at"],
        }

    def _sync_annotation_ocr_regions_unlocked(self, document_id, annotations, now):
        """Keep OCR-region rows aligned with the editable region annotations."""
        region_ids = set()
        for annotation in annotations:
            if not isinstance(annotation, dict) or not annotation.get("region"):
                continue
            region_id = str(annotation.get("id") or "").strip()
            text = re.sub(r"\s+", " ", _text_value(annotation.get("text"))).strip()
            bbox = _bbox(annotation.get("ocrBbox") or annotation.get("bbox"))
            if not region_id or not text or not bbox:
                continue
            region_ids.add(region_id)
            previous = self.db.execute("SELECT items_json, created_at FROM document_ocr_regions WHERE id = ?", (region_id,)).fetchone()
            items = annotation.get("ocrItems") if isinstance(annotation.get("ocrItems"), list) else None
            if items is None and previous:
                try:
                    items = json.loads(previous["items_json"])
                except (TypeError, json.JSONDecodeError):
                    items = []
            items = [item for item in (items or [])[:2000] if isinstance(item, dict)]
            page = max(1, int(_number(annotation.get("page"), 1)))
            page_width = max(0.0, _number(annotation.get("pageWidth")))
            page_height = max(0.0, _number(annotation.get("pageHeight")))
            self.db.execute(
                """
                INSERT INTO document_ocr_regions
                    (id, document_id, page, text, bbox_json, items_json,
                     page_width, page_height, provider, engine, source,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    document_id = excluded.document_id,
                    page = excluded.page,
                    text = excluded.text,
                    bbox_json = excluded.bbox_json,
                    items_json = excluded.items_json,
                    page_width = CASE WHEN excluded.page_width > 0 THEN excluded.page_width ELSE document_ocr_regions.page_width END,
                    page_height = CASE WHEN excluded.page_height > 0 THEN excluded.page_height ELSE document_ocr_regions.page_height END,
                    updated_at = excluded.updated_at
                """,
                (
                    region_id,
                    document_id,
                    page,
                    text,
                    json.dumps(bbox, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(items, ensure_ascii=False, separators=(",", ":")),
                    page_width,
                    page_height,
                    str(annotation.get("ocrProvider") or "ocr").strip()[:64],
                    _ocr_engine(annotation.get("ocrEngine")),
                    "user-region",
                    previous["created_at"] if previous else now,
                    now,
                ),
            )
        if region_ids:
            placeholders = ",".join("?" for _ in region_ids)
            self.db.execute(
                f"DELETE FROM document_ocr_regions WHERE document_id = ? AND id NOT IN ({placeholders})",
                (document_id, *region_ids),
            )
        else:
            self.db.execute("DELETE FROM document_ocr_regions WHERE document_id = ?", (document_id,))

    def save_annotations(self, document_id, annotations, groups):
        now = self._now()
        annotations_json = json.dumps(annotations, ensure_ascii=False, separators=(",", ":"))
        groups_json = json.dumps(groups, ensure_ascii=False, separators=(",", ":"))
        with self.lock:
            self.db.execute(
                """
                INSERT INTO document_annotations (document_id, annotations_json, groups_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(document_id) DO UPDATE SET
                    annotations_json = excluded.annotations_json,
                    groups_json = excluded.groups_json,
                    updated_at = excluded.updated_at
                """,
                (document_id, annotations_json, groups_json, now),
            )
            self._sync_annotation_ocr_regions_unlocked(document_id, annotations, now)
            self._persist_merged_ocr_result_unlocked(document_id, now, replace_regions=True)
            self.db.commit()
        return {"annotations": annotations, "groups": groups, "updated_at": now}


class PdfJobQueue:
    """FIFO worker for PDF parsing so uploads never block the HTTP thread."""

    def __init__(self, ocr, store):
        self.ocr = ocr
        self.store = store
        self.pending = Queue()
        self.worker = threading.Thread(target=self._run, name="noteflow-mineru", daemon=True)
        self.worker.start()
        for row in store.pending():
            path = Path(row["file_path"])
            if path.is_file():
                self.pending.put((row["id"], row["job_id"], str(path), row["filename"], row["engine"]))

    def submit(self, data, filename, engine="auto"):
        job = self.store.create(data, filename, engine)
        if not job.get("reused"):
            self.pending.put((job["document_id"], job["job_id"], str(UPLOAD_DIR / f'{job["document_id"]}-{job["filename"]}'), job["filename"], job["engine"]))
        return job

    def get(self, job_id):
        return self.store.public(self.store.get_by_job(job_id))

    def _run(self):
        while True:
            try:
                document_id, job_id, file_path, filename, engine = self.pending.get()
            except Exception:
                continue
            self.store.set_status(document_id, "processing")
            try:
                result = self.ocr.process_pdf(Path(file_path).read_bytes(), filename, engine)
                self.store.save_result(document_id, result)
            except Exception as error:
                self.store.set_status(document_id, "failed", error=f"PDF 处理失败：{error}")
            finally:
                self.pending.task_done()


def _number(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _bbox(value):
    """Normalize common OCR bbox shapes to [x0, y0, x1, y1]."""
    if isinstance(value, dict):
        x0 = value.get("x0", value.get("x", value.get("left", 0)))
        y0 = value.get("y0", value.get("y", value.get("top", 0)))
        x1 = value.get("x1", value.get("right", _number(x0) + _number(value.get("width"))))
        y1 = value.get("y1", value.get("bottom", _number(y0) + _number(value.get("height"))))
        value = [x0, y0, x1, y1]
    if not isinstance(value, (list, tuple)) or len(value) < 4:
        return None
    values = [_number(item) for item in value[:4]]
    if values[2] <= values[0] or values[3] <= values[1]:
        return None
    return values


def _text_value(value):
    """Convert MinerU's text/content variants into one readable string."""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        values = [_text_value(item) for item in value]
        return " ".join(item for item in values if item.strip())
    if isinstance(value, dict):
        for key in ("text", "content", "value", "latex", "paragraph_content", "title_content", "span_content", "code_content"):
            if key in value:
                return _text_value(value[key])
    return "" if value is None else str(value)


def _page_size(value):
    if isinstance(value, dict):
        value = [value.get("width", value.get("w", 0)), value.get("height", value.get("h", 0))]
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return 0, 0
    return _number(value[0]), _number(value[1])


def _page_number(value, zero_based=False):
    try:
        value = int(value)
    except (TypeError, ValueError):
        return 1
    # MinerU uses zero-based page_idx while page/page_id are usually one-based.
    return value + 1 if zero_based and value >= 0 else max(1, value)


def _ocr_engine(value):
    value = str(value or "auto").strip().lower()
    return value if value in OCR_ENGINE_VALUES else "auto"


def _find_command(*names):
    candidates = []
    for name in names:
        # Prefer the project's virtualenv so the CLI and its Python runtime
        # come from the same MinerU installation. Fall back to PATH for
        # deployments that install the command globally.
        candidates.extend([
            ROOT.parent / ".venv" / "bin" / name,
            Path(sys.prefix) / "bin" / name,
        ])
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    return next((str(path) for path in candidates if path.is_file() and path.stat().st_mode & 0o111), None)


class OcrEngine:
    """Small optional OCR bridge. Heavy OCR packages remain opt-in."""

    def __init__(self):
        self.mineru_command = _find_command("mineru")
        self.tesseract_command = _find_command("tesseract")
        self.pymupdf_available = importlib.util.find_spec("fitz") is not None
        self.pillow_available = importlib.util.find_spec("PIL") is not None
        self.pytesseract_available = importlib.util.find_spec("pytesseract") is not None

    def status(self):
        providers = []
        if self.mineru_command:
            providers.append("mineru")
        if (self.pytesseract_available and self.pillow_available) or self.tesseract_command:
            providers.append("tesseract")
        if self.pymupdf_available:
            providers.append("pymupdf")
        engines = {
            "auto": bool(providers),
            "mineru": bool(self.mineru_command),
            "pymupdf": self.pymupdf_available,
            "tesseract": bool((self.pytesseract_available and self.pillow_available) or self.tesseract_command),
            "pdfjs": True,
        }
        return {
            "ok": True,
            "available": bool(providers),
            "provider": providers[0] if providers else None,
            "providers": providers,
            "engines": engines,
            "mineru": engines["mineru"],
            "message": "、".join(providers) + " 已就绪" if providers else "未安装 OCR 引擎，将使用 PDF.js 文本层",
        }

    @staticmethod
    def _empty(message, provider=None):
        return {"ok": False, "available": False, "provider": provider, "pages": [], "message": message}

    @staticmethod
    def _page(page_number, width=0, height=0):
        return {"page": page_number, "width": width, "height": height, "items": []}

    def _add_item(self, pages, page_number, text, bbox, width=0, height=0, source="ocr"):
        text = re.sub(r"\s+", " ", _text_value(text)).strip()
        box = _bbox(bbox)
        if not text or not box:
            return
        page = pages.setdefault(page_number, self._page(page_number, width, height))
        if width and not page["width"]:
            page["width"] = width
        if height and not page["height"]:
            page["height"] = height
        page["items"].append({"text": text, "bbox": box, "source": source})

    def _normalise_mineru_middle_json(self, page_infos):
        pages = {}
        for index, page_info in enumerate(page_infos or []):
            if not isinstance(page_info, dict):
                continue
            has_page_index = "page_idx" in page_info
            page_number = _page_number(page_info.get("page_idx", index), zero_based=has_page_index)
            page_width, page_height = _page_size(page_info.get("page_size"))
            def add_block(block):
                if not isinstance(block, dict):
                    return False
                block_has_span = False
                for line in block.get("lines", []) or []:
                    if not isinstance(line, dict):
                        continue
                    for span in line.get("spans", []) or []:
                        if not isinstance(span, dict):
                            continue
                        text = span.get("content") or span.get("text") or span.get("value")
                        if text and span.get("bbox"):
                            self._add_item(pages, page_number, text, span.get("bbox"), page_width, page_height, "mineru")
                            block_has_span = True
                for child in block.get("blocks", []) or []:
                    block_has_span = add_block(child) or block_has_span
                if not block_has_span:
                    text = block.get("text") or block.get("content")
                    if text and block.get("bbox"):
                        self._add_item(pages, page_number, text, block.get("bbox"), page_width, page_height, "mineru")
                        block_has_span = True
                return block_has_span

            layout_blocks = page_info.get("para_blocks") or page_info.get("preproc_blocks") or []
            for block in layout_blocks + (page_info.get("discarded_blocks", []) or []):
                add_block(block)
        return {key: value for key, value in pages.items() if value["items"]}

    def _normalise_mineru_json(self, payload, source_name=""):
        if isinstance(payload, dict) and isinstance(payload.get("pdf_info"), list):
            return self._normalise_mineru_middle_json(payload["pdf_info"])

        pages = {}
        normalized_coordinates = source_name.endswith(("_content_list.json", "_content_list_v2.json")) or (isinstance(payload, dict) and "content_list" in payload)
        candidates = payload if isinstance(payload, list) else payload.get("content_list", payload.get("pages", [])) if isinstance(payload, dict) else []
        if isinstance(candidates, dict):
            candidates = candidates.get("items", candidates.get("content", []))
        flattened = []
        for page_index, item in enumerate(candidates or []):
            if isinstance(item, list):
                for nested in item:
                    if isinstance(nested, dict) and "page_idx" not in nested and "page" not in nested and "page_id" not in nested:
                        nested = {**nested, "_page_hint": page_index}
                    flattened.append(nested)
            else:
                flattened.append(item)
        for item in flattened:
            if not isinstance(item, dict):
                continue
            text = item.get("text") or item.get("content") or item.get("latex")
            if not text and item.get("type") == "text":
                text = item.get("value")
            has_page_index = "page_idx" in item or "_page_hint" in item
            page_value = item.get("page_idx", item.get("page_id", item.get("page", item.get("_page_hint", 0))))
            page_number = _page_number(page_value, zero_based=has_page_index)
            box = item.get("bbox") or item.get("text_bbox") or item.get("box")
            page_width = _number(item.get("page_width", item.get("width_px", 0)))
            page_height = _number(item.get("page_height", item.get("height_px", 0)))
            if normalized_coordinates:
                page_width = page_width or 1000
                page_height = page_height or 1000
            self._add_item(pages, page_number, text, box, page_width, page_height, "mineru")
        return pages

    def _run_mineru_file(self, data, filename):
        if not self.mineru_command:
            return None
        with tempfile.TemporaryDirectory(prefix="noteflow-mineru-") as temp_dir:
            source = Path(temp_dir) / Path(filename or "document.pdf").name
            output = Path(temp_dir) / "output"
            source.write_bytes(data)
            output.mkdir()
            command = [self.mineru_command, "-p", str(source), "-o", str(output), "-b", "pipeline"]
            try:
                completed = subprocess.run(command, capture_output=True, text=True, timeout=MINERU_TIMEOUT_SECONDS, check=False)
            except (OSError, subprocess.TimeoutExpired):
                return None
            if completed.returncode != 0:
                return None
            def output_priority(path):
                name = path.name
                if name.endswith("_middle.json"):
                    return 0
                if name.endswith("_content_list.json"):
                    return 1
                if name.endswith("_content_list_v2.json"):
                    return 2
                return 3

            json_files = sorted(output.rglob("*.json"), key=lambda path: (output_priority(path), len(path.parts), path.name))
            for path in json_files:
                try:
                    payload = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                    continue
                pages = self._normalise_mineru_json(payload, path.name)
                if pages:
                    return pages
        return None

    def _run_mineru_pdf(self, data, filename):
        return self._run_mineru_file(data, Path(filename or "document.pdf").stem + ".pdf")

    def _extract_with_pymupdf(self, data):
        if not self.pymupdf_available:
            return {}
        try:
            import fitz  # type: ignore

            document = fitz.open(stream=data, filetype="pdf")
            pages = {}
            for index, page in enumerate(document):
                page_number = index + 1
                rect = page.rect
                target = self._page(page_number, rect.width, rect.height)
                pages[page_number] = target
                payload = page.get_text("dict")
                for block in payload.get("blocks", []):
                    for line in block.get("lines", []):
                        for span in line.get("spans", []):
                            self._add_item(pages, page_number, span.get("text"), span.get("bbox"), rect.width, rect.height, "pymupdf")
            document.close()
            return {key: value for key, value in pages.items() if value["items"]}
        except Exception:
            return {}

    def process_pdf(self, data, filename="document.pdf", engine="auto"):
        engine = _ocr_engine(engine)
        if engine == "pdfjs":
            return self._empty("已选择 PDF.js 文本层", "pdfjs")
        if engine in {"auto", "mineru"}:
            pages = self._run_mineru_pdf(data, filename)
            if pages:
                return {"ok": True, "available": True, "provider": "mineru", "pages": [pages[key] for key in sorted(pages)], "message": "MinerU OCR 已完成", "engine": engine}
            if engine == "mineru":
                return self._empty("MinerU 未能完成解析，请检查模型和运行时配置", "mineru")
        if engine in {"auto", "pymupdf"}:
            pages = self._extract_with_pymupdf(data)
            if pages:
                return {"ok": True, "available": True, "provider": "pymupdf", "pages": [pages[key] for key in sorted(pages)], "message": "已使用 PDF 文本定位", "engine": engine}
            if engine == "pymupdf":
                return self._empty("PyMuPDF 未识别到文本", "pymupdf")
        if engine == "tesseract":
            return self._empty("Tesseract 不支持 PDF 文本层定位，请改用 MinerU 或 PDF.js", "tesseract")
        return self._empty("OCR 未能完成解析，已回退到 PDF.js 文本层", None)

    def _tesseract_data(self, data):
        if self.pytesseract_available and self.pillow_available:
            try:
                from PIL import Image  # type: ignore
                import pytesseract  # type: ignore
                image = Image.open(io.BytesIO(data))
                languages = set(pytesseract.get_languages(config=""))
                lang = "eng+chi_sim" if {"eng", "chi_sim"}.issubset(languages) else "eng" if "eng" in languages else None
                config = "--psm 6"
                payload = pytesseract.image_to_data(image, lang=lang, config=config, output_type=pytesseract.Output.DICT) if lang else pytesseract.image_to_data(image, config=config, output_type=pytesseract.Output.DICT)
                width, height = image.size
                pages = {1: self._page(1, width, height)}
                for index, text in enumerate(payload.get("text", [])):
                    if not str(text).strip():
                        continue
                    left = _number(payload.get("left", [])[index])
                    top = _number(payload.get("top", [])[index])
                    box = [left, top, left + _number(payload.get("width", [])[index]), top + _number(payload.get("height", [])[index])]
                    self._add_item(pages, 1, text, box, width, height, "tesseract")
                return pages if pages[1]["items"] else {}
            except Exception:
                pass
        if not self.tesseract_command:
            return {}
        with tempfile.TemporaryDirectory(prefix="noteflow-tesseract-") as temp_dir:
            image_path = Path(temp_dir) / "region.png"
            image_path.write_bytes(data)
            try:
                completed = subprocess.run([self.tesseract_command, str(image_path), "stdout", "--psm", "6", "tsv"], capture_output=True, text=True, timeout=30, check=False)
            except (OSError, subprocess.TimeoutExpired):
                return {}
            if completed.returncode != 0:
                return {}
            pages = {1: self._page(1)}
            for line in completed.stdout.splitlines()[1:]:
                columns = line.split("\t")
                if len(columns) < 12:
                    continue
                text = columns[11].strip()
                if not text:
                    continue
                left, top, width, height = (_number(item) for item in columns[6:10])
                self._add_item(pages, 1, text, [left, top, left + width, top + height], source="tesseract")
            return pages if pages[1]["items"] else {}

    def _mineru_region_data(self, data, filename):
        """MinerU consumes PDFs consistently; wrap a selected image as a one-page PDF when Pillow is present."""
        if not self.mineru_command:
            return {}
        if not self.pillow_available:
            return self._run_mineru_file(data, Path(filename or "region.png").name) or {}
        try:
            from PIL import Image  # type: ignore

            image = Image.open(io.BytesIO(data)).convert("RGB")
            buffer = io.BytesIO()
            image.save(buffer, format="PDF")
            return self._run_mineru_pdf(buffer.getvalue(), Path(filename or "region").stem + ".pdf") or {}
        except Exception:
            return {}

    def process_region(self, data, filename="region.png", engine="auto"):
        engine = _ocr_engine(engine)
        if engine == "pdfjs":
            return {**self._empty("已选择 PDF.js，区域识别不可用", "pdfjs"), "text": "", "items": []}
        if engine == "pymupdf":
            return {**self._empty("PyMuPDF 仅支持 PDF 文本定位，区域识别请改用 MinerU 或 Tesseract", "pymupdf"), "text": "", "items": []}
        if engine in {"auto", "mineru"}:
            pages = self._mineru_region_data(data, filename)
            if pages and pages.get(1, {}).get("items"):
                page = pages[1]
                text = " ".join(item["text"] for item in page["items"])
                box = [min(item["bbox"][0] for item in page["items"]), min(item["bbox"][1] for item in page["items"]), max(item["bbox"][2] for item in page["items"]), max(item["bbox"][3] for item in page["items"])]
                return {"ok": True, "available": True, "provider": "mineru", "text": text, "bbox": box, "items": page["items"], "width": page["width"], "height": page["height"], "message": "MinerU 区域识别完成", "engine": engine}
            if engine == "mineru":
                return {**self._empty("MinerU 未能完成区域识别，请检查模型和运行时配置", "mineru"), "text": "", "items": []}
        if engine in {"auto", "tesseract"}:
            pages = self._tesseract_data(data)
            if pages:
                page = pages[1]
                text = " ".join(item["text"] for item in page["items"])
                box = [min(item["bbox"][0] for item in page["items"]), min(item["bbox"][1] for item in page["items"]), max(item["bbox"][2] for item in page["items"]), max(item["bbox"][3] for item in page["items"])]
                return {"ok": True, "available": True, "provider": "tesseract", "text": text, "bbox": box, "items": page["items"], "width": page["width"], "height": page["height"], "message": "区域识别完成", "engine": engine}
            if engine == "tesseract":
                return {**self._empty("Tesseract 未能完成区域识别", "tesseract"), "text": "", "items": []}
        return {**self._empty("没有可用的区域 OCR 引擎，请安装 MinerU 或 Tesseract", None), "text": "", "items": []}


OCR = OcrEngine()
DOCUMENTS = DocumentStore()
PDF_JOBS = PdfJobQueue(OCR, DOCUMENTS)


class AppHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
    }

    def __init__(self, *args, **kwargs):
        # The backend serves the production build generated by frontend/.
        if not DIST_DIR.is_dir():
            raise RuntimeError("Frontend build not found. Run `npm run build` in frontend/ first.")
        directory = DIST_DIR
        super().__init__(*args, directory=str(directory), **kwargs)

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/api/ocr/status":
            self._send_json(OCR.status())
            return
        if path == "/api/documents":
            self._send_json({"ok": True, "documents": [DOCUMENTS.public(row) for row in DOCUMENTS.all()]})
            return
        if path.startswith("/api/documents/"):
            parts = path.strip("/").split("/")
            document_id = parts[2] if len(parts) >= 3 else ""
            row = DOCUMENTS.get(document_id)
            if not row:
                self._send_json({"ok": False, "message": "文档不存在"}, 404)
                return
            if len(parts) >= 4 and parts[3] == "file":
                file_path = DOCUMENTS.file_path(document_id)
                if not file_path:
                    self._send_json({"ok": False, "message": "原文件不存在"}, 404)
                    return
                payload = file_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mimetypes.guess_type(row["filename"])[0] or "application/pdf")
                self.send_header("Content-Length", str(len(payload)))
                display_name = Path(row["filename"]).name
                # http.server encodes header values as latin-1. Keep an ASCII
                # fallback and expose the real UTF-8 name via RFC 5987.
                ascii_name = display_name.encode("ascii", "ignore").decode("ascii").strip() or "document.pdf"
                self.send_header("Content-Disposition", f"inline; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(display_name, safe='')}")
                self.end_headers()
                self.wfile.write(payload)
                return
            if len(parts) >= 4 and parts[3] == "ocr":
                payload = DOCUMENTS.public(row)
                payload["ok"] = True
                self._send_json(payload)
                return
            if len(parts) >= 4 and parts[3] == "annotations":
                state = DOCUMENTS.get_annotations(document_id)
                self._send_json({"ok": True, "exists": state is not None, **(state or {"annotations": [], "groups": {}, "updated_at": None})})
                return
            self._send_json({"ok": True, **DOCUMENTS.public(row)}, 200)
            return
        if path.startswith("/api/ocr/pdf/") or path.startswith("/api/ocr/jobs/"):
            job_id = path.rsplit("/", 1)[-1]
            job = PDF_JOBS.get(job_id)
            self._send_json(job or {"ok": False, "message": "任务不存在"}, 200 if job else 404)
            return
        if self.path in {"", "/"}:
            self.path = "/index.html"
        super().do_GET()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()

    def do_PUT(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        parts = path.strip("/").split("/")
        if len(parts) != 4 or parts[:2] != ["api", "documents"] or parts[3] != "annotations":
            self.send_error(404, "Not found")
            return
        document_id = parts[2]
        if not DOCUMENTS.get(document_id):
            self._send_json({"ok": False, "message": "文档不存在"}, 404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_STATE_BYTES:
            self._send_json({"ok": False, "message": "批注数据为空或超过 8 MB 限制"}, 413)
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"ok": False, "message": "批注数据不是有效 JSON"}, 400)
            return
        annotations = payload.get("annotations") if isinstance(payload, dict) else None
        groups = payload.get("groups") if isinstance(payload, dict) else None
        if not isinstance(annotations, list) or not all(isinstance(item, dict) for item in annotations):
            self._send_json({"ok": False, "message": "annotations 必须是对象数组"}, 400)
            return
        if len(annotations) > 20000:
            self._send_json({"ok": False, "message": "单个文档最多保存 20000 条批注"}, 413)
            return
        if not isinstance(groups, dict) or len(groups) > 256 or not all(isinstance(item, dict) for item in groups.values()):
            self._send_json({"ok": False, "message": "groups 必须是有效的分组对象"}, 400)
            return
        state = DOCUMENTS.save_annotations(document_id, annotations, groups)
        self._send_json({"ok": True, **state})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path not in {"/api/ocr/pdf", "/api/ocr/region"}:
            self.send_error(404, "Not found")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self._send_json({"ok": False, "available": False, "message": "文件为空或超过 64 MB 限制"}, 413)
            return
        body = self.rfile.read(length)
        try:
            fields = self._parse_multipart(body)
            file_field = fields.get("file") or fields.get("image") or fields.get("pdf")
            if not file_field:
                self._send_json({"ok": False, "available": False, "message": "缺少 file 或 image 文件字段"}, 400)
                return
            data, filename = file_field
            if not data:
                self._send_json({"ok": False, "available": False, "message": "上传文件为空"}, 400)
                return
            engine = fields.get("engine") or "auto"
            response_status = 200
            if path.endswith("/pdf"):
                # PDF parsing is deliberately asynchronous. The worker invokes the
                # official MinerU CLI and the browser polls this job endpoint.
                response = PDF_JOBS.submit(data, filename or "document.pdf", engine)
                response["ok"] = True
                response_status = 200 if response.get("cached") else 202
            else:
                response = OCR.process_region(data, filename or "region.png", engine)
                query_page = parse_qs(urlsplit(self.path).query).get("page", [None])[0]
                field_page = fields.get("page")
                try:
                    response["page"] = max(1, int(query_page or field_page or 1))
                except (TypeError, ValueError):
                    response["page"] = 1
                document_id = str(fields.get("document_id") or "").strip()
                if response.get("ok") and document_id:
                    def json_field(name, fallback=None):
                        value = fields.get(name)
                        if value in (None, ""):
                            return fallback
                        try:
                            return json.loads(value) if isinstance(value, str) else value
                        except (TypeError, json.JSONDecodeError):
                            return fallback

                    stored = DOCUMENTS.save_ocr_region(document_id, {
                        "id": fields.get("region_id"),
                        "page": response["page"],
                        "text": response.get("text"),
                        "bbox": json_field("ocr_bbox", response.get("bbox")),
                        "items": response.get("items", []),
                        "page_width": fields.get("page_width"),
                        "page_height": fields.get("page_height"),
                        "provider": response.get("provider"),
                        "engine": response.get("engine", engine),
                    })
                    response["stored"] = True
                    response["region_id"] = stored["id"]
            self._send_json(response, response_status)
        except Exception as error:  # OCR is optional; malformed input should not take down static serving.
            self._send_json({"ok": False, "available": False, "message": f"OCR 请求失败：{error}"}, 500)

    def _parse_multipart(self, body):
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            return {}
        message = BytesParser(policy=email_policy).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode() + body
        )
        fields = {}
        for part in message.iter_parts():
            name = part.get_param("name", header="content-disposition")
            if not name:
                continue
            value = part.get_payload(decode=True) or b""
            filename = part.get_filename()
            fields[name] = (value, filename) if filename else value.decode("utf-8", "ignore")
        return fields

    def _send_json(self, payload, status=200):
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def end_headers(self) -> None:  # noqa: N802
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[NoteFlow] {self.address_string()} - {format % args}")


def run() -> None:
    host = "127.0.0.1"
    port = 8000
    mimetypes.add_type("text/javascript", ".js")
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f"NoteFlow is running at http://{host}:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping NoteFlow...")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
