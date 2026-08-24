import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  Avatar,
  Badge,
  Button as AntButton,
  Card,
  Collapse,
  Checkbox,
  ConfigProvider,
  Divider,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal as AntModal,
  Progress,
  Select,
  Segmented,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  InboxOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  SettingOutlined,
  ShareAltOutlined,
  StarFilled,
  StarOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import "antd/dist/reset.css";
import * as Icons from "lucide-react";
import "./styles.css";

const Icon = ({ name, ...props }) => {
  const Component = Icons[name] || Icons.Circle;
  return <Component {...props} />;
};

const DEFAULT_COLORS = {
  yellow: { label: "重点词汇", hex: "#f1d85a" },
  mint: { label: "熟悉词汇", hex: "#61c9a3" },
  lavender: { label: "待复习", hex: "#aa93db" },
  coral: { label: "易错词", hex: "#ed856c" },
};

const DEFAULT_COLLECTIONS = [
  { id: "english", name: "英语学习", tone: "mint", documents: [
    { id: "sample-academic-vocabulary", name: "Academic Vocabulary · Unit 04", type: "pdf" },
  ] },
];

const SAMPLE_NOTES = [
  { id: "w1", text: "argument", color: "yellow", page: 4 },
  { id: "w2", text: "proposition", color: "yellow", page: 4 },
  { id: "w3", text: "credible", color: "mint", page: 4 },
  { id: "w4", text: "evaluate", color: "lavender", page: 4 },
  { id: "w5", text: "underlying", color: "coral", page: 4 },
  { id: "w6", text: "sufficient", color: "mint", page: 4 },
];

const TRANSLATIONS = {
  argument: "论点；论证", proposition: "命题；主张", credible: "可信的；可靠的",
  evaluate: "评估；评价", underlying: "潜在的；根本的", sufficient: "充足的；足够的",
  premise: "前提；假设", refuted: "反驳；驳斥", infer: "推断；推论",
  valid: "有效的；合理的", bias: "偏见；偏向",
};

const EXPLANATIONS = {
  argument: "n. a reason or set of reasons given in support of an idea",
  proposition: "n. a statement that expresses a judgment or opinion",
  credible: "adj. able to be believed; convincing",
  evaluate: "v. to judge the quality, importance, or value of something",
  underlying: "adj. fundamental, though not immediately obvious",
  sufficient: "adj. enough for a particular purpose",
};

const PDFJS_VERSION = "3.11.174";
const PDFJS_SCRIPT_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
const PDFJS_WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
const OCR_API_BASE = globalThis.__NOTEFLOW_API_BASE || (globalThis.location?.port === "5173" ? "http://127.0.0.1:8000" : "");
const OCR_TIMEOUT_MS = 7000;
const MINERU_TIMEOUT_MS = 1800000;
const DEFAULT_MAX_HIGHLIGHT_CHARS = 120;
const DOCUMENT_STATE_STORAGE_KEY = "noteflow-document-annotations-v1";
const PDF_OCR_RESULT_CACHE = new Map();
const PDF_OCR_REQUEST_CACHE = new Map();

function getMaxHighlightChars() {
  const value = Number(localStorage.getItem("noteflow-max-highlight-chars"));
  return Number.isFinite(value) ? Math.min(1000, Math.max(10, Math.floor(value))) : DEFAULT_MAX_HIGHLIGHT_CHARS;
}

function getHighlightSegmentation() {
  try {
    return localStorage.getItem("noteflow-highlight-segmentation") || "nearest";
  } catch {
    return "nearest";
  }
}

function normalizeHighlightText(value) {
  return String(value || "").replace(/[\u00a0\s]+/g, " ").trim();
}

// PDF.js and MinerU often return one text item for an entire phrase. Split it
// into small hit targets while retaining each token's character range so its
// original bounding box can be divided proportionally.
let cachedCjkSegmenter;
function splitPdfTextSegments(value, segmentation = getHighlightSegmentation()) {
  const text = String(value || "").replace(/[\u00a0\s]+/g, " ").trim();
  if (!text) return [];
  const useWordSegmenter = segmentation === "jieba" || (segmentation === "nearest" && /[\u4e00-\u9fff]/u.test(text));
  if (useWordSegmenter && globalThis.Intl?.Segmenter) {
    try {
      cachedCjkSegmenter ||= new globalThis.Intl.Segmenter("zh-CN", { granularity: "word" });
      return [...cachedCjkSegmenter.segment(text)]
        .filter(part => part.segment && !/^\s+$/.test(part.segment))
        .map(part => ({ text: part.segment, start: part.index, end: part.index + part.segment.length }));
    } catch {
      // Older browsers fall through to the deterministic character/word split.
    }
  }
  const segments = [];
  const matcher = /[A-Za-z0-9][A-Za-z0-9'\u2019._-]*|[\u4e00-\u9fff]|[^\s]/gu;
  let match;
  while ((match = matcher.exec(text))) segments.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  return segments;
}

function trimRangeWhitespace(range) {
  const start = range.startContainer;
  if (start?.nodeType === 3) {
    const value = start.nodeValue || "";
    let offset = range.startOffset;
    while (offset < value.length && /\s/.test(value[offset])) offset += 1;
    range.setStart(start, offset);
  }
  const end = range.endContainer;
  if (end?.nodeType === 3) {
    const value = end.nodeValue || "";
    let offset = range.endOffset;
    while (offset > 0 && /\s/.test(value[offset - 1])) offset -= 1;
    range.setEnd(end, offset);
  }
}

function highlightTextAllowed(value, notify, options = {}) {
  const text = normalizeHighlightText(value);
  if (!text) return false;
  if (text.length > getMaxHighlightChars()) {
    notify?.(`勾画内容不能超过 ${getMaxHighlightChars()} 个字`);
    return false;
  }
  if (text.length === 1 && !(options.allowSingleWord && /[\p{L}\p{N}\u4e00-\u9fff]/u.test(text))) {
    notify?.("请拖画或选择更完整的词语/句子");
    return false;
  }
  return true;
}

function ocrApiUrl(path) {
  return `${OCR_API_BASE}${path}`;
}

function getOcrEnginePreference() {
  try {
    return localStorage.getItem("noteflow-ocr-engine") || "auto";
  } catch {
    return "auto";
  }
}

async function requestOcr(path, blob, filename, fields = {}) {
  if (!blob) throw new Error("OCR 文件为空");
  const form = new FormData();
  form.append("file", blob, filename || "document.pdf");
  Object.entries(fields).forEach(([key, value]) => form.append(key, String(value)));
  const controller = new AbortController();
  const timeoutMs = fields.engine === "mineru" || fields.engine === "auto" ? MINERU_TIMEOUT_MS : OCR_TIMEOUT_MS;
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ocrApiUrl(path), { method: "POST", body: form, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `OCR 服务返回 ${response.status}`);
    return payload;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function uploadPdfDocument(file) {
  return requestOcr("/api/ocr/pdf", file, file?.name || "document.pdf", { engine: getOcrEnginePreference() });
}

async function requestPdfOcrFresh(objectUrl, filename, onState, documentId = null, knownJobId = null) {
  let queued = null;
  if (documentId) {
    const response = await fetch(ocrApiUrl(`/api/documents/${encodeURIComponent(documentId)}/ocr`));
    queued = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(queued.message || "无法读取已保存的 PDF 任务");
    if (queued.result) return queued.result;
  } else {
    const response = await fetch(objectUrl);
    if (!response.ok) throw new Error("无法读取 PDF");
    queued = await requestOcr("/api/ocr/pdf", await response.blob(), `${filename || "document"}.pdf`, { engine: getOcrEnginePreference() });
  }
  if (!queued?.job_id && !knownJobId) return queued;
  const jobId = queued?.job_id || knownJobId;
  onState?.({ status: queued?.status || "queued", message: queued?.message || "已加入 MinerU 处理队列" });
  const deadline = Date.now() + MINERU_TIMEOUT_MS + 30000;
  while (Date.now() < deadline) {
    await new Promise(resolve => globalThis.setTimeout(resolve, 850));
    const resultResponse = await fetch(ocrApiUrl(`/api/ocr/pdf/${encodeURIComponent(jobId)}`));
    const result = await resultResponse.json().catch(() => ({}));
    if (!resultResponse.ok) throw new Error(result.message || "无法查询 PDF 处理任务");
    onState?.({ status: result.status, message: result.status === "queued" ? "排队等待 MinerU 处理..." : result.status === "processing" ? "MinerU 正在处理 PDF..." : result.message || result.error || "" });
    if (result.status === "completed" || result.status === "failed") return result.result || { ok: false, message: result.error || "MinerU 处理失败" };
  }
  throw new Error("MinerU 处理超时，已使用 PDF.js 文本层");
}

async function requestPdfOcr(objectUrl, filename, onState, documentId = null, knownJobId = null) {
  if (!documentId) return requestPdfOcrFresh(objectUrl, filename, onState, documentId, knownJobId);
  const cacheKey = String(documentId);
  if (PDF_OCR_RESULT_CACHE.has(cacheKey)) {
    const cached = PDF_OCR_RESULT_CACHE.get(cacheKey);
    onState?.({ status: "ready", message: "已加载保存的 OCR 定位" });
    return cached;
  }
  if (PDF_OCR_REQUEST_CACHE.has(cacheKey)) {
    onState?.({ status: "loading", message: "正在读取已保存的 OCR 定位..." });
    return PDF_OCR_REQUEST_CACHE.get(cacheKey);
  }
  const request = requestPdfOcrFresh(objectUrl, filename, onState, documentId, knownJobId)
    .then(result => {
      if (result) PDF_OCR_RESULT_CACHE.set(cacheKey, result);
      return result;
    })
    .finally(() => PDF_OCR_REQUEST_CACHE.delete(cacheKey));
  PDF_OCR_REQUEST_CACHE.set(cacheKey, request);
  return request;
}

function createPdfRegionOverlays(root, marks, activeColor, toggleRef, removeRef, toolRef) {
  marks.filter(mark => mark.region && Array.isArray(mark.bbox) && mark.bbox.length >= 4).forEach(mark => {
    const page = root.querySelector(`.pdf-page[data-page-number="${mark.page || 1}"]`);
    if (!page || [...page.querySelectorAll(".pdf-region-highlight[data-id]")].some(node => node.dataset.id === mark.id)) return;
    const sourceWidth = Number(page.dataset.sourceWidth) || 0;
    const sourceHeight = Number(page.dataset.sourceHeight) || 0;
    const displayWidth = page.offsetWidth || Number(page.style.width.replace("px", "")) || sourceWidth;
    const displayHeight = page.offsetHeight || Number(page.style.height.replace("px", "")) || sourceHeight;
    const sourceBbox = Array.isArray(mark.ocrBbox) && mark.ocrBbox.length >= 4 ? mark.ocrBbox.map(Number) : null;
    const savedPageWidth = Number(mark.pageWidth) || sourceWidth;
    const savedPageHeight = Number(mark.pageHeight) || sourceHeight;
    const [x0, y0, x1, y1] = (sourceBbox && displayWidth && displayHeight && savedPageWidth && savedPageHeight
      ? [sourceBbox[0] * displayWidth / savedPageWidth, sourceBbox[1] * displayHeight / savedPageHeight, sourceBbox[2] * displayWidth / savedPageWidth, sourceBbox[3] * displayHeight / savedPageHeight]
      : mark.bbox).map(Number);
    const overlay = globalThis.document.createElement("div");
    overlay.className = "pdf-region-highlight word highlighted selection-highlight";
    overlay.dataset.id = mark.id;
    overlay.dataset.page = String(mark.page || 1);
    overlay.dataset.color = mark.color || activeColor;
    overlay.title = mark.text || "区域批注";
    Object.assign(overlay.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    overlay.onclick = () => toggleRef.current?.(mark.id, mark.text, Number(mark.page) || 1);
    overlay.onpointerdown = event => { if (toolRef.current === "erase") { event.preventDefault(); removeRef.current?.(mark.id); } };
    page.append(overlay);
  });
}

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function documentStateKey(record) {
  return record?.documentId ? `server:${record.documentId}` : record?.id ? `local:${record.id}` : null;
}

function defaultDocumentAnnotations(record) {
  return record?.name === "Academic Vocabulary · Unit 04" ? SAMPLE_NOTES : [];
}

function documentStateGroups(record) {
  const groups = readLocalDocumentState(record)?.groups;
  return groups && Object.keys(groups).length ? groups : readStored("noteflow-color-meta", DEFAULT_COLORS);
}

function readLocalDocumentState(record) {
  const key = documentStateKey(record);
  if (!key) return null;
  try {
    const states = JSON.parse(localStorage.getItem(DOCUMENT_STATE_STORAGE_KEY) || "{}");
    const state = states?.[key];
    if (!state || !Array.isArray(state.annotations) || !state.groups || typeof state.groups !== "object") return null;
    return state;
  } catch {
    return null;
  }
}

function saveLocalDocumentState(record, annotations, groups, updatedAt = new Date().toISOString()) {
  const key = documentStateKey(record);
  if (!key) return false;
  try {
    const states = JSON.parse(localStorage.getItem(DOCUMENT_STATE_STORAGE_KEY) || "{}");
    states[key] = { annotations, groups, updatedAt };
    localStorage.setItem(DOCUMENT_STATE_STORAGE_KEY, JSON.stringify(states));
    return true;
  } catch {
    return false;
  }
}

async function fetchDocumentState(record) {
  if (!record?.documentId) return null;
  const response = await fetch(ocrApiUrl(`/api/documents/${encodeURIComponent(record.documentId)}/annotations`));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "无法读取批注记录");
  return payload;
}

async function persistDocumentState(record, annotations, groups) {
  saveLocalDocumentState(record, annotations, groups);
  if (!record?.documentId) return { ok: true, local: true };
  const response = await fetch(ocrApiUrl(`/api/documents/${encodeURIComponent(record.documentId)}/annotations`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations, groups }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "批注同步失败");
  if (payload.updated_at) saveLocalDocumentState(record, annotations, groups, payload.updated_at);
  return payload;
}

function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

function estimateTextPageCount(content) {
  const text = String(content || "").trim();
  return text ? Math.max(1, Math.ceil(text.length / 1800)) : 1;
}

function inferPageCount(record) {
  const stored = Number(record?.pageCount ?? record?.pages ?? record?.totalPages);
  if (Number.isFinite(stored) && stored > 0) return Math.max(1, Math.floor(stored));
  if (record?.name === "Academic Vocabulary · Unit 04") return 24;
  return typeof record?.content === "string" ? estimateTextPageCount(record.content) : 1;
}

function normalizeDocument(record, ownerId, index) {
  return {
    ...record,
    id: record.id || `doc-${ownerId}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    favorite: typeof record.favorite === "boolean" ? record.favorite : false,
    objectUrl: record.objectUrl || (record.documentId ? ocrApiUrl(`/api/documents/${encodeURIComponent(record.documentId)}/file`) : undefined),
    pageCount: inferPageCount(record),
    currentPage: Math.max(1, Math.min(inferPageCount(record), Number(record.currentPage) || (record.name === "Academic Vocabulary · Unit 04" ? 4 : 1))),
  };
}

function normalizeCollections(value) {
  const source = Array.isArray(value) ? value : DEFAULT_COLLECTIONS;
  const starterDocumentNames = new Set([
    "IELTS 高频词汇", "口语表达积累", "写作替换词", "考研核心词汇", "AI Note 产品分析",
    "用户访谈记录", "阅读工具竞品报告", "功能路线图", "Retrieval Augmented Generation",
    "Attention Is All You Need", "Human-AI Interaction",
  ]);
  return source.flatMap(collection => {
    const originalDocuments = collection.documents || [];
    const onlyStarterDocuments = originalDocuments.length > 0 && originalDocuments.every(doc => starterDocumentNames.has(doc.name));
    if (onlyStarterDocuments && ["product", "papers"].includes(collection.id)) return [];
    return [{
      ...collection,
      documents: originalDocuments.filter(doc => !starterDocumentNames.has(doc.name)).map((doc, index) => normalizeDocument(doc, collection.id, index)),
    }];
  });
}

function persistLibrary(collections, unfiled, deleted) {
  const stripObjectUrls = records => records.map(({ objectUrl, ...record }) => record);
  writeStored("noteflow-collections", collections.map(collection => ({ ...collection, documents: stripObjectUrls(collection.documents) })));
  writeStored("noteflow-unfiled", stripObjectUrls(unfiled));
  writeStored("noteflow-deleted", stripObjectUrls(deleted));
}

function useToast() {
  const [toast, setToast] = useState("");
  const timer = useRef(null);
  const showToast = useCallback(message => {
    setToast(String(message));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(""), 2300);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [toast, showToast];
}

function useSpeech() {
  const active = useRef(null);
  const speak = useCallback((text, key, language = null) => {
    if (!("speechSynthesis" in window)) return;
    if (active.current === key && window.speechSynthesis.speaking) {
      window.speechSynthesis.cancel();
      active.current = null;
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text).trim());
    utterance.lang = language || (/[㐀-鿿]/.test(String(text)) ? "zh-CN" : "en-US");
    const rate = Number(localStorage.getItem("noteflow-speech-rate"));
    utterance.rate = Number.isFinite(rate) ? Math.min(1.4, Math.max(.6, rate)) : .95;
    utterance.onend = () => { active.current = null; };
    utterance.onerror = utterance.onend;
    active.current = key;
    window.speechSynthesis.speak(utterance);
  }, []);
  return speak;
}

function buildSpeechText(note) {
  return note.translation ? `${note.text}。${note.translation}` : note.text;
}

function getDocumentEntries(collections, unfiled, deleted) {
  return [
    ...collections.flatMap(collection => collection.documents.map((document, index) => ({ document, ownerId: collection.id, index }))),
    ...unfiled.map((document, index) => ({ document, ownerId: "unfiled", index })),
    ...deleted.map((document, index) => ({ document, ownerId: "deleted", index })),
  ];
}

function useLibraryState() {
  const [collections, setCollections] = useState(() => normalizeCollections(readStored("noteflow-collections", DEFAULT_COLLECTIONS)));
  const [unfiled, setUnfiled] = useState(() => (readStored("noteflow-unfiled", []) || []).map((doc, index) => normalizeDocument(doc, "unfiled", index)));
  const [deleted, setDeleted] = useState(() => (readStored("noteflow-deleted", []) || []).map((doc, index) => normalizeDocument(doc, "deleted", index)));
  const [libraryView, setLibraryView] = useState("all");
  const [expandedCollectionId, setExpandedCollectionId] = useState("english");
  const [selectedDocumentId, setSelectedDocumentId] = useState("sample-academic-vocabulary");

  const allEntries = useMemo(() => getDocumentEntries(collections, unfiled, deleted), [collections, unfiled, deleted]);
  const currentEntry = allEntries.find(entry => entry.document.id === selectedDocumentId) || allEntries[0];

  useEffect(() => {
    persistLibrary(collections, unfiled, deleted);
  }, [collections, unfiled, deleted]);

  useEffect(() => {
    let cancelled = false;
    fetch(ocrApiUrl("/api/documents"))
      .then(response => response.ok ? response.json() : null)
      .then(payload => {
        if (cancelled || !Array.isArray(payload?.documents)) return;
        const known = new Set(getDocumentEntries(collections, unfiled, deleted).map(entry => entry.document.documentId).filter(Boolean));
        const restored = payload.documents
          .filter(document => document.document_id && !known.has(document.document_id))
          .map((document, index) => normalizeDocument({ id: `server-${document.document_id}`, documentId: document.document_id, jobId: document.job_id, name: document.filename.replace(/\.[^.]+$/, ""), type: "pdf", processingStatus: document.status }, "unfiled", index));
        if (restored.length) setUnfiled(previous => [...restored, ...previous]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const updateDocument = useCallback((ownerId, index, updater) => {
    const setter = ownerId === "unfiled" ? setUnfiled : ownerId === "deleted" ? setDeleted : setCollections;
    setter(previous => {
      if (ownerId === "unfiled" || ownerId === "deleted") {
        return previous.map((doc, itemIndex) => itemIndex === index ? updater(doc) : doc);
      }
      return previous.map(collection => collection.id === ownerId
        ? { ...collection, documents: collection.documents.map((doc, itemIndex) => itemIndex === index ? updater(doc) : doc) }
        : collection);
    });
  }, []);

  return {
    collections, setCollections, unfiled, setUnfiled, deleted, setDeleted,
    libraryView, setLibraryView, expandedCollectionId, setExpandedCollectionId,
    selectedDocumentId, setSelectedDocumentId, allEntries, currentEntry, updateDocument,
  };
}

function ColorDot({ color, meta, active, onClick, onDoubleClick }) {
  return <Tooltip title={`${meta.label}${active ? " · 当前颜色" : ""}`}><AntButton type="text" className={`nf-color-dot ${active ? "active" : ""}`} style={{ background: meta.hex }} data-color={color} aria-label={meta.label} onClick={() => onClick(color)} onDoubleClick={() => onDoubleClick?.(color)} /> </Tooltip>;
}

function Topbar({ currentFileName, saveState, onExport, onToggleLibrary }) {
  return <Layout.Header className="nf-header">
    <Space className="nf-brand" size={10}><span className="nf-brand-mark">N</span><Typography.Text strong>NoteFlow</Typography.Text></Space>
    <Space className="nf-document-title" size={10}>
      <Tag color="green">PDF</Tag>
      <div><Typography.Text strong ellipsis={{ tooltip: currentFileName }} id="currentFileName">{currentFileName}</Typography.Text><Typography.Text type="secondary" id="saveState">{saveState}</Typography.Text></div>
    </Space>
    <Space className="nf-header-actions" size={8}>
      <Tooltip title="打开资料库"><AntButton className="nf-mobile-action" type="text" id="libraryToggle" aria-label="打开资料库" icon={<AppstoreOutlined />} onClick={() => { flushSync(() => onToggleLibrary?.()); globalThis.document.getElementById("libraryPanel")?.classList.add("open"); }} /></Tooltip>
      <Dropdown menu={{ items: [{ key: "share", label: "复制当前地址", icon: <ShareAltOutlined /> }], onClick: () => navigator.clipboard?.writeText(location.href) }} placement="bottomRight">
        <AntButton type="text" icon={<ShareAltOutlined />}>分享</AntButton>
      </Dropdown>
      <AntButton id="exportTopBtn" type="primary" icon={<DownloadOutlined />} onClick={onExport}>导出</AntButton>
      <Tooltip title="个人资料"><Avatar size={32} style={{ background: "#246b57" }}>YX</Avatar></Tooltip>
    </Space>
  </Layout.Header>;
}

function LibraryPanel({ state, onImport, onNewCollection, onContextMenu, collapsed, mobileOpen = false, onCollapse, onToggleMobile, onOpenSettings }) {
  const { collections, unfiled, deleted, libraryView, setLibraryView, expandedCollectionId, setExpandedCollectionId, currentEntry, setSelectedDocumentId } = state;
  const entries = libraryView === "deleted"
    ? deleted.map((document, index) => ({ document, ownerId: "deleted", index }))
    : libraryView === "favorites"
      ? getDocumentEntries(collections, unfiled, []).filter(entry => entry.document.favorite)
      : null;
  const visibleCollections = libraryView === "all" ? [...collections, ...(unfiled.length ? [{ id: "unfiled", name: "未分类", tone: "neutral", icon: "Inbox", documents: unfiled }] : [])] : [];
  const allCount = collections.reduce((sum, item) => sum + item.documents.length, unfiled.length);
  const favoriteCount = getDocumentEntries(collections, unfiled, []).filter(entry => entry.document.favorite).length;

  const navItems = [
    { key: "all", icon: <InboxOutlined />, label: <Space size={6}>全部文档 <Badge id="allDocsCount" count={allCount} showZero /></Space> },
    { key: "favorites", icon: <StarOutlined />, label: <Space size={6}>已收藏 <Badge id="favoriteDocsCount" count={favoriteCount} showZero /></Space> },
    { key: "deleted", icon: <Icon name="Trash2" />, label: <Space size={6}>最近删除 <Badge id="deletedDocsCount" count={deleted.length} showZero /></Space> },
  ];
  const collectionItems = libraryView === "all" ? visibleCollections : [{ id: libraryView, name: libraryView === "deleted" ? "最近删除" : "已收藏", tone: "neutral", icon: libraryView === "deleted" ? "Trash2" : "Star", documents: entries.map(item => item.document), entryIndexes: entries }];
  return <Layout.Sider className={`nf-sider nf-library ${mobileOpen ? "open" : ""}`} id="libraryPanel" width={264} collapsedWidth={64} collapsed={collapsed} trigger={null} theme="light">
    <div className="nf-sider-header"><Space size={9}><span className="nf-section-icon"><InboxOutlined /></span><Typography.Text strong>我的资料库</Typography.Text></Space><Space size={2} className="nf-sider-actions"><Tooltip title="打开设置"><AntButton type="text" href="/settings.html" aria-label="打开设置" icon={<SettingOutlined />} /></Tooltip><Tooltip title={collapsed ? "展开资料库" : "收起资料库"}><AntButton type="text" id="libraryCollapseBtn" aria-label={collapsed ? "展开资料库" : "收起资料库"} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={onCollapse} /></Tooltip><Tooltip title="关闭"><AntButton type="text" className="nf-mobile-action" aria-label="关闭资料库" icon={<Icon name="X" />} onClick={() => globalThis.document.getElementById("libraryPanel")?.classList.remove("open")} /></Tooltip></Space></div>
    {!collapsed && <div className="nf-sider-content">
      <Card className="nf-upload-card" size="small" hoverable onClick={onImport}>
        <Space><CloudUploadOutlined className="nf-upload-icon" /><span><Typography.Text strong>导入文档</Typography.Text><Typography.Text type="secondary">PDF、TXT 或 Markdown</Typography.Text></span></Space>
      </Card>
      <Menu mode="inline" selectedKeys={[libraryView]} items={navItems} onClick={({ key }) => setLibraryView(key)} className="nf-library-menu" />
      <div className="nf-section-heading"><Typography.Text type="secondary">收藏夹</Typography.Text><Tooltip title="新建收藏夹"><AntButton type="text" size="small" aria-label="新建收藏夹" icon={<PlusOutlined />} onClick={() => flushSync(() => onNewCollection())} /></Tooltip></div>
      <Collapse accordion activeKey={libraryView === "all" ? (expandedCollectionId || undefined) : libraryView} bordered={false} className="nf-collections" onChange={key => { if (libraryView === "all") setExpandedCollectionId(Array.isArray(key) ? key[0] : key || null); }} items={collectionItems.map(collection => {
        const isVirtual = libraryView !== "all";
        const docs = collection.documents || [];
        const virtualEntries = collection.entryIndexes || [];
        return { key: collection.id, label: <div className="nf-collection-label" data-collection-id={collection.id} onContextMenu={event => onContextMenu(event, { kind: "collection", collectionId: collection.id })}><Space size={8}><FolderOpenOutlined /><span><Typography.Text strong>{collection.name}</Typography.Text><Typography.Text type="secondary">{docs.length} 个文档</Typography.Text></span></Space></div>, children: docs.length ? <List className="nf-document-list" size="small" split={false} dataSource={docs} renderItem={(document, index) => <DocumentButton key={document.id} document={document} ownerId={isVirtual ? (virtualEntries[index]?.ownerId || (libraryView === "deleted" ? "deleted" : "unfiled")) : collection.id} index={isVirtual ? (virtualEntries[index]?.index ?? index) : index} active={currentEntry?.document.id === document.id} onOpen={() => setSelectedDocumentId(document.id)} onContextMenu={onContextMenu} />} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无文档" /> };
      })} />
      <Card className="nf-storage-card" size="small"><Space direction="vertical" size={6} style={{ width: "100%" }}><Space style={{ width: "100%", justifyContent: "space-between" }}><Typography.Text type="secondary">本地资料空间</Typography.Text><Typography.Text strong>1.8 / 5 GB</Typography.Text></Space><Progress percent={36} showInfo={false} size="small" strokeColor="#246b57" /></Space></Card>
    </div>}
  </Layout.Sider>;
}

function DocumentButton({ document, ownerId, index, active, onOpen, onContextMenu }) {
  const icon = document.type === "pdf" ? "FileText" : document.type === "md" ? "FileCode2" : "File";
  return <AntButton type="text" block className={`nf-document-button ${active ? "active" : ""}`} data-document-name={document.name} data-document-owner={ownerId} data-document-index={index} onClick={onOpen} onContextMenu={event => onContextMenu(event, { kind: "document", ownerId, index })}>
    <Space size={8} className="nf-document-button-main"><Icon name={icon} /><Typography.Text ellipsis={{ tooltip: document.name }}>{document.name}</Typography.Text></Space><Icon name={ownerId === "deleted" ? "RotateCcw" : "Star"} className={`nf-document-star ${document.favorite ? "is-favorite" : ""}`} />
  </AntButton>;
}

function ReaderToolbar({ activeTool, setActiveTool, colors, activeColor, setActiveColor, onAddColor, onUndo, onClear, canUndo, currentPage, totalPages, onPage, zoom, setZoom, onToggleInsights, supportsRegionOcr = false, showOcrBoxes = false, setShowOcrBoxes }) {
  const tools = [['highlight', 'Highlighter', '荧光笔'], ['select', 'MousePointer2', '文字选择'], ['erase', 'Eraser', '橡皮擦']];
  return <Card className="nf-reader-toolbar" size="small" bordered={false}>
    <Space wrap size={[10, 8]}>
      <Segmented value={activeTool} onChange={value => setActiveTool(value)} options={tools.map(([value, icon, label]) => ({ value, label: <Tooltip title={label}><span className="nf-segmented-icon"><Icon name={icon} /></span></Tooltip> }))} />
      <Divider type="vertical" />
      <Space size={4}><Tooltip title={supportsRegionOcr ? "框选区域并识别文字" : "仅 PDF 支持区域识别"}><AntButton id="ocrRegionTool" type={activeTool === "ocr-region" ? "primary" : "default"} aria-label="框选区域识别" disabled={!supportsRegionOcr} icon={<Icon name="ScanText" />} onClick={() => setActiveTool("ocr-region")} /></Tooltip><Tooltip title={supportsRegionOcr ? (showOcrBoxes ? "隐藏 OCR 定位框" : "显示 OCR 定位框") : "仅 PDF 支持 OCR 定位框"}><AntButton type={showOcrBoxes ? "primary" : "default"} aria-label={showOcrBoxes ? "隐藏 OCR 定位框" : "显示 OCR 定位框"} disabled={!supportsRegionOcr} icon={<Icon name="ScanEye" />} onClick={() => setShowOcrBoxes?.(value => !value)} /></Tooltip><Tooltip title="清除全部标记"><AntButton id="clearAllMarks" icon={<Icon name="PaintbrushVertical" />} onClick={onClear} /></Tooltip></Space>
      <Space className="nf-color-tools" size={5} aria-label="荧光笔颜色">{Object.entries(colors).map(([color, meta]) => <ColorDot key={color} color={color} meta={meta} active={activeColor === color} onClick={setActiveColor} onDoubleClick={color => document.dispatchEvent(new CustomEvent("noteflow-edit-color", { detail: color }))} />)}<Tooltip title="添加颜色"><AntButton type="dashed" className="nf-color-add" aria-label="打开调色盘" icon={<PlusOutlined />} onClick={onAddColor} /></Tooltip></Space>
      <Space size={4}><Tooltip title="撤销"><AntButton icon={<Icon name="Undo2" />} disabled={!canUndo} onClick={onUndo} /></Tooltip><Tooltip title="重做"><AntButton icon={<Icon name="Redo2" />} disabled /></Tooltip></Space>
      <Space className="nf-reader-controls" size={5}><Tooltip title="上一页"><AntButton aria-label="上一页" icon={<Icon name="ChevronLeft" />} disabled={currentPage <= 1} onClick={() => onPage(currentPage - 1)} /></Tooltip><Space size={4}><InputNumber min={1} max={totalPages} value={currentPage} onChange={onPage} aria-label="当前页码" /><Typography.Text type="secondary">/ {totalPages}</Typography.Text></Space><Tooltip title="下一页"><AntButton aria-label="下一页" icon={<Icon name="ChevronRight" />} disabled={currentPage >= totalPages} onClick={() => onPage(currentPage + 1)} /></Tooltip></Space>
      <Space className="nf-zoom-control" size={5}><Tooltip title="缩小"><AntButton aria-label="缩小" icon={<Icon name="Minus" />} onClick={() => setZoom(zoom - 10)} /></Tooltip><Slider min={25} max={500} step={5} value={zoom} onChange={setZoom} tooltip={{ formatter: value => `${value}%` }} /><Typography.Text type="secondary">{zoom}%</Typography.Text><Tooltip title="放大"><AntButton aria-label="放大" icon={<Icon name="Plus" />} onClick={() => setZoom(zoom + 10)} /></Tooltip><Tooltip title="重置为 100%"><AntButton aria-label="重置为 100%" icon={<Icon name="RotateCcw" />} onClick={() => setZoom(100)} /></Tooltip></Space>
      <Tooltip title="打开批注面板"><AntButton className="nf-mobile-action" aria-label="打开批注面板" icon={<Icon name="PanelRightOpen" />} onClick={() => { flushSync(() => onToggleInsights?.()); globalThis.document.getElementById("insightsPanel")?.classList.add("open"); }} /></Tooltip>
    </Space>
  </Card>;
}

const Word = ({ id, text, mark, onClick, onDoubleClick, onPointerDown }) => <><span className={`word ${mark ? "highlighted" : ""}`} data-id={id} data-color={mark?.color} onClick={onClick} onDoubleClick={onDoubleClick} onPointerDown={onPointerDown}>{text}</span>{mark?.translation && mark.inlineTranslation !== false && <small className="inline-translation">{mark.translation}</small>}</>;

function SamplePaper({ marks, onToggleMark, onRemoveMark, onSelection, activeTool }) {
  const byId = Object.fromEntries(marks.map(mark => [mark.id, mark]));
  const word = (id, text) => <Word id={id} text={text} mark={byId[id]} onClick={event => { event.stopPropagation(); onToggleMark(id, text); }} onDoubleClick={event => { event.stopPropagation(); onRemoveMark?.(id); }} onPointerDown={activeTool === "erase" ? event => { event.stopPropagation(); onRemoveMark?.(id); } : undefined} />;
  const selectionMarks = marks.filter(mark => mark.id.startsWith("selection-"));
  const decorate = (text, keyPrefix) => {
    let parts = [{ text, mark: null, key: `${keyPrefix}-plain` }];
    selectionMarks.forEach(mark => {
      const index = parts.findIndex(part => !part.mark && part.text.includes(mark.text));
      if (index < 0) return;
      const part = parts[index]; const offset = part.text.indexOf(mark.text);
      const next = [];
      if (offset) next.push({ text: part.text.slice(0, offset), mark: null, key: `${part.key}-before` });
      next.push({ text: mark.text, mark, key: `${part.key}-${mark.id}` });
      if (offset + mark.text.length < part.text.length) next.push({ text: part.text.slice(offset + mark.text.length), mark: null, key: `${part.key}-after` });
      parts.splice(index, 1, ...next);
    });
    return parts.map(part => part.mark
      ? <React.Fragment key={part.key}><span className="word highlighted selection-highlight" data-id={part.mark.id} data-color={part.mark.color} onClick={event => { event.stopPropagation(); onToggleMark(part.mark.id, part.mark.text); }} onDoubleClick={event => { event.stopPropagation(); onRemoveMark?.(part.mark.id); }} onPointerDown={activeTool === "erase" ? event => { event.stopPropagation(); onRemoveMark?.(part.mark.id); } : undefined}>{part.text}</span>{part.mark.translation && part.mark.inlineTranslation !== false && <small className="inline-translation">{part.mark.translation}</small>}</React.Fragment>
      : <React.Fragment key={part.key}>{part.text}</React.Fragment>);
  };
  const paperRef = useRef(null);
  const selectionCallback = useRef(onSelection);
  useEffect(() => { selectionCallback.current = onSelection; }, [onSelection]);
  useEffect(() => {
    const root = paperRef.current?.querySelector("#readingCopy");
    if (!root) return undefined;
    const handleSelection = () => {
      if (activeTool !== "highlight") return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !root.contains(selection.anchorNode)) return;
      const text = selection.toString().trim();
      if (!text || selectionMarks.some(mark => mark.text === text)) return;
      selection.removeAllRanges();
      selectionCallback.current?.({ id: `selection-${Date.now()}`, text, page: 4 });
    };
    root.addEventListener("mouseup", handleSelection);
    root.addEventListener("touchend", handleSelection);
    return () => { root.removeEventListener("mouseup", handleSelection); root.removeEventListener("touchend", handleSelection); };
  }, [activeTool, selectionMarks]);
  return <article className="paper" id="paper" ref={paperRef}>
    <div className="paper-topline"><span>04</span><span>ACADEMIC VOCABULARY</span></div>
    <header className="paper-header"><p>CORE LANGUAGE · INTERMEDIATE</p><h1>Ideas, evidence<br />and <em>argument</em></h1><div className="lesson-meta"><span>Reading time</span><strong>12 min</strong><span>Words</span><strong>486</strong></div></header>
    <section className="paper-section"><div className="section-number">A</div><div><h2>Building an argument</h2><p className="instruction">Click or drag across words to highlight them. Your notes are grouped automatically.</p></div></section>
    <div className="reading-copy" id="readingCopy">
      <p>{decorate("In academic writing, an ", "p1-a")}{word("w1", "argument")}{decorate(" is not simply a disagreement. It is a connected series of statements intended to establish a ", "p1-b")}{word("w2", "proposition")}{decorate(". A strong claim must be supported by ", "p1-c")}{word("w3", "credible")}{decorate(" evidence and expressed with precision.", "p1-d")}</p>
      <p>{decorate("Writers must ", "p2-a")}{word("w4", "evaluate")}{decorate(" their sources rather than accept every conclusion. They identify an author's ", "p2-b")}{word("w5", "underlying")}{decorate(" assumptions, compare alternative explanations, and decide whether the available data is ", "p2-c")}{word("w6", "sufficient")}{decorate(".", "p2-d")}</p>
      <blockquote>“The aim is not to remove uncertainty, but to make the reasoning visible.”</blockquote>
      <p>{decorate("A useful paragraph begins with a clear ", "p3-a")}{word("w7", "premise")}{decorate(". It then introduces relevant examples and explains how each one supports the central position. Counterarguments should be acknowledged and, where possible, ", "p3-b")}{word("w8", "refuted")}{decorate(".", "p3-c")}</p>
    </div>
    <section className="paper-section compact"><div className="section-number dark">B</div><div><h2>Key terms in context</h2></div></section>
    <div className="term-grid">{[["w9", "infer", "reach a conclusion from evidence"], ["w10", "valid", "based on sound reasoning"], ["w11", "bias", "an unfair preference or influence"]].map(([id, title, desc]) => <button key={id} className={`term-card word ${byId[id] ? "highlighted" : ""}`} data-id={id} type="button" onClick={() => onToggleMark(id, title)} onDoubleClick={() => onRemoveMark?.(id)} onPointerDown={activeTool === "erase" ? () => onRemoveMark?.(id) : undefined}><b>{title}</b><span>{desc}</span>{byId[id]?.translation && <small className="inline-translation">{byId[id].translation}</small>}</button>)}</div>
    <footer className="paper-footer"><span>Northstar Language Series</span><span>— 18 —</span></footer>
  </article>;
}

function PlainDocument({ record, onSelection, onToggleMark, onRemoveMark, marks = [], activeTool = "highlight", activeColor = "yellow", showToast }) {
  const ref = useRef(null);
  const selectionCallback = useRef(onSelection);
  const colorRef = useRef(activeColor);
  const toggleRef = useRef(onToggleMark);
  const removeRef = useRef(onRemoveMark);
  const toolRef = useRef(activeTool);
  useEffect(() => { selectionCallback.current = onSelection; }, [onSelection]);
  useEffect(() => { colorRef.current = activeColor; }, [activeColor]);
  useEffect(() => { toggleRef.current = onToggleMark; }, [onToggleMark]);
  useEffect(() => { removeRef.current = onRemoveMark; }, [onRemoveMark]);
  useEffect(() => { toolRef.current = activeTool; }, [activeTool]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    root.textContent = record.content || "";
    const handle = () => {
      if (toolRef.current !== "highlight") return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount || !root.contains(selection.anchorNode)) return;
      const range = selection.getRangeAt(0).cloneRange();
      trimRangeWhitespace(range);
      const text = normalizeHighlightText(range.toString());
      if (!highlightTextAllowed(text, showToast)) { selection.removeAllRanges(); return; }
      const marker = globalThis.document.createElement("span");
      marker.className = "word highlighted selection-highlight";
      marker.dataset.id = `selection-${Date.now()}`;
      marker.dataset.page = "1";
      marker.dataset.color = colorRef.current;
      marker.appendChild(range.extractContents());
      range.insertNode(marker);
      selection.removeAllRanges();
      selectionCallback.current({ id: marker.dataset.id, text, page: 1, color: colorRef.current });
    };
    const click = event => { const marker = event.target.closest?.(".selection-highlight"); if (marker) toggleRef.current?.(marker.dataset.id, marker.textContent, Number(marker.dataset.page) || 1); };
    const erase = event => { const marker = event.target.closest?.(".selection-highlight"); if (marker && toolRef.current === "erase") { event.preventDefault(); removeRef.current?.(marker.dataset.id); } };
    const doubleClick = event => { const marker = event.target.closest?.(".selection-highlight"); if (marker) removeRef.current?.(marker.dataset.id); };
    root.onmouseup = handle; root.ontouchend = handle; root.onclick = click; root.onpointerdown = erase; root.ondblclick = doubleClick;
    return () => { root.onmouseup = null; root.ontouchend = null; root.onclick = null; root.onpointerdown = null; root.ondblclick = null; };
    }, [record.id, record.content, showToast]);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    marks.forEach(mark => {
      const node = [...root.querySelectorAll("[data-id]")].find(item => item.dataset.id === mark.id);
      if (node) {
        node.classList.add("highlighted"); node.dataset.color = mark.color || activeColor;
        if (mark.translation && mark.inlineTranslation !== false) { const existing = node.nextElementSibling?.classList.contains("inline-translation") ? node.nextElementSibling : null; const translation = existing || globalThis.document.createElement("small"); translation.className = "inline-translation"; translation.textContent = mark.translation; if (!existing) node.after(translation); }
      }
    });
  }, [marks, activeColor]);
  return <article className="paper plain-paper" id="paper"><h1 className="plain-document-title">{record.name}</h1><div className="reading-copy plain-copy" id="readingCopy" ref={ref} /></article>;
}

function UnavailableDocument({ record }) {
  return <section className="document-empty"><div><Icon name="FileQuestion" /><h2>{record.name}</h2><p>{record.type === "pdf" ? "本地 PDF 访问权限已过期，请重新导入文件。" : "这是示例资料，没有关联本地文件内容。"}</p></div></section>;
}

function PdfDocument({ record, marks = [], zoom, currentPage, onPageCount, onSelection, onToggleMark, onRemoveMark, activeTool = "highlight", activeColor = "yellow", onOcrState, showToast, showOcrBoxes = false }) {
  const containerRef = useRef(null);
  const token = useRef(0);
  const marksRef = useRef(marks);
  const toolRef = useRef(activeTool);
  const colorRef = useRef(activeColor);
  const toggleRef = useRef(onToggleMark);
  const removeRef = useRef(onRemoveMark);
  const selectionRef = useRef(onSelection);
  const pageRef = useRef(currentPage);
  const pressRef = useRef(null);
  const selectionHandledRef = useRef(false);
  const regionRef = useRef(null);
  useEffect(() => { marksRef.current = marks; }, [marks]);
  useEffect(() => { toolRef.current = activeTool; }, [activeTool]);
  useEffect(() => { colorRef.current = activeColor; }, [activeColor]);
  useEffect(() => { toggleRef.current = onToggleMark; }, [onToggleMark]);
  useEffect(() => { removeRef.current = onRemoveMark; }, [onRemoveMark]);
  useEffect(() => { selectionRef.current = onSelection; }, [onSelection]);
  useEffect(() => { pageRef.current = currentPage; }, [currentPage]);
  useEffect(() => {
    let cancelled = false;
    const root = containerRef.current;
    if (!root || !record.objectUrl) return undefined;
    token.current += 1;
    const currentToken = token.current;
    root.innerHTML = `<div class="pdf-pages-frame"><div class="pdf-pages" id="readingCopy"></div></div><div class="pdf-ocr-status" id="pdfOcrStatus" role="status"><span class="pdf-ocr-dot"></span><span>正在检查 OCR...</span></div><div class="pdf-loading" role="status"><span class="spinner"></span><span>正在渲染 PDF...</span></div>`;
    const load = () => {
      if (window.pdfjsLib?.getDocument) return Promise.resolve(window.pdfjsLib);
      return new Promise((resolve, reject) => {
        const script = globalThis.document.querySelector("script[data-noteflow-pdfjs]") || Object.assign(globalThis.document.createElement("script"), { src: PDFJS_SCRIPT_URL, async: true });
        script.dataset.noteflowPdfjs = "true";
        script.onload = () => resolve(window.pdfjsLib);
        script.onerror = reject;
        if (!script.parentNode) globalThis.document.head.append(script);
      }).then(pdfjs => { pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; return pdfjs; });
    };
    const render = async () => {
      const pdfjs = await load();
      const pdf = await pdfjs.getDocument({ url: record.objectUrl }).promise;
      if (cancelled || currentToken !== token.current) return;
      onPageCount(pdf.numPages);
      const ocrStatus = root.querySelector("#pdfOcrStatus");
      const updateOcrStatus = (status, message) => {
        if (ocrStatus) {
          ocrStatus.dataset.status = status;
          ocrStatus.querySelector("span:last-child").textContent = message;
        }
        onOcrState?.({ status, message });
      };
      updateOcrStatus("loading", record.documentId ? "正在读取已保存的 OCR 定位..." : "正在获取 OCR 定位...");
      const ocrPromise = requestPdfOcr(record.objectUrl, record.name, updateOcrStatus, record.documentId, record.jobId).catch(error => ({ ok: false, message: error.name === "AbortError" ? "OCR 响应超时，已使用 PDF.js 文本层" : error.message || "OCR 服务不可用" }));
      const frame = root.querySelector(".pdf-pages-frame");
      const pagesRoot = root.querySelector(".pdf-pages");
      const firstPage = await pdf.getPage(1);
      const availableWidth = Math.max(280, root.clientWidth - 40);
      const baseScale = Math.min(1.65, Math.max(.45, availableWidth / firstPage.getViewport({ scale: 1 }).width));
      const outputScale = Math.min(2, window.devicePixelRatio || 1);
      let height = 0; let width = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = pageNumber === 1 ? firstPage : await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: baseScale });
        const sourceViewport = page.getViewport({ scale: 1 });
        const pageElement = globalThis.document.createElement("article"); pageElement.className = "pdf-page"; pageElement.dataset.pageNumber = String(pageNumber); pageElement.dataset.sourceWidth = String(sourceViewport.width); pageElement.dataset.sourceHeight = String(sourceViewport.height); pageElement.style.width = `${viewport.width}px`; pageElement.style.height = `${viewport.height}px`;
        const canvas = globalThis.document.createElement("canvas"); canvas.className = "pdf-canvas"; canvas.width = Math.ceil(viewport.width * outputScale); canvas.height = Math.ceil(viewport.height * outputScale); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; pageElement.append(canvas);
        const layer = globalThis.document.createElement("div"); layer.className = "pdf-text-layer"; pageElement.append(layer); pagesRoot.append(pageElement);
        const renderTask = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport, transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0] });
        const [content] = await Promise.all([page.getTextContent(), renderTask.promise]);
        content.items.forEach((item, index) => {
          if (!item.str) return;
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.max(1, Math.hypot(tx[2], tx[3]));
          const sourceText = String(item.str).replace(/^\s+|\s+$/g, "");
          const sourceWidth = Math.max(fontHeight * .25, (Number(item.width) || 0) * viewport.scale);
          const segments = splitPdfTextSegments(sourceText);
          const totalLength = Math.max(1, sourceText.length);
          segments.forEach((segment, segmentIndex) => {
            const span = globalThis.document.createElement("span");
            const left = tx[4] + sourceWidth * (segment.start / totalLength);
            const width = Math.max(fontHeight * .18, sourceWidth * ((segment.end - segment.start) / totalLength));
            span.className = "pdf-text-item word";
            span.dataset.id = `pdf-${pageNumber}-${index}-${segmentIndex}`;
            span.dataset.parentId = `pdf-${pageNumber}-${index}`;
            span.dataset.segmentIndex = String(segmentIndex);
            span.dataset.page = String(pageNumber);
            span.dataset.native = "true";
            span.textContent = segment.text;
            span.style.left = `${left}px`;
            span.style.top = `${tx[5] - fontHeight}px`;
            span.style.width = `${width}px`;
            span.style.height = `${fontHeight}px`;
            span.style.fontSize = `${fontHeight}px`;
            layer.append(span);
          });
        });
        height += viewport.height + 18; width = Math.max(width, viewport.width); page.cleanup();
      }
      const applyOcr = ocr => {
        if (cancelled || currentToken !== token.current) return;
        if (ocr?.ok && Array.isArray(ocr.pages)) {
          const pageDataByNumber = new Map(ocr.pages.map(item => [Number(item.page), item]));
          pagesRoot.querySelectorAll(".pdf-page").forEach(pageElement => {
            const pageNumber = Number(pageElement.dataset.pageNumber);
            const pageData = pageDataByNumber.get(pageNumber);
            if (!pageData?.items?.length) return;
            const layer = pageElement.querySelector(".pdf-text-layer");
            const viewportWidth = Number(pageElement.style.width.replace("px", "")) || 1;
            const viewportHeight = Number(pageElement.style.height.replace("px", "")) || 1;
            const sourceWidth = Number(pageData.width) || viewportWidth / baseScale;
            const sourceHeight = Number(pageData.height) || viewportHeight / baseScale;
            const scaleX = viewportWidth / sourceWidth;
            const scaleY = viewportHeight / sourceHeight;
            layer?.querySelectorAll(".pdf-text-item[data-native='true']").forEach(item => {
              if (!marksRef.current.some(mark => mark.id === item.dataset.id)) item.style.display = "none";
            });
            pageElement.dataset.ocrProvider = ocr.provider || "ocr";
            pageData.items.forEach((item, index) => {
              const box = Array.isArray(item.bbox) ? item.bbox : null;
              if (!box || box.length < 4 || !item.text) return;
              const left = Math.max(0, Number(box[0]) * scaleX);
              const top = Math.max(0, Number(box[1]) * scaleY);
              const itemWidth = Math.max(2, (Number(box[2]) - Number(box[0])) * scaleX);
              const itemHeight = Math.max(2, (Number(box[3]) - Number(box[1])) * scaleY);
              const sourceText = String(item.text).replace(/\s+/g, " ").trim();
              const segments = splitPdfTextSegments(sourceText);
              const totalLength = Math.max(1, sourceText.length);
              segments.forEach((segment, segmentIndex) => {
                const span = globalThis.document.createElement("span");
                const segmentLeft = left + itemWidth * (segment.start / totalLength);
                const segmentWidth = Math.max(2, itemWidth * ((segment.end - segment.start) / totalLength));
                const segmentId = `ocr-${pageNumber}-${index}-${segmentIndex}`;
                const parentId = `ocr-${pageNumber}-${index}`;
                const existingMark = marksRef.current.find(mark => Number(mark.page || 1) === pageNumber && !mark.region && (mark.segmentIds?.includes?.(segmentId) || mark.id === segmentId || mark.id === parentId));
                span.className = "pdf-text-item word pdf-ocr-item";
                span.dataset.id = segmentId;
                span.dataset.parentId = parentId;
                span.dataset.segmentIndex = String(segmentIndex);
                span.dataset.page = String(pageNumber);
                span.dataset.ocr = "true";
                span.textContent = segment.text;
                span.title = segment.text;
                span.setAttribute("aria-label", `OCR: ${segment.text}`);
                span.style.left = `${segmentLeft}px`;
                span.style.top = `${top}px`;
                span.style.width = `${segmentWidth}px`;
                span.style.height = `${itemHeight}px`;
                // Keep OCR geometry for hit-testing without painting a second, enlarged text layer.
                span.style.fontSize = "1px";
                span.style.lineHeight = "1px";
                if (existingMark) { span.classList.add("highlighted"); span.dataset.color = existingMark.color || "yellow"; span.dataset.selectionId = existingMark.id; }
                layer?.append(span);
              });
            });
          });
          const count = ocr.pages.filter(page => page.items?.length).length;
          updateOcrStatus("ready", `${ocr.provider === "mineru" ? "MinerU" : "OCR"} 已定位 ${count} 页`);
        } else updateOcrStatus("fallback", `${ocr?.message || "OCR 未返回定位结果"} · 使用 PDF.js 文本层`);
      };
      height = Math.max(0, height - 18); pagesRoot.style.width = `${width}px`; pagesRoot.style.height = `${height}px`; frame.dataset.baseWidth = String(width); frame.dataset.baseHeight = String(height);
      root.querySelector(".pdf-loading")?.remove();
      ocrPromise.then(applyOcr);
      const sync = () => {
        const scale = zoom / 100; pagesRoot.style.transform = `scale(${scale})`; pagesRoot.style.transformOrigin = "top left"; frame.style.width = `${width * scale}px`; frame.style.height = `${height * scale}px`;
        const marker = root.getBoundingClientRect().top + Math.min(160, root.clientHeight * .28); let current = 1; [...root.querySelectorAll(".pdf-page")].forEach(page => { if (page.getBoundingClientRect().top <= marker) current = Number(page.dataset.pageNumber); }); onPageCount(pdf.numPages, current);
      };
      sync();
      root.onscroll = sync;
      const reading = root.querySelector("#readingCopy");
      const normalizeSelectedText = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      const markGroup = target => {
        const source = target?.closest?.(".pdf-text-item");
        const page = source?.closest?.(".pdf-page");
        if (!source || !page || source.style.display === "none" || source.classList.contains("highlighted")) return false;
        // PDF.js and OCR layers are split into word-sized spans before this
        // handler runs. A short press should use only the hit span; drag and
        // freehand paths still use their own continuous-range algorithms.
        const text = normalizeSelectedText(source.textContent);
        if (!text) return false;
        if (!highlightTextAllowed(text, showToast, { allowSingleWord: true })) return false;
        const marker = globalThis.document.createElement("span");
        marker.className = "word highlighted selection-highlight";
        marker.dataset.id = `selection-${Date.now()}`;
        marker.dataset.page = source.dataset.page || String(pageRef.current);
        marker.dataset.color = colorRef.current;
        source.before(marker);
        source.classList.add("highlighted"); source.dataset.color = colorRef.current; source.dataset.selectionId = marker.dataset.id; marker.append(source);
        selectionRef.current?.({ id: marker.dataset.id, text, page: Number(marker.dataset.page) || pageRef.current, color: colorRef.current, segmentIds: [source.dataset.id].filter(Boolean) });
        return true;
      };
      const strokePoint = (page, clientX, clientY) => pagePoint(page, clientX, clientY);
      const updateStrokeOverlay = stroke => {
        if (!stroke?.overlay || stroke.points.length < 2) return;
        const previous = stroke.points[stroke.points.length - 2];
        const current = stroke.points[stroke.points.length - 1];
        const length = Math.hypot(current.x - previous.x, current.y - previous.y);
        if (length < 1) return;
        const segment = globalThis.document.createElement("i");
        segment.className = "pdf-freehand-segment";
        Object.assign(segment.style, {
          left: `${previous.x}px`, top: `${previous.y}px`, width: `${Math.max(3, length)}px`,
          transform: `rotate(${Math.atan2(current.y - previous.y, current.x - previous.x)}rad)`,
        });
        stroke.overlay.append(segment);
      };
      const finishStroke = stroke => {
        if (!stroke || stroke.points.length < 2) return false;
        const minX = Math.min(...stroke.points.map(point => point.x));
        const maxX = Math.max(...stroke.points.map(point => point.x));
        const minY = Math.min(...stroke.points.map(point => point.y));
        const maxY = Math.max(...stroke.points.map(point => point.y));
        const pageRect = stroke.page.getBoundingClientRect();
        const scale = Math.max(.01, pageRect.width / Math.max(1, stroke.page.offsetWidth));
        const geometry = item => {
          const rect = item.getBoundingClientRect();
          const left = (rect.left - pageRect.left) / scale;
          const right = (rect.right - pageRect.left) / scale;
          const top = (rect.top - pageRect.top) / scale;
          const bottom = (rect.bottom - pageRect.top) / scale;
          return { left, right, top, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2, height: Math.max(1, bottom - top) };
        };
        const allItems = [...stroke.page.querySelectorAll(".pdf-text-item")].filter(item => String(item.textContent || "").trim() && item.style.display !== "none" && !item.classList.contains("highlighted") && !item.closest(".selection-highlight"));
        if (!allItems.length) return false;
        const distanceToBox = (point, box) => {
          const dx = point.x < box.left ? box.left - point.x : point.x > box.right ? point.x - box.right : 0;
          const dy = point.y < box.top ? box.top - point.y : point.y > box.bottom ? point.y - box.bottom : 0;
          return Math.hypot(dx, dy);
        };
        const nearest = allItems.reduce((best, item) => {
          const box = geometry(item);
          const distance = Math.min(...stroke.points.map(point => distanceToBox(point, box)));
          return !best || distance < best.distance ? { item, box, distance } : best;
        }, null);
        if (!nearest) return false;
        const mode = getHighlightSegmentation();
        const lineTolerance = nearest.box.height * (mode === "ocr-box" ? 1.2 : .72);
        // Keep the brush close to the actual stroke. A small margin handles a
        // stroke that starts inside a glyph without pulling in the neighbour.
        const horizontalMargin = Math.min(3, nearest.box.height * (mode === "jieba" ? .28 : mode === "ocr-box" ? .12 : .18));
        const lineItems = allItems.filter(item => {
          const box = geometry(item);
          const overlap = Math.min(maxX, box.right) - Math.max(minX, box.left);
          const nearStroke = overlap > Math.min(box.right - box.left, Math.max(1, box.height * .16)) || item === nearest.item;
          return Math.abs(box.centerY - nearest.box.centerY) <= lineTolerance && nearStroke && box.right >= minX - horizontalMargin && box.left <= maxX + horizontalMargin;
        }).sort((left, right) => geometry(left).left - geometry(right).left);
        if (!lineItems.length) return false;
        const nearestIndex = Math.max(0, lineItems.indexOf(nearest.item));
        let first = nearestIndex;
        let last = nearestIndex;
        while (first > 0) {
          const previous = geometry(lineItems[first - 1]);
          const gap = geometry(lineItems[first]).left - previous.right;
          if (previous.right < minX - horizontalMargin || gap > Math.max(previous.height * 1.4, 8)) break;
          first -= 1;
        }
        while (last < lineItems.length - 1) {
          const next = geometry(lineItems[last + 1]);
          const gap = next.left - geometry(lineItems[last]).right;
          if (next.left > maxX + horizontalMargin || gap > Math.max(next.height * 1.4, 8)) break;
          last += 1;
        }
        const candidates = lineItems.slice(first, last + 1);
        if (!candidates.length) return false;
        const text = normalizeSelectedText(candidates.map((item, index) => {
          const content = String(item.textContent || "").trim();
          if (index === candidates.length - 1) return content;
          const next = candidates[index + 1];
          const gap = next.getBoundingClientRect().left - item.getBoundingClientRect().right;
          const boundary = item.dataset.ocr ? gap > Math.max(2, item.getBoundingClientRect().height * .18) : /\s$/.test(item.textContent || "") || gap > 3;
          return `${content}${boundary ? " " : ""}`;
        }).join(""));
        if (!highlightTextAllowed(text, showToast, { allowSingleWord: true })) return false;
        const marker = globalThis.document.createElement("span");
        marker.className = "word highlighted selection-highlight";
        marker.dataset.id = `selection-${Date.now()}`;
        marker.dataset.page = stroke.page.dataset.pageNumber || String(pageRef.current);
        marker.dataset.color = colorRef.current;
        candidates[0].before(marker);
        candidates.forEach(item => { item.classList.add("highlighted"); item.dataset.color = colorRef.current; item.dataset.selectionId = marker.dataset.id; marker.append(item); });
        selectionRef.current?.({ id: marker.dataset.id, text, page: Number(marker.dataset.page) || pageRef.current, color: colorRef.current, segmentIds: candidates.map(item => item.dataset.id).filter(Boolean) });
        return true;
      };
      const handleSelection = () => {
          if (toolRef.current !== "highlight") return;
          const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount || !reading.contains(selection.anchorNode)) return;
          const range = selection.getRangeAt(0).cloneRange(); trimRangeWhitespace(range); const text = normalizeSelectedText(range.toString()); if (!text || !highlightTextAllowed(text, showToast)) { selection.removeAllRanges(); return; }
          if (range.commonAncestorContainer.parentElement?.closest?.(".selection-highlight")) { selection.removeAllRanges(); return; }
          if ([...reading.querySelectorAll(".pdf-text-item.highlighted")].some(item => { try { return range.intersectsNode(item); } catch { return false; } })) { selection.removeAllRanges(); return; }
          const marker = globalThis.document.createElement("span"); marker.className = "word highlighted selection-highlight"; marker.dataset.id = `selection-${Date.now()}`; marker.dataset.page = range.startContainer.parentElement?.closest?.(".pdf-page")?.dataset.pageNumber || String(pageRef.current); marker.dataset.color = colorRef.current; marker.appendChild(range.extractContents()); range.insertNode(marker); const segmentIds = [...marker.querySelectorAll(".pdf-text-item")].map(item => item.dataset.id).filter(Boolean); marker.querySelectorAll(".pdf-text-item").forEach(item => { item.classList.add("highlighted"); item.dataset.color = colorRef.current; item.dataset.selectionId = marker.dataset.id; }); selection.removeAllRanges(); selectionHandledRef.current = true; globalThis.setTimeout(() => { selectionHandledRef.current = false; }, 120); selectionRef.current?.({ id: marker.dataset.id, text, page: Number(marker.dataset.page) || pageRef.current, color: colorRef.current, segmentIds });
      };
      const pagePoint = (page, clientX, clientY) => {
        const rect = page.getBoundingClientRect();
        const scale = Math.max(.01, rect.width / Math.max(1, page.offsetWidth));
        return { x: Math.max(0, Math.min(page.offsetWidth, (clientX - rect.left) / scale)), y: Math.max(0, Math.min(page.offsetHeight, (clientY - rect.top) / scale)) };
      };
      const updateRegionOverlay = region => {
        if (!region?.overlay) return;
        const left = Math.min(region.start.x, region.current.x);
        const top = Math.min(region.start.y, region.current.y);
        const width = Math.abs(region.current.x - region.start.x);
        const height = Math.abs(region.current.y - region.start.y);
        Object.assign(region.overlay.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      };
      const beginRegion = event => {
        const page = event.target.closest?.(".pdf-page");
        if (!page) return;
        const start = pagePoint(page, event.clientX, event.clientY);
        const overlay = globalThis.document.createElement("div");
        overlay.className = "pdf-region-selection";
        page.append(overlay);
        regionRef.current = { page, start, current: start, overlay, pointerId: event.pointerId };
        updateRegionOverlay(regionRef.current);
        reading.style.touchAction = "none";
        reading.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      };
      const finishRegion = async event => {
        const region = regionRef.current;
        if (!region) return;
        region.current = pagePoint(region.page, event.clientX, event.clientY);
        updateRegionOverlay(region);
        regionRef.current = null;
        reading.style.touchAction = "";
        reading.releasePointerCapture?.(region.pointerId);
        const left = Math.min(region.start.x, region.current.x);
        const top = Math.min(region.start.y, region.current.y);
        const width = Math.abs(region.current.x - region.start.x);
        const height = Math.abs(region.current.y - region.start.y);
        if (width < 8 || height < 8) { region.overlay.remove(); return; }
        const canvas = region.page.querySelector(".pdf-canvas");
        if (!canvas) { region.overlay.remove(); return; }
        const sx = Math.max(0, Math.floor(left / Math.max(1, region.page.offsetWidth) * canvas.width));
        const sy = Math.max(0, Math.floor(top / Math.max(1, region.page.offsetHeight) * canvas.height));
        const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(width / Math.max(1, region.page.offsetWidth) * canvas.width)));
        const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(height / Math.max(1, region.page.offsetHeight) * canvas.height)));
        const crop = globalThis.document.createElement("canvas"); crop.width = sw; crop.height = sh;
        crop.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await new Promise(resolve => crop.toBlob(resolve, "image/png"));
        if (!blob) { region.overlay.remove(); return; }
        showToast?.("正在识别框选区域...");
        try {
          const proposedId = `ocr-region-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const sourceWidth = Number(region.page.dataset.sourceWidth) || Math.max(1, region.page.offsetWidth);
          const sourceHeight = Number(region.page.dataset.sourceHeight) || Math.max(1, region.page.offsetHeight);
          const pageScaleX = region.page.offsetWidth / sourceWidth;
          const pageScaleY = region.page.offsetHeight / sourceHeight;
          const ocrBbox = [left / pageScaleX, top / pageScaleY, (left + width) / pageScaleX, (top + height) / pageScaleY];
          const requestFields = {
            page: region.page.dataset.pageNumber || 1,
            engine: getOcrEnginePreference(),
            region_id: proposedId,
            ocr_bbox: JSON.stringify(ocrBbox),
            page_width: sourceWidth,
            page_height: sourceHeight,
            crop_width: sw,
            crop_height: sh,
          };
          if (record.documentId) requestFields.document_id = record.documentId;
          const result = await requestOcr("/api/ocr/region", blob, `page-${region.page.dataset.pageNumber || 1}-region.png`, requestFields);
          const text = normalizeSelectedText(result.text || (result.items || []).map(item => item.text).join(" "));
          if (!result.ok || !text) throw new Error(result.message || "没有识别到文字");
          if (!highlightTextAllowed(text, showToast)) { region.overlay.remove(); return; }
          const id = result.region_id || proposedId;
          region.overlay.className = "pdf-region-highlight word highlighted selection-highlight";
          region.overlay.dataset.id = id;
          region.overlay.dataset.page = region.page.dataset.pageNumber || "1";
          region.overlay.dataset.color = colorRef.current;
          region.overlay.setAttribute("role", "button");
          region.overlay.title = text;
          region.overlay.onclick = () => toggleRef.current?.(id, text, Number(region.overlay.dataset.page) || 1);
          region.overlay.onpointerdown = pointerEvent => { if (toolRef.current === "erase") { pointerEvent.preventDefault(); removeRef.current?.(id); } };
          selectionRef.current?.({ id, text, page: Number(region.overlay.dataset.page) || 1, color: colorRef.current, region: true, bbox: [left, top, left + width, top + height], ocrBbox, pageWidth: sourceWidth, pageHeight: sourceHeight, ocrItems: result.items || [], ocrProvider: result.provider || "ocr", ocrStored: Boolean(result.stored) });
          showToast?.("区域识别完成，已添加整体批注");
        } catch (error) {
          region.overlay.remove();
          showToast?.(error.name === "AbortError" ? "区域识别超时，请检查 OCR 服务" : (error.message || "区域识别失败"));
        }
      };
      reading.onmouseup = () => { if (selectionHandledRef.current || regionRef.current) return; handleSelection(); };
      reading.onpointerdown = event => {
        if (toolRef.current === "ocr-region") { beginRegion(event); return; }
        const target = event.target.closest?.(".pdf-text-item");
        if (toolRef.current === "erase" && target) { event.preventDefault(); removeRef.current?.(target.dataset.selectionId || target.dataset.id); return; }
        if (toolRef.current !== "highlight") return;
        const page = event.target.closest?.(".pdf-page");
        if (page) {
          const point = strokePoint(page, event.clientX, event.clientY);
          const overlay = globalThis.document.createElement("div");
          overlay.className = "pdf-freehand-stroke";
          overlay.dataset.color = colorRef.current;
          page.append(overlay);
          pressRef.current = { target, page, points: [point], overlay, pointerId: event.pointerId, startedAt: performance.now(), x: event.clientX, y: event.clientY, moved: false };
          reading.style.touchAction = "none";
          reading.setPointerCapture?.(event.pointerId);
        }
      };
      reading.onpointermove = event => {
        if (regionRef.current) { regionRef.current.current = pagePoint(regionRef.current.page, event.clientX, event.clientY); updateRegionOverlay(regionRef.current); return; }
        const press = pressRef.current;
        if (!press || !event.buttons) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) {
          press.moved = true;
          event.preventDefault();
          press.points.push(strokePoint(press.page, event.clientX, event.clientY));
          updateStrokeOverlay(press);
        }
      };
      reading.onpointerup = event => {
        if (regionRef.current) { finishRegion(event); return; }
        const press = pressRef.current;
        if (!press) return;
        pressRef.current = null;
        const elapsed = performance.now() - press.startedAt;
        if (toolRef.current === "highlight" && press.moved) {
          finishStroke(press);
          selectionHandledRef.current = true;
          globalThis.setTimeout(() => { selectionHandledRef.current = false; }, 180);
          press.overlay.remove();
        } else if (toolRef.current === "highlight" && !press.moved && elapsed >= 260) {
          window.getSelection()?.removeAllRanges();
          if (markGroup(press.target)) { selectionHandledRef.current = true; globalThis.setTimeout(() => { selectionHandledRef.current = false; }, 180); }
          press.overlay.remove();
        } else {
          press.overlay.remove();
        }
        reading.releasePointerCapture?.(press.pointerId);
        reading.style.touchAction = "";
      };
      reading.onpointercancel = event => { if (regionRef.current) { regionRef.current.overlay.remove(); regionRef.current = null; reading.style.touchAction = ""; reading.releasePointerCapture?.(event.pointerId); } if (pressRef.current?.overlay) pressRef.current.overlay.remove(); if (pressRef.current?.pointerId != null) reading.releasePointerCapture?.(pressRef.current.pointerId); reading.style.touchAction = ""; pressRef.current = null; };
      const handleTextClick = event => {
        const span = event.target.closest?.(".pdf-text-item");
        if (!span || !reading.contains(span)) return;
        if (selectionHandledRef.current) { selectionHandledRef.current = false; return; }
        const marker = event.target.closest?.(".selection-highlight");
        if (marker) { toggleRef.current?.(marker.dataset.id, marker.textContent, Number(marker.dataset.page) || 1, { allowSingleWord: true }); return; }
        const press = pressRef.current; pressRef.current = null;
        if (toolRef.current !== "select" && press && !press.moved && performance.now() - press.startedAt >= 260) {
          if (markGroup(span)) { selectionHandledRef.current = true; globalThis.setTimeout(() => { selectionHandledRef.current = false; }, 180); }
          return;
        }
        if (toolRef.current !== "select" && toolRef.current !== "erase") toggleRef.current?.(span.dataset.selectionId || span.dataset.id, span.textContent, Number(span.dataset.page), { allowSingleWord: true });
      };
      reading.onclick = handleTextClick;
      reading.ondblclick = event => { const span = event.target.closest?.(".pdf-text-item"); if (span) removeRef.current?.(span.dataset.selectionId || span.dataset.id); };
      reading.onpointerover = event => { const span = event.target.closest?.(".pdf-text-item"); if (toolRef.current === "erase" && event.buttons && span) removeRef.current?.(span.dataset.selectionId || span.dataset.id); };
      const loadedMarks = new Map(marksRef.current.map(mark => [mark.id, mark]));
      reading.querySelectorAll("[data-id]").forEach(node => { const mark = loadedMarks.get(node.dataset.id); if (mark) { node.classList.add("highlighted"); node.dataset.color = mark.color || "yellow"; } });
      createPdfRegionOverlays(root, marksRef.current, colorRef.current, toggleRef, removeRef, toolRef);
    };
    render().catch(() => { if (!cancelled) root.innerHTML = `<section class="pdf-error" role="alert"><i data-lucide="file-warning"></i><strong>PDF 暂时无法显示</strong><span>请检查网络后重新导入文件。</span></section>`; });
    return () => { cancelled = true; root.onscroll = null; pressRef.current = null; if (regionRef.current?.overlay) regionRef.current.overlay.remove(); if (regionRef.current?.page) root.querySelector("#readingCopy").style.touchAction = ""; regionRef.current = null; selectionHandledRef.current = false; };
  }, [record.id, record.objectUrl]);
  useEffect(() => {
    const frame = containerRef.current?.querySelector(".pdf-pages-frame"); const pages = containerRef.current?.querySelector(".pdf-pages"); if (!frame || !pages) return; const width = Number(frame.dataset.baseWidth); const height = Number(frame.dataset.baseHeight); if (!width || !height) return; const scale = zoom / 100; pages.style.transform = `scale(${scale})`; frame.style.width = `${width * scale}px`; frame.style.height = `${height * scale}px`;
  }, [zoom]);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const current = new Map(marks.map(mark => [mark.id, mark]));
    createPdfRegionOverlays(root, marks, activeColor, toggleRef, removeRef, toolRef);
    root.querySelectorAll(".selection-highlight[data-id]").forEach(marker => {
      const mark = current.get(marker.dataset.id);
      if (!mark) {
        const parent = marker.parentNode;
        if (parent) { if (marker.classList.contains("pdf-region-highlight")) marker.remove(); else { while (marker.firstChild) parent.insertBefore(marker.firstChild, marker); marker.remove(); } }
        return;
      }
      marker.classList.add("highlighted"); marker.dataset.color = mark.color || activeColor;
      marker.querySelectorAll(".pdf-text-item").forEach(item => { item.classList.add("highlighted"); item.dataset.color = mark.color || activeColor; item.dataset.selectionId = marker.dataset.id; });
    });
    root.querySelectorAll("[data-id]").forEach(node => {
      const mark = current.get(node.dataset.id) || (node.dataset.selectionId ? current.get(node.dataset.selectionId) : null);
      node.classList.toggle("highlighted", Boolean(mark));
      if (mark?.color) node.dataset.color = mark.color;
    });
  }, [marks]);
  return <div className={`pdf-container ${showOcrBoxes ? "show-ocr-boxes" : ""}`} ref={containerRef} aria-label={record.name} />;
}

function Reader({ record: recordProp, document: legacyDocument, marks, setMarks, activeTool, setActiveTool, activeColor, setActiveColor, colors, setColors, zoom, setZoom, currentPage, setCurrentPage, totalPages, setTotalPages, history, setHistory, showToast }) {
  const record = recordProp || legacyDocument;
  const [showOcrBoxes, setShowOcrBoxes] = useState(() => readStored("noteflow-show-ocr-boxes", true));
  const selectionJustHandled = useRef(false);
  const commitMarks = useCallback(next => { setHistory(previous => [...previous, marks]); setMarks(next); }, [marks, setHistory, setMarks]);
  const toggleMark = useCallback((id, text, page = currentPage, options = {}) => {
    if (activeTool === "select") return;
    const existing = marks.find(mark => mark.id === id);
    if (activeTool === "erase") { if (existing) commitMarks(marks.filter(mark => mark.id !== id)); return; }
    if (!existing && !highlightTextAllowed(text, showToast, options)) return;
    const next = existing ? marks.map(mark => mark.id === id ? { ...mark, color: activeColor, page } : mark) : [...marks, { id, text, color: activeColor, page }];
    commitMarks(next); showToast(existing ? "已更新分组颜色" : "已添加勾画");
  }, [activeTool, activeColor, commitMarks, currentPage, marks, showToast]);
  const addSelection = useCallback(selection => {
    if (activeTool !== "highlight" && !selection?.region) return;
    const text = normalizeHighlightText(selection?.text);
    if (!highlightTextAllowed(text, showToast)) return;
    selectionJustHandled.current = true;
    setTimeout(() => { selectionJustHandled.current = false; }, 0);
    commitMarks([...marks, { ...selection, text, color: activeColor }]);
  }, [activeTool, activeColor, commitMarks, marks, showToast]);
  const undo = useCallback(() => { if (!history.length) return; const previous = history.at(-1); setHistory(history.slice(0, -1)); setMarks(previous); }, [history, setHistory, setMarks]);
  const clearMarks = useCallback(() => { if (!marks.length) return showToast("当前文档没有标记"); setHistory(previous => [...previous, marks]); setMarks([]); showToast(`已清除 ${marks.length} 条标记，可撤销`); }, [marks, setHistory, setMarks, showToast]);
  const removeMark = useCallback(id => { const existing = marks.find(mark => mark.id === id); if (!existing) return; setHistory(previous => [...previous, marks]); setMarks(marks.filter(mark => mark.id !== id)); }, [marks, setHistory, setMarks]);
  useEffect(() => { const handler = () => clearMarks(); document.addEventListener("noteflow-clear-marks", handler); return () => document.removeEventListener("noteflow-clear-marks", handler); }, [clearMarks]);
  const onPage = next => { const value = Math.max(1, Math.min(totalPages, Math.floor(Number(next) || 1))); setCurrentPage(value); };
  const onAddColor = () => { const input = document.createElement("input"); input.type = "color"; input.value = "#4da8da"; input.onchange = event => { const id = `custom-${Date.now()}`; setColors(previous => ({ ...previous, [id]: { label: `自定义颜色 ${Object.keys(previous).length - 3}`, hex: event.target.value } })); setActiveColor(id); }; input.click(); };
  useEffect(() => { writeStored("noteflow-show-ocr-boxes", showOcrBoxes); }, [showOcrBoxes]);
  return <section className="nf-reader"><ReaderToolbar {...{ activeTool, setActiveTool, colors, activeColor, setActiveColor, onAddColor, onUndo: undo, onClear: clearMarks, canUndo: history.length > 0, currentPage, totalPages, onPage, zoom, setZoom, showOcrBoxes, setShowOcrBoxes }} supportsRegionOcr={record.type === "pdf" && Boolean(record.objectUrl)} onToggleInsights={() => globalThis.document.dispatchEvent(new CustomEvent("noteflow-open-insights"))} />
    <div className="document-stage" id="documentStage">{record.type === "pdf" && record.objectUrl ? <PdfDocument record={record} marks={marks} zoom={zoom} currentPage={currentPage} onPageCount={(count, page) => { setTotalPages(count); if (page) setCurrentPage(page); }} onSelection={addSelection} onToggleMark={toggleMark} onRemoveMark={removeMark} activeTool={activeTool} activeColor={activeColor} onOcrState={onOcrState => { if (onOcrState?.message && onOcrState.status === "error") showToast(onOcrState.message); }} showToast={showToast} showOcrBoxes={showOcrBoxes} /> : typeof record.content === "string" ? <PlainDocument record={record} marks={marks} onSelection={addSelection} onToggleMark={toggleMark} onRemoveMark={removeMark} activeTool={activeTool} activeColor={activeColor} showToast={showToast} /> : record.name === "Academic Vocabulary · Unit 04" ? <SamplePaper marks={marks} onToggleMark={toggleMark} onRemoveMark={removeMark} onSelection={addSelection} activeTool={activeTool} /> : <UnavailableDocument record={record} />}</div>
  </section>;
}

function NoteCard({ note, result = false, selected, onSelect, onDelete, onSpeak, onFocus }) {
  return <List.Item className={result ? "nf-result-item" : "nf-note-item"} data-note-id={result ? undefined : note.id} data-result-note-id={result ? note.id : undefined} onClick={() => onFocus(note.id)}>
    <Space align="start" size={9} className="nf-note-body">
      {!result && <Checkbox checked={selected} onChange={event => { event.stopPropagation(); onSelect(note.id, event.target.checked); }} aria-label={`选择 ${note.text}`} />}
      <div className="nf-note-copy"><Typography.Text strong ellipsis={{ tooltip: note.text }}>{note.text}</Typography.Text>{result ? <Typography.Paragraph type="success" ellipsis={{ rows: 2 }}>{note.translation}</Typography.Paragraph> : <Typography.Text type="secondary" className="nf-note-meta">P.{note.page || 1} · {note.region ? "区域 OCR" : note.ocrProvider ? "OCR 定位" : "文本批注"}</Typography.Text>}</div>
    </Space>
    <Space size={2} className="nf-note-actions">
      <Tooltip title="朗读"><AntButton type="text" size="small" data-speak={result ? `result:${note.id}` : `note:${note.id}`} aria-label="朗读勾画和处理结果" icon={<Icon name="Volume2" />} onClick={event => { event.stopPropagation(); onSpeak(buildSpeechText(note), `${result ? "result" : "note"}:${note.id}`); }} /></Tooltip>
      {!result && <Tooltip title="删除批注"><AntButton type="text" danger size="small" aria-label="删除批注" icon={<Icon name="Trash2" />} onClick={event => { event.stopPropagation(); onDelete(note.id); }} /></Tooltip>}
    </Space>
  </List.Item>;
}

function GroupSection({ color, meta, notes, collapsed, result, selectedIds, onToggle, onSelect, onSelectGroup, onDelete, onSpeak, onFocus, onEdit, onMerge, dragDisabled = false }) {
  const selectedCount = notes.filter(note => selectedIds.has(note.id)).length;
  const handleDrop = event => { event.preventDefault(); const source = event.dataTransfer.getData("text/noteflow-group"); if (source && source !== color) onMerge?.(source, color); };
  return <section className={`nf-group ${collapsed ? "collapsed" : ""}`} data-group-color={result ? undefined : color} data-result-group={result ? color : undefined} aria-expanded={!collapsed} onDragOver={event => { if (!dragDisabled) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; event.currentTarget.classList.add("drop-target"); } }} onDragLeave={event => event.currentTarget.classList.remove("drop-target")} onDrop={event => { event.currentTarget.classList.remove("drop-target"); handleDrop(event); }}>
    <div className="nf-group-header" draggable={!dragDisabled} onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/noteflow-group", color); event.currentTarget.classList.add("dragging"); }} onDragEnd={event => { event.currentTarget.classList.remove("dragging"); if (!result && event.dataTransfer.dropEffect === "none") (globalThis.__noteflowOpenMindmap)?.(); }}>
      <Checkbox className="nf-group-select" checked={notes.length > 0 && selectedCount === notes.length} indeterminate={selectedCount > 0 && selectedCount < notes.length} onClick={event => event.stopPropagation()} onChange={event => onSelectGroup?.(notes, event.target.checked)} aria-label={`选择${meta.label}分组`} />
      <AntButton type="text" className="nf-group-toggle" aria-expanded={!collapsed} title={collapsed ? "展开分组" : "收起分组"} onClick={() => onToggle(color)} icon={<Icon name={collapsed ? "ChevronRight" : "ChevronDown"} />}><span className="nf-group-swatch" style={{ background: meta.hex }} /><Typography.Text strong>{meta.label}</Typography.Text><Badge count={notes.length} showZero /></AntButton><Space size={2}>{!result && <Tooltip title="重命名分组"><AntButton type="text" size="small" aria-label="重命名分组" icon={<Icon name="Pencil" />} onClick={event => { event.stopPropagation(); onEdit(color); }} /></Tooltip>}<Typography.Text type="secondary" className="nf-group-state">{collapsed ? "展开" : "收起"}</Typography.Text></Space>
    </div>
    {!collapsed && <List className="nf-note-list" split={false} dataSource={notes} renderItem={note => <NoteCard key={note.id} note={note} result={result} selected={selectedIds.has(note.id)} onSelect={onSelect} onDelete={onDelete} onSpeak={onSpeak} onFocus={onFocus} />} />}
  </section>;
}

function InsightsPanel({ collapsed, mobileOpen = false, onCollapse, onMobileClose, notes, colors, setColors, activeFilter, setActiveFilter, search, setSearch, collapsedGroups, setCollapsedGroups, collapsedResults, setCollapsedResults, tab, setTab, onDeleteMark, onFocusNote, processor, setProcessor, autoProcess, setAutoProcess, onRunBatch, onOpenPlugin, onRenameColor, showToast, speak, onOpenMindmap, onMergeGroups }) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(notes.map(note => note.id)));
  const knownNoteIds = useRef(new Set(notes.map(note => note.id)));
  const latestNoteIds = useRef(new Set(notes.map(note => note.id)));
  useEffect(() => {
    const currentIds = new Set(notes.map(note => note.id));
    setSelectedIds(previous => {
      const next = new Set([...previous].filter(id => currentIds.has(id)));
      notes.forEach(note => { if (!knownNoteIds.current.has(note.id) || previous.size === 0) next.add(note.id); });
      return next;
    });
    knownNoteIds.current = currentIds;
  }, [notes]);
  useEffect(() => {
    const previousIds = latestNoteIds.current;
    const currentIds = new Set(notes.map(note => note.id));
    const added = notes.filter(note => !previousIds.has(note.id));
    latestNoteIds.current = currentIds;
    if (!added.length || collapsed) return;
    const latest = added[added.length - 1];
    if (tab === "groups" && latest.color && collapsedGroups[latest.color]) {
      setCollapsedGroups(previous => ({ ...previous, [latest.color]: false }));
    }
    // Wait for the new card to render before scrolling the side panel.
    const scrollLatest = () => {
      const node = [...globalThis.document.querySelectorAll("[data-note-id], [data-result-note-id]")]
        .find(item => item.dataset.noteId === latest.id || item.dataset.resultNoteId === latest.id);
      const viewport = node?.closest?.(".insights-content");
      if (!node || !viewport) return;
      const nodeRect = node.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (nodeRect.top < viewportRect.top || nodeRect.bottom > viewportRect.bottom) node.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(scrollLatest));
    else globalThis.setTimeout(scrollLatest, 0);
  }, [notes, collapsed, tab, collapsedGroups, setCollapsedGroups]);
  const normalized = search.trim().toLowerCase();
  const visible = normalized ? notes.filter(note => `${note.text} ${note.translation || ""}`.toLowerCase().includes(normalized)) : notes;
  const colorsToShow = activeFilter === "all" ? Object.keys(colors) : [activeFilter];
  const completed = visible.filter(note => note.translation);
  const selectOne = (id, checked) => setSelectedIds(previous => { const next = new Set(previous); checked ? next.add(id) : next.delete(id); return next; });
  const selectGroup = (groupNotes, checked) => setSelectedIds(previous => { const next = new Set(previous); groupNotes.forEach(note => checked ? next.add(note.id) : next.delete(note.id)); return next; });
  const mergeGroups = (source, target) => {
    if (!colors[source] || !colors[target] || source === target) return;
    const sourceLabel = colors[source].label;
    setColors(previous => { const next = { ...previous }; delete next[source]; return next; });
    (onMergeGroups || globalThis.__noteflowMergeGroups)?.(source, target);
    showToast?.(`已将「${sourceLabel}」合并到「${colors[target].label}」`);
  };
  const openMindmap = () => {
    const sourceNotes = notes;
    if (!sourceNotes.length) return showToast?.("当前文档还没有勾画内容");
    const sourceColors = Object.fromEntries(Object.entries(colors).filter(([key]) => sourceNotes.some(note => note.color === key)));
    (onOpenMindmap || globalThis.__noteflowOpenMindmap)?.(sourceNotes, sourceColors);
  };
  const toggleGroup = (color, result = false) => {
    const setter = result ? setCollapsedResults : setCollapsedGroups;
    setter(previous => ({ ...previous, [color]: !previous[color] }));
  };
  const expandAll = result => (result ? setCollapsedResults({}) : setCollapsedGroups({}));
  return <Layout.Sider className={`nf-sider nf-insights ${mobileOpen ? "open" : ""}`} id="insightsPanel" width={348} collapsedWidth={64} collapsed={collapsed} trigger={null} theme="light">
    <div className="nf-sider-header"><Space direction="vertical" size={2}><Typography.Text type="secondary">智能批注</Typography.Text><Typography.Text strong><span id="noteCount">{notes.length}</span> 条已勾画内容</Typography.Text></Space><Space size={2} className="nf-sider-actions"><Tooltip title="打开设置"><AntButton type="text" href="/settings.html" aria-label="打开设置" icon={<SettingOutlined />} /></Tooltip><Tooltip title={collapsed ? "展开智能批注" : "收起智能批注"}><AntButton type="text" id="insightsCollapseBtn" aria-label={collapsed ? "展开智能批注" : "收起智能批注"} aria-controls="insightsPanel" aria-expanded={!collapsed} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={onCollapse} /></Tooltip><Tooltip title="关闭"><AntButton type="text" className="nf-mobile-action" aria-label="关闭批注面板" icon={<Icon name="X" />} onClick={() => { globalThis.document.getElementById("insightsPanel")?.classList.remove("open"); onMobileClose?.(); }} /></Tooltip></Space></div>
    {!collapsed && <div className="nf-insights-body"><Tabs activeKey={tab} onChange={setTab} items={[{ key: "groups", label: "分组" }, { key: "results", label: <Space size={4}>处理结果 <Badge id="resultBadge" count={notes.filter(note => note.translation).length} showZero /></Space> }]} /></div>}
    {!collapsed && <>
      {tab === "groups" ? <div className="insights-content nf-insights-content" id="groupsView"><Space className="nf-insights-tools" direction="vertical" size={10} style={{ width: "100%" }}><Space.Compact style={{ width: "100%" }}><Input.Search id="noteSearch" value={search} onChange={event => setSearch(event.target.value)} placeholder="查找勾画内容" allowClear /><AntButton id="expandAllGroups" icon={<Icon name="ChevronsDown" />} onClick={() => expandAll(false)}>展开全部</AntButton></Space.Compact><Space wrap className="nf-summary-list">{Object.entries(colors).map(([color, meta]) => <AntButton key={color} type={activeFilter === color ? "primary" : "default"} onClick={() => setActiveFilter(activeFilter === color ? "all" : color)}><span className="nf-group-swatch" style={{ background: meta.hex }} />{meta.label}<Badge count={visible.filter(note => note.color === color).length} showZero /></AntButton>)}</Space><Space className="nf-graph-actions" style={{ width: "100%" }}><AntButton block icon={<Icon name="Network" />} onClick={openMindmap}>按当前分组构建图谱</AntButton><Typography.Text type="secondary">全部 {notes.length} 条</Typography.Text></Space></Space><div className="nf-group-list" id="groupList">{colorsToShow.map(color => { const groupNotes = visible.filter(note => note.color === color); return groupNotes.length ? <GroupSection key={color} color={color} meta={colors[color]} notes={groupNotes} collapsed={Boolean(collapsedGroups[color])} selectedIds={selectedIds} onToggle={toggleGroup} onSelect={selectOne} onSelectGroup={selectGroup} onMerge={mergeGroups} onDelete={onDeleteMark} onSpeak={speak} onFocus={onFocusNote} onEdit={onRenameColor} /> : null; })}</div></div>
        : <div className="insights-content nf-insights-content" id="resultsView"><Space style={{ width: "100%", justifyContent: "flex-end", marginBottom: 10 }}><AntButton id="expandAllResults" icon={<Icon name="ChevronsDown" />} onClick={() => expandAll(true)}>展开全部结果</AntButton></Space><div className="nf-group-list" id="resultList">{completed.length ? Object.keys(colors).map(color => { const resultNotes = completed.filter(note => note.color === color); return resultNotes.length ? <GroupSection key={color} color={color} meta={colors[color]} notes={resultNotes} collapsed={Boolean(collapsedResults[color])} result selectedIds={selectedIds} onToggle={colorId => toggleGroup(colorId, true)} onSelect={selectOne} onDelete={onDeleteMark} onSpeak={speak} onFocus={onFocusNote} onEdit={onRenameColor} /> : null; }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="处理完成的内容会出现在这里" />}</div></div>}
      <Card className="nf-batch-card" size="small" title={<Space><Icon name="Sparkles" />AI 批处理</Space>} extra={<Tooltip title="配置处理插件"><AntButton type="text" aria-label="配置处理插件" icon={<SettingOutlined />} onClick={onOpenPlugin} /></Tooltip>}><Select id="processorSelect" value={processor} onChange={setProcessor} options={[{ value: "translate", label: "Edge 翻译（推荐）" }, { value: "edge-translate", label: "浏览器翻译 API（实验）" }, { value: "offline-translate", label: "中英翻译（离线）" }, { value: "explain", label: "词性 + 简明释义" }, { value: "custom", label: "自定义函数" }]} style={{ width: "100%" }} /><Space className="nf-batch-row" style={{ width: "100%", justifyContent: "space-between" }}><Checkbox id="inlineTranslation" defaultChecked>回填原文下方</Checkbox><Typography.Text type="secondary" id="selectionHint">处理全部 {selectedIds.size || notes.length} 项</Typography.Text></Space><Space className="nf-batch-row" style={{ width: "100%", justifyContent: "space-between" }}><Space size={6}><Switch id="autoProcess" size="small" checked={autoProcess} onChange={setAutoProcess} /><Typography.Text>自动处理新勾画</Typography.Text></Space><Typography.Text type="secondary"><Icon name="Radio" /> 就绪</Typography.Text></Space><AntButton block id="runBatch" type="primary" icon={<Icon name="WandSparkles" />} onClick={() => onRunBatch([...selectedIds])}>开始处理</AntButton><AntButton block type="link" icon={<Icon name="Sheet" />} onClick={() => document.dispatchEvent(new CustomEvent("noteflow-export"))}>导出 Excel 表格</AntButton></Card>
    </>}
  </Layout.Sider>;
}

function ContextMenu({ menu, onAction }) {
  if (!menu) return null;
  const isDocument = menu.target.kind === "document";
  const isDeleted = menu.target.ownerId === "deleted";
  const act = action => flushSync(() => onAction(action));
  return <div className="context-menu ant-dropdown-menu" id="libraryContextMenu" role="menu" style={{ left: menu.x, top: menu.y }}><div className="context-menu-title">{menu.title}</div>{isDocument && isDeleted && <><AntButton type="text" data-context-action="restore-document" onClick={() => act("restore-document")} icon={<Icon name="RotateCcw" />}>恢复文件</AntButton><AntButton type="text" danger data-context-action="permanent-delete" onClick={() => act("permanent-delete")} icon={<Icon name="Trash2" />}>永久删除</AntButton></>}{isDocument && !isDeleted && <><AntButton type="text" data-context-action="move" onClick={() => act("move")} icon={<Icon name="FolderInput" />}>移动到...<Icon name="ChevronRight" /></AntButton><AntButton type="text" data-context-action="toggle-favorite" onClick={() => act("toggle-favorite")} icon={<Icon name="Star" />}>{menu.favorite ? "取消收藏" : "加入收藏"}</AntButton><AntButton type="text" danger data-context-action="delete-document" onClick={() => act("delete-document")} icon={<Icon name="Trash2" />}>删除文件</AntButton></>}{menu.target.kind === "collection" && menu.target.collectionId !== "unfiled" && <AntButton type="text" danger data-context-action="delete-collection" onClick={() => act("delete-collection")} icon={<Icon name="FolderX" />}>删除收藏夹</AntButton>}</div>;
}

function Modal({ id, title, icon, children, onClose, compact = false }) {
  return <AntModal open centered maskClosable title={<Space><span className="modal-icon"><Icon name={icon} /></span><Typography.Text strong>{title}</Typography.Text></Space>} footer={null} onCancel={onClose} width={compact ? 420 : 480} className={`noteflow-modal ${compact ? "compact-modal" : ""}`} destroyOnClose><div id={id} className="noteflow-modal-body">{children}</div></AntModal>;
}

function App() {
  const library = useLibraryState();
  const currentDocument = library.currentEntry?.document || normalizeDocument({ name: "Academic Vocabulary · Unit 04", type: "pdf" }, "english", 0);
  const [colors, setColors] = useState(() => documentStateGroups(currentDocument));
  const [marks, setMarks] = useState(() => readLocalDocumentState(currentDocument)?.annotations || defaultDocumentAnnotations(currentDocument));
  const [history, setHistory] = useState([]);
  const [activeTool, setActiveTool] = useState("highlight");
  const [activeColor, setActiveColor] = useState("yellow");
  const [activeFilter, setActiveFilter] = useState("all");
  const [activeTab, setActiveTab] = useState("groups");
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState(() => readStored("noteflow-collapsed-groups", {}));
  const [collapsedResults, setCollapsedResults] = useState(() => readStored("noteflow-collapsed-results", {}));
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => readStored("noteflow-library-collapsed", false));
  const [insightsCollapsed, setInsightsCollapsed] = useState(() => readStored("noteflow-insights-collapsed", false));
  const [zoom, setZoom] = useState(() => Number(readStored("noteflow-zoom", 100)) || 100);
  const [currentPage, setCurrentPage] = useState(currentDocument.currentPage || 1);
  const [totalPages, setTotalPages] = useState(inferPageCount(currentDocument));
  const [saveState, setSaveState] = useState("刚刚自动保存");
  const [toast, showToast] = useToast();
  const speak = useSpeech();
  const [modal, setModal] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [destination, setDestination] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null);
  const [processor, setProcessor] = useState(() => readStored("noteflow-processor", "translate"));
  const [customProcessor, setCustomProcessor] = useState(() => item => `${item.toUpperCase()} · 待复习`);
  const [autoProcess, setAutoProcess] = useState(() => readStored("noteflow-auto-process", false));
  const fileInput = useRef(null);
  const previousMarkIds = useRef(new Set(marks.map(mark => mark.id)));
  const annotationLoadToken = useRef(0);
  const annotationReadyKey = useRef(null);
  const annotationSaveTimer = useRef(null);
  const pendingAnnotationSave = useRef(null);
  const lastPersistedAnnotationSignature = useRef(null);

  const flushAnnotationSave = useCallback(async () => {
    globalThis.clearTimeout(annotationSaveTimer.current);
    annotationSaveTimer.current = null;
    const pending = pendingAnnotationSave.current;
    if (!pending) return;
    pendingAnnotationSave.current = null;
    try {
      await persistDocumentState(pending.record, pending.annotations, pending.groups);
      if (annotationReadyKey.current === pending.key) {
        lastPersistedAnnotationSignature.current = pending.signature;
        setSaveState("批注已保存");
      }
    } catch {
      if (annotationReadyKey.current === pending.key) setSaveState("已保存到本机，服务器同步失败");
    }
  }, []);

  useEffect(() => { writeStored("noteflow-color-meta", colors); }, [colors]);
  useEffect(() => { writeStored("noteflow-collapsed-groups", collapsedGroups); }, [collapsedGroups]);
  useEffect(() => { writeStored("noteflow-collapsed-results", collapsedResults); }, [collapsedResults]);
  useEffect(() => { writeStored("noteflow-library-collapsed", libraryCollapsed); }, [libraryCollapsed]);
  useEffect(() => { writeStored("noteflow-insights-collapsed", insightsCollapsed); }, [insightsCollapsed]);
  useEffect(() => { writeStored("noteflow-zoom", zoom); }, [zoom]);
  useEffect(() => { writeStored("noteflow-processor", processor); }, [processor]);
  useEffect(() => {
    void flushAnnotationSave();
    const token = annotationLoadToken.current + 1;
    annotationLoadToken.current = token;
    const key = documentStateKey(currentDocument);
    annotationReadyKey.current = null;
    lastPersistedAnnotationSignature.current = null;
    setSaveState("正在加载批注...");
    setCurrentPage(currentDocument.currentPage || (currentDocument.name === "Academic Vocabulary · Unit 04" ? 4 : 1));
    setTotalPages(inferPageCount(currentDocument));
    setHistory([]);
    const localState = readLocalDocumentState(currentDocument);
    const fallbackAnnotations = localState?.annotations || defaultDocumentAnnotations(currentDocument);
    const fallbackGroups = localState?.groups && Object.keys(localState.groups).length
      ? localState.groups
      : readStored("noteflow-color-meta", DEFAULT_COLORS);
    previousMarkIds.current = new Set(fallbackAnnotations.map(mark => mark.id));
    setMarks(fallbackAnnotations);
    setColors(fallbackGroups);

    const finishLoad = async () => {
      let loadedAnnotations = fallbackAnnotations;
      let loadedGroups = fallbackGroups;
      if (currentDocument.documentId) {
        try {
          const remoteState = await fetchDocumentState(currentDocument);
          if (annotationLoadToken.current !== token) return;
          if (remoteState?.exists) {
            const localTime = Date.parse(localState?.updatedAt || "") || 0;
            const remoteTime = Date.parse(remoteState.updated_at || "") || 0;
            if (localState && localTime > remoteTime) {
              loadedAnnotations = fallbackAnnotations;
              loadedGroups = fallbackGroups;
              await persistDocumentState(currentDocument, loadedAnnotations, loadedGroups);
            } else {
              loadedAnnotations = Array.isArray(remoteState.annotations) ? remoteState.annotations : [];
              loadedGroups = remoteState.groups && Object.keys(remoteState.groups).length ? remoteState.groups : loadedGroups;
              previousMarkIds.current = new Set(loadedAnnotations.map(mark => mark.id));
              setMarks(loadedAnnotations);
              if (remoteState.groups && Object.keys(remoteState.groups).length) setColors(remoteState.groups);
              saveLocalDocumentState(currentDocument, loadedAnnotations, loadedGroups, remoteState.updated_at || undefined);
            }
            lastPersistedAnnotationSignature.current = `${key}:${JSON.stringify([loadedAnnotations, loadedGroups])}`;
          } else if (localState) {
            await persistDocumentState(currentDocument, fallbackAnnotations, loadedGroups);
            lastPersistedAnnotationSignature.current = `${key}:${JSON.stringify([fallbackAnnotations, loadedGroups])}`;
          }
        } catch {
          if (annotationLoadToken.current !== token) return;
          setSaveState("已加载本机批注，服务器暂不可用");
        }
      }
      if (annotationLoadToken.current !== token) return;
      if (!currentDocument.documentId) lastPersistedAnnotationSignature.current = `${key}:${JSON.stringify([loadedAnnotations, loadedGroups])}`;
      annotationReadyKey.current = key;
      setSaveState(`已加载 ${loadedAnnotations.length} 条批注`);
    };
    void finishLoad();
    return () => { void flushAnnotationSave(); };
  }, [currentDocument.id, currentDocument.documentId, flushAnnotationSave]);
  useEffect(() => { library.updateDocument(library.currentEntry?.ownerId, library.currentEntry?.index, documentRecord => ({ ...documentRecord, currentPage })); }, [currentPage]);
  useEffect(() => { if (!autoProcess) return; const added = marks.filter(mark => !previousMarkIds.current.has(mark.id) && !mark.translation); previousMarkIds.current = new Set(marks.map(mark => mark.id)); if (added.length) setTimeout(() => runBatch(added.map(mark => mark.id), true), 180); }, [marks, autoProcess]);

  useEffect(() => {
    const key = documentStateKey(currentDocument);
    if (!key || annotationReadyKey.current !== key) return;
    const signature = `${key}:${JSON.stringify([marks, colors])}`;
    if (lastPersistedAnnotationSignature.current === signature) return;
    saveLocalDocumentState(currentDocument, marks, colors);
    pendingAnnotationSave.current = { key, record: currentDocument, annotations: marks, groups: colors, signature };
    globalThis.clearTimeout(annotationSaveTimer.current);
    setSaveState("正在保存批注...");
    annotationSaveTimer.current = globalThis.setTimeout(() => { void flushAnnotationSave(); }, 500);
  }, [colors, currentDocument.id, currentDocument.documentId, flushAnnotationSave, marks]);

  const updateMarks = useCallback(next => { setMarks(previous => typeof next === "function" ? next(previous) : next); }, []);
  const currentName = currentDocument.name;

  const runBatch = useCallback(async (ids = null, isAuto = false) => {
    const targetIds = [...new Set(ids || marks.map(mark => mark.id))];
    if (!targetIds.length) return showToast("还没有可处理的勾画");
    const processOne = async text => {
      if (processor === "explain") return EXPLANATIONS[text.toLowerCase()] || `n./v. ${text} 的简明语境释义`;
      if (processor === "custom") return customProcessor(text);
      if (processor === "offline-translate") { const dictionary = localStorage.getItem("noteflow-custom-dictionary") || ""; const line = dictionary.split("\n").find(item => item.split(/\s*(?:=>|=|:)\s*/)[0]?.toLowerCase() === text.toLowerCase()); return line?.split(/\s*(?:=>|=|:)\s*/).slice(1).join(" = ") || TRANSLATIONS[text.toLowerCase()] || `「${text}」的中文释义`; }
      if (processor === "edge-translate" || processor === "translate") {
        try { if (window.Translator?.create) { const translator = await Promise.race([window.Translator.create({ sourceLanguage: "en", targetLanguage: "zh" }), new Promise(resolve => setTimeout(() => resolve(null), 450))]); const translated = translator && await Promise.race([translator.translate(text), new Promise(resolve => setTimeout(() => resolve(""), 650))]); if (translated) return translated; } } catch { /* fallback below */ }
        return TRANSLATIONS[text.toLowerCase()] || `「${text}」的中文释义`;
      }
      return `「${text}」的中文释义`;
    };
    const inlineTranslation = globalThis.document.getElementById("inlineTranslation")?.checked !== false;
    const updates = await Promise.all(targetIds.map(async id => { const mark = marks.find(item => item.id === id); return mark ? { id, translation: await processOne(mark.text) } : null; }));
    updateMarks(previous => previous.map(mark => { const update = updates.find(item => item?.id === mark.id); return update ? { ...mark, translation: update.translation, inlineTranslation } : mark; }));
    if (!isAuto) setActiveTab("results");
    showToast(isAuto ? `已自动处理 ${targetIds.length} 项新勾画` : `已完成 ${targetIds.length} 项批处理`);
  }, [customProcessor, marks, processor, showToast, updateMarks]);

  const openImport = file => { if (file) { setPendingFile(file); setDestination(null); setModal("import"); } else fileInput.current?.click(); };
  const confirmImport = async () => {
    if (!pendingFile) return;
    const file = pendingFile;
    const extension = file.name.split(".").pop().toLowerCase(); const id = `doc-import-${Date.now()}`;
    let record = normalizeDocument({ id, name: file.name.replace(/\.[^.]+$/, ""), type: extension, content: extension === "pdf" ? undefined : undefined }, destination || "unfiled", 0);
    if (extension === "pdf") {
      showToast("正在保存 PDF 并加入处理队列...");
      try {
        const queued = await uploadPdfDocument(file);
        if (!queued?.document_id || !queued?.job_id) throw new Error(queued?.message || "后端没有返回文档任务 ID");
        record = normalizeDocument({ ...record, documentId: queued.document_id, jobId: queued.job_id, processingStatus: queued.status }, destination || "unfiled", 0);
      } catch (error) {
        showToast(error.message || "PDF 保存失败");
        return;
      }
    } else { const reader = new FileReader(); reader.onload = () => { const withContent = { ...record, content: String(reader.result), pageCount: inferPageCount({ content: String(reader.result) }) }; addRecord(withContent); }; reader.readAsText(file); setModal(null); setPendingFile(null); return; }
    addRecord(record); setModal(null); setPendingFile(null);
    showToast(destination ? `已导入到「${library.collections.find(item => item.id === destination)?.name}」` : `${file.name} 已导入`);
  };
  const addRecord = record => { if (destination) { library.setCollections(previous => previous.map(collection => collection.id === destination ? { ...collection, documents: [record, ...collection.documents] } : collection)); library.setExpandedCollectionId(destination); } else { library.setUnfiled(previous => [record, ...previous]); library.setExpandedCollectionId("unfiled"); } library.setSelectedDocumentId(record.id); setCurrentPage(1); setMarks([]); };

  const handleContextMenu = (event, target) => { event.preventDefault(); flushSync(() => setContextMenu({ x: Math.min(event.clientX, window.innerWidth - 214), y: Math.min(event.clientY, window.innerHeight - 130), title: target.kind === "collection" ? (library.collections.find(item => item.id === target.collectionId)?.name || "收藏夹") : (library.allEntries.find(entry => entry.ownerId === target.ownerId && entry.index === target.index)?.document.name || "文档"), target, favorite: target.kind === "document" && library.allEntries.find(entry => entry.ownerId === target.ownerId && entry.index === target.index)?.document.favorite })); };
  const getTargetDoc = target => library.allEntries.find(entry => target?.kind === "document" && entry.ownerId === target.ownerId && entry.index === target.index)?.document;
  const contextAction = action => { const target = contextMenu?.target; setContextMenu(null); if (!target) return; if (action === "toggle-favorite") { library.updateDocument(target.ownerId, target.index, doc => ({ ...doc, favorite: !doc.favorite })); return; } if (action === "move") { setMoveTarget(target); setDestination(target.ownerId === "unfiled" ? library.collections[0]?.id : "unfiled"); setModal("move"); return; } if (action === "delete-document") { const doc = getTargetDoc(target); if (!doc || !window.confirm(`确定删除「${doc.name}」吗？文件会移到“最近删除”。`)) return; removeDocument(target, true); return; } if (action === "restore-document") { const doc = getTargetDoc(target); if (!doc) return; library.setDeleted(previous => previous.filter((_, index) => index !== target.index)); if (doc.deletedFrom && doc.deletedFrom !== "unfiled") library.setCollections(previous => previous.map(collection => collection.id === doc.deletedFrom ? { ...collection, documents: [doc, ...collection.documents] } : collection)); else library.setUnfiled(previous => [doc, ...previous]); return; } if (action === "permanent-delete") { if (window.confirm("永久删除此文件？此操作无法撤销。")) library.setDeleted(previous => previous.filter((_, index) => index !== target.index)); return; } if (action === "delete-collection") { const collection = library.collections.find(item => item.id === target.collectionId); if (!collection || !window.confirm(`删除收藏夹「${collection.name}」？其中的文档会移到“未分类”。`)) return; library.setCollections(previous => previous.filter(item => item.id !== target.collectionId)); library.setUnfiled(previous => [...collection.documents, ...previous]); } };
  const removeDocument = (target, soft) => { const doc = getTargetDoc(target); if (!doc) return; if (target.ownerId === "unfiled") library.setUnfiled(previous => previous.filter((_, index) => index !== target.index)); else library.setCollections(previous => previous.map(collection => collection.id === target.ownerId ? { ...collection, documents: collection.documents.filter((_, index) => index !== target.index) } : collection)); if (soft) library.setDeleted(previous => [{ ...doc, deletedFrom: target.ownerId }, ...previous]); };
  const onFocusNote = id => { const node = document.querySelector(`[data-id="${id}"], [data-note-id="${id}"], [data-result-note-id="${id}"]`); node?.scrollIntoView({ behavior: "smooth", block: "center" }); };
  const onDeleteMark = id => updateMarks(marks.filter(mark => mark.id !== id));
  const mergeGroups = useCallback((source, target) => {
    if (!source || !target || source === target) return;
    if (!marks.some(mark => mark.color === source)) return;
    setHistory(previous => [...previous, marks]);
    updateMarks(previous => previous.map(mark => mark.color === source ? { ...mark, color: target } : mark));
  }, [marks, setHistory, updateMarks]);
  const openMindmap = useCallback((selectedNotes = marks, selectedColors = Object.fromEntries(Object.entries(colors).filter(([key]) => marks.some(note => note.color === key)))) => {
    try {
      localStorage.setItem("noteflow-mindmap-draft-v1", JSON.stringify({
        document: { id: currentDocument.id, documentId: currentDocument.documentId, name: currentDocument.name },
        notes: selectedNotes,
        colors: selectedColors,
        createdAt: new Date().toISOString(),
      }));
    } catch { /* graph workspace still opens with its empty state */ }
    const opened = globalThis.open?.(`${globalThis.location?.origin || ""}/mindmap.html?draft=${Date.now()}`, "noteflow-mindmap");
    if (!opened) showToast("浏览器阻止了新页面，请允许打开图谱工作区");
  }, [colors, currentDocument.id, currentDocument.documentId, currentDocument.name, marks, showToast]);
  useEffect(() => {
    globalThis.__noteflowOpenMindmap = openMindmap;
    globalThis.__noteflowMergeGroups = mergeGroups;
    return () => {
      if (globalThis.__noteflowOpenMindmap === openMindmap) delete globalThis.__noteflowOpenMindmap;
      if (globalThis.__noteflowMergeGroups === mergeGroups) delete globalThis.__noteflowMergeGroups;
    };
  }, [mergeGroups, openMindmap]);

  useEffect(() => { window.__noteflowSpeak = speak; window.getNotes = () => marks.map((mark, index) => ({ ...mark, order: index + 1 })); window.setActiveTool = tool => flushSync(() => setActiveTool(tool)); window.stageImport = file => flushSync(() => openImport(file)); window.runBatch = runBatch; window.getNotes = () => marks.map((mark, index) => ({ ...mark, order: index + 1 })); window.openGroupNameModal = color => setModal({ type: "color", color }); window.addCustomColor = hex => { const id = `custom-${Date.now()}`; setColors(previous => ({ ...previous, [id]: { label: `自定义颜色 ${Object.keys(previous).length - 3}`, hex } })); setActiveColor(id); setModal({ type: "color", color: id }); }; for (const [key, getter] of Object.entries({ collections: () => library.collections, unfiledDocuments: () => library.unfiled, deletedDocuments: () => library.deleted, COLOR_META: () => colors })) { Object.defineProperty(window, key, { configurable: true, get: getter }); } }, [colors, library.collections, library.deleted, library.unfiled, marks, openImport, runBatch, speak]);
  useEffect(() => { window.openGroupNameModal = color => flushSync(() => setModal({ type: "color", color })); window.addCustomColor = hex => flushSync(() => { const id = `custom-${Date.now()}`; setColors(previous => ({ ...previous, [id]: { label: `自定义颜色 ${Object.keys(previous).length - 3}`, hex } })); setActiveColor(id); setModal({ type: "color", color: id }); }); }, [colors, library.collections, library.deleted, library.unfiled, marks, openImport, runBatch, speak]);
  useEffect(() => { const editColor = event => setModal({ type: "color", color: event.detail }); document.addEventListener("noteflow-edit-color", editColor); return () => document.removeEventListener("noteflow-edit-color", editColor); }, []);
  useEffect(() => { const keyHandler = event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runBatch(); if (event.key === "Escape") setModal(null); }; const outside = () => setContextMenu(null); document.addEventListener("keydown", keyHandler); document.addEventListener("click", outside); const exportHandler = () => exportExcel(); const openInsights = () => setInsightsCollapsed(false); document.addEventListener("noteflow-export", exportHandler); document.addEventListener("noteflow-open-insights", openInsights); return () => { document.removeEventListener("keydown", keyHandler); document.removeEventListener("click", outside); document.removeEventListener("noteflow-export", exportHandler); document.removeEventListener("noteflow-open-insights", openInsights); }; }, [runBatch]);
  const exportExcel = () => { if (!marks.length) return showToast("还没有可导出的勾画内容"); const rows = marks.map(mark => `<Row><Cell><Data ss:Type="String">${escapeHtml(mark.text)}</Data></Cell><Cell><Data ss:Type="String">${escapeHtml(colors[mark.color]?.label || "")}</Data></Cell><Cell><Data ss:Type="String">${escapeHtml(mark.translation || "")}</Data></Cell><Cell><Data ss:Type="Number">${mark.page || 1}</Data></Cell></Row>`).join(""); const xml = `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="NoteFlow批注"><Table><Row><Cell><Data ss:Type="String">原文</Data></Cell><Cell><Data ss:Type="String">颜色分组</Data></Cell><Cell><Data ss:Type="String">处理结果</Data></Cell><Cell><Data ss:Type="Number">页码</Data></Cell></Row>${rows}</Table></Worksheet></Workbook>`; const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["\ufeff", xml], { type: "application/vnd.ms-excel" })); link.download = "NoteFlow_批注结果.xls"; link.click(); URL.revokeObjectURL(link.href); showToast(`已导出 ${marks.length} 条批注`); };

  return <Layout className="nf-app-shell"><Topbar currentFileName={currentName} saveState={saveState} onExport={exportExcel} onToggleLibrary={() => setLibraryCollapsed(false)} /><Layout className="nf-main-layout"><LibraryPanel state={library} collapsed={libraryCollapsed} onCollapse={() => setLibraryCollapsed(value => !value)} onImport={() => openImport()} onNewCollection={() => setModal("collection")} onContextMenu={handleContextMenu} /><Layout.Content className="nf-reader-content"><Reader document={currentDocument} marks={marks} setMarks={updateMarks} activeTool={activeTool} setActiveTool={setActiveTool} activeColor={activeColor} setActiveColor={setActiveColor} colors={colors} setColors={setColors} zoom={zoom} setZoom={value => setZoom(Math.round(Math.min(500, Math.max(25, Number(value) || 100)) / 5) * 5)} currentPage={currentPage} setCurrentPage={setCurrentPage} totalPages={totalPages} setTotalPages={setTotalPages} history={history} setHistory={setHistory} showToast={showToast} /></Layout.Content><InsightsPanel collapsed={insightsCollapsed} onCollapse={() => setInsightsCollapsed(value => !value)} notes={marks} colors={colors} activeFilter={activeFilter} setActiveFilter={setActiveFilter} search={search} setSearch={setSearch} collapsedGroups={collapsedGroups} setCollapsedGroups={setCollapsedGroups} collapsedResults={collapsedResults} setCollapsedResults={setCollapsedResults} tab={activeTab} setTab={setActiveTab} onDeleteMark={onDeleteMark} onFocusNote={onFocusNote} processor={processor} setProcessor={setProcessor} autoProcess={autoProcess} setAutoProcess={value => { setAutoProcess(value); writeStored("noteflow-auto-process", value); }} onRunBatch={runBatch} onOpenPlugin={() => setModal("plugin")} onRenameColor={color => setModal({ type: "color", color })} showToast={showToast} speak={speak} /></Layout><input ref={fileInput} type="file" accept=".pdf,.txt,.md,text/plain,text/markdown,application/pdf" hidden onChange={event => { openImport(event.target.files[0]); event.target.value = ""; }} />{contextMenu && <ContextMenu menu={contextMenu} onAction={contextAction} />}<AppModals modal={modal} setModal={setModal} pendingFile={pendingFile} destination={destination} setDestination={setDestination} library={library} onConfirmImport={confirmImport} moveTarget={moveTarget} onConfirmMove={() => { const doc = getTargetDoc(moveTarget); if (!doc) return; removeDocument(moveTarget, false); if (destination === "unfiled") library.setUnfiled(previous => [doc, ...previous]); else library.setCollections(previous => previous.map(collection => collection.id === destination ? { ...collection, documents: [doc, ...collection.documents] } : collection)); library.setSelectedDocumentId(doc.id); setModal(null); }} colors={colors} customProcessor={customProcessor} setCustomProcessor={setCustomProcessor} editingColor={modal?.color} onSaveColor={(color, name) => { setColors(previous => ({ ...previous, [color]: { ...previous[color], label: name } })); setModal(null); }} onCreateCollection={name => { const id = `collection-${Date.now()}`; library.setCollections(previous => [...previous, { id, name, tone: ["mint", "lavender", "coral"][previous.length % 3], documents: [] }]); library.setExpandedCollectionId(id); setModal(null); }} onClose={() => setModal(null)} />{toast && <div className="nf-toast" role="status"><Icon name="CheckCircle2" /><span>{toast}</span></div>}</Layout>;
}

function AppModals({ modal, setModal, pendingFile, destination, setDestination: setDestinationProp, library, onConfirmImport, moveTarget, onConfirmMove, colors, customProcessor, setCustomProcessor, editingColor, onSaveColor, onCreateCollection, onClose }) {
  const setDestination = value => flushSync(() => setDestinationProp(value));
  if (!modal) return null;
  if (modal === "import") return <Modal id="importModal" title="导入文档" icon="FileUp" compact onClose={onClose}><Typography.Paragraph type="secondary">选择文档的保存位置</Typography.Paragraph><div className="destination-list" id="destinationList"><AntButton type="text" className={`destination-option ${destination === null ? "active" : ""}`} data-destination="none" onClick={() => setDestination(null)}><span className="destination-icon"><InboxOutlined /></span><span><strong>不放入收藏夹</strong><small>仅显示在全部文档</small></span><Icon name="Check" /></AntButton>{library.collections.map(collection => <AntButton key={collection.id} type="text" className={`destination-option ${destination === collection.id ? "active" : ""}`} data-destination={collection.id} onClick={() => setDestination(collection.id)}><span className="destination-icon"><FolderOpenOutlined /></span><span><strong>{collection.name}</strong><small>{collection.documents.length} 个文档</small></span><Icon name="Check" /></AntButton>)}</div><div className="modal-actions"><AntButton className="button secondary" onClick={onClose}>取消</AntButton><AntButton className="button primary" id="confirmImportBtn" type="primary" icon={<Icon name="Check" />} onClick={onConfirmImport}>确认导入</AntButton></div></Modal>;
  if (modal === "collection") return <CollectionModal onClose={onClose} onCreate={onCreateCollection} />;
  if (modal === "move") return <Modal id="moveModal" title="移动文档" icon="FolderInput" compact onClose={onClose}><Typography.Paragraph type="secondary">选择新的保存位置</Typography.Paragraph><div className="destination-list" id="moveDestinationList">{[{ id: "unfiled", name: "未分类", count: library.unfiled.length }, ...library.collections.map(collection => ({ id: collection.id, name: collection.name, count: collection.documents.length }))].filter(item => item.id !== moveTarget?.ownerId).map(item => <AntButton key={item.id} type="text" className={`destination-option ${destination === item.id ? "active" : ""}`} data-move-destination={item.id} onClick={() => setDestination(item.id)}><span className="destination-icon"><FolderOpenOutlined /></span><span><strong>{item.name}</strong><small>{item.count} 个文档</small></span><Icon name="Check" /></AntButton>)}</div><div className="modal-actions"><AntButton className="button secondary" onClick={onClose}>取消</AntButton><AntButton className="button primary" id="confirmMoveBtn" type="primary" icon={<Icon name="FolderInput" />} onClick={onConfirmMove}>确认移动</AntButton></div></Modal>;
  if (modal === "plugin") return <Modal id="pluginModal" title="自定义处理插件" icon="Braces" onClose={onClose}><Typography.Paragraph type="secondary">输入一个 JavaScript 表达式来处理每条勾画内容</Typography.Paragraph><label htmlFor="functionInput">处理函数</label><Input.TextArea id="functionInput" spellCheck={false} autoSize={{ minRows: 4, maxRows: 10 }} value={customProcessor.toString().replace(/^function \(.*?\) \{ return |; \}$/g, "")} onChange={event => setCustomProcessor(event.target.value)} /><div className="code-hint"><code>item</code> 为当前文本；函数需要返回字符串。</div><div className="modal-actions"><AntButton className="button secondary" onClick={onClose}>取消</AntButton><AntButton className="button primary" id="savePlugin" type="primary" icon={<Icon name="Check" />} onClick={() => { try { const candidate = Function(`"use strict"; return (${typeof customProcessor === "function" ? customProcessor.toString() : customProcessor})`)(); if (typeof candidate !== "function") throw new Error("需要输入函数"); setCustomProcessor(candidate); onClose(); } catch (error) { alert(`函数格式错误：${error.message}`); } }}>保存插件</AntButton></div></Modal>;
  if (modal?.type === "color") return <ColorModal color={editingColor} colors={colors} onClose={onClose} onSave={onSaveColor} />;
  return null;
}

function CollectionModal({ onClose, onCreate }) { const [name, setName] = useState(""); const submit = () => { const value = globalThis.document.getElementById("collectionNameInput")?.value?.trim() || name.trim(); if (value) onCreate(value); }; return <Modal id="collectionModal" title="新建收藏夹" icon="FolderPlus" compact onClose={onClose}><Typography.Paragraph type="secondary">为资料创建一个清晰的分类</Typography.Paragraph><label htmlFor="collectionNameInput">收藏夹名称</label><Input className="text-input" id="collectionNameInput" value={name} maxLength={24} placeholder="例如：雅思词汇" onChange={event => setName(event.target.value)} onPressEnter={submit} /><div className="modal-actions"><AntButton className="button secondary" onClick={onClose}>取消</AntButton><AntButton className="button primary" id="createCollectionBtn" type="primary" icon={<FolderAddOutlined />} onClick={submit}>创建收藏夹</AntButton></div></Modal>; }

function ColorModal({ color, colors, onClose, onSave }) { const [name, setName] = useState(colors[color]?.label || ""); const submit = () => { const value = globalThis.document.getElementById("groupNameInput")?.value?.trim() || name.trim(); onSave(color, value); }; return <Modal id="groupNameModal" title="设置颜色分组" icon="Palette" compact onClose={onClose}><Typography.Paragraph type="secondary">修改名称后，已有批注会自动同步</Typography.Paragraph><label htmlFor="groupNameInput">分组名称</label><Input className="text-input" id="groupNameInput" value={name} maxLength={20} onChange={event => setName(event.target.value)} onPressEnter={submit} /><div className="modal-actions"><AntButton className="button secondary" onClick={onClose}>取消</AntButton><AntButton className="button primary" id="saveGroupNameBtn" type="primary" icon={<Icon name="Check" />} onClick={submit}>保存名称</AntButton></div></Modal>; }

createRoot(document.getElementById("root")).render(<ConfigProvider theme={{ token: { colorPrimary: "#246b57", borderRadius: 6, fontFamily: '"Noto Sans SC", "Manrope", sans-serif', colorBgLayout: "#f3f5f4" } }}><App /></ConfigProvider>);
