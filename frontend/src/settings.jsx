import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button as AntButton,
  Card,
  ConfigProvider,
  Divider,
  Form,
  Input,
  Layout,
  Menu,
  Radio,
  Select,
  Slider,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  ArrowLeftOutlined,
  BookOutlined,
  CheckOutlined,
  ExperimentOutlined,
  KeyOutlined,
  SaveOutlined,
  SettingOutlined,
  SlidersOutlined,
} from "@ant-design/icons";
import "antd/dist/reset.css";
import * as Icons from "lucide-react";
import "./settings.css";

const Icon = ({ name, ...props }) => {
  const Component = Icons[name] || Icons.Circle;
  return <Component {...props} />;
};

const OCR_API_BASE = globalThis.__NOTEFLOW_API_BASE || (globalThis.location?.port === "5173" ? "http://127.0.0.1:8000" : "");

function readBoolean(key, fallback = false) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readSettings() {
  const storedRate = Number(localStorage.getItem("noteflow-speech-rate"));
  return {
    speechRate: Number.isFinite(storedRate) && storedRate > 0 ? Math.min(1.4, Math.max(.6, storedRate)) : .95,
    maxHighlightChars: (() => { const value = Number(localStorage.getItem("noteflow-max-highlight-chars")); return Number.isFinite(value) ? Math.min(1000, Math.max(10, Math.floor(value))) : 120; })(),
    autoProcess: readBoolean("noteflow-auto-process"),
    endpoint: localStorage.getItem("noteflow-api-endpoint") || "",
    apiKey: localStorage.getItem("noteflow-api-key") || "",
    model: localStorage.getItem("noteflow-api-model") || "",
    dictionary: localStorage.getItem("noteflow-custom-dictionary") || "",
    processor: localStorage.getItem("noteflow-processor") || "translate",
    ocrEngine: localStorage.getItem("noteflow-ocr-engine") || "auto",
    highlightSegmentation: localStorage.getItem("noteflow-highlight-segmentation") || "nearest",
    showOcrBoxes: readBoolean("noteflow-show-ocr-boxes", true),
  };
}

const PLUGINS = [
  { id: "translate", icon: "Languages", tone: "mint", title: "Edge 翻译", description: "优先调用浏览器 Translator API，无可用接口时使用离线词表。", status: "推荐" },
  { id: "explain", icon: "BookMarked", tone: "lavender", title: "词性 + 简明释义", description: "为英文词汇补充词性和简短语境解释。", status: "内置" },
  { id: "custom", icon: "Braces", tone: "coral", title: "自定义函数", description: "使用 JavaScript 函数构建自己的处理格式。", status: "可编辑" },
];

function SettingsApp() {
  const initial = useMemo(readSettings, []);
  const [speechRate, setSpeechRate] = useState(initial.speechRate);
  const [maxHighlightChars, setMaxHighlightChars] = useState(initial.maxHighlightChars);
  const [autoProcess, setAutoProcess] = useState(initial.autoProcess);
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [model, setModel] = useState(initial.model);
  const [dictionary, setDictionary] = useState(initial.dictionary);
  const [processor, setProcessor] = useState(initial.processor);
  const [ocrEngine, setOcrEngine] = useState(initial.ocrEngine);
  const [highlightSegmentation, setHighlightSegmentation] = useState(initial.highlightSegmentation);
  const [showOcrBoxes, setShowOcrBoxes] = useState(initial.showOcrBoxes);
  const [ocrStatus, setOcrStatus] = useState({ loading: true, engines: { pdfjs: true }, message: "正在检测本地 OCR 引擎..." });
  const [apiStatus, setApiStatus] = useState({ text: "未配置", tone: "" });
  const [toast, setToast] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${OCR_API_BASE}/api/ocr/status`, { signal: controller.signal })
      .then(response => response.json())
      .then(payload => setOcrStatus({ loading: false, engines: payload.engines || { pdfjs: true }, message: payload.message || "OCR 状态已更新" }))
      .catch(() => setOcrStatus({ loading: false, engines: { pdfjs: true }, message: "无法连接 OCR 服务，可先保存引擎偏好" }));
    return () => controller.abort();
  }, []);
  const dictionaryCount = dictionary.split("\n").map(line => line.trim()).filter(Boolean).length;
  const fieldValue = id => globalThis.document.getElementById(id)?.value;

  const showToast = message => {
    setToast(message);
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => setToast(""), 2200);
  };

  const saveSettings = () => {
    const rate = Number(fieldValue("speechRate") ?? speechRate);
    const processAutomatically = Boolean(globalThis.document.getElementById("autoProcessSetting")?.checked ?? autoProcess);
    localStorage.setItem("noteflow-speech-rate", String(Number.isFinite(rate) ? rate : speechRate));
    localStorage.setItem("noteflow-max-highlight-chars", String(Math.min(1000, Math.max(10, Math.floor(Number(maxHighlightChars) || 120)))));
    localStorage.setItem("noteflow-auto-process", JSON.stringify(processAutomatically));
    localStorage.setItem("noteflow-api-endpoint", String(fieldValue("apiEndpoint") ?? endpoint).trim());
    localStorage.setItem("noteflow-api-key", String(fieldValue("apiKey") ?? apiKey).trim());
    localStorage.setItem("noteflow-api-model", String(fieldValue("apiModel") ?? model).trim());
    localStorage.setItem("noteflow-custom-dictionary", String(fieldValue("customDictionary") ?? dictionary).trim());
    localStorage.setItem("noteflow-ocr-engine", String(ocrEngine || "auto"));
    localStorage.setItem("noteflow-highlight-segmentation", String(highlightSegmentation || "nearest"));
    localStorage.setItem("noteflow-show-ocr-boxes", JSON.stringify(Boolean(showOcrBoxes)));
    const selectedProcessor = globalThis.document.activeElement?.dataset.processor || globalThis.document.querySelector(".plugin-card.selected")?.dataset.processor || processor;
    localStorage.setItem("noteflow-processor", selectedProcessor);
    showToast("设置已保存");
  };

  const testApi = () => {
    const configuredEndpoint = String(fieldValue("apiEndpoint") ?? endpoint).trim();
    if (!configuredEndpoint) {
      setApiStatus({ text: "请先填写接口地址", tone: "error" });
      return;
    }
    setApiStatus({ text: "已记录配置，连接将在插件运行时验证", tone: "success" });
  };

  const navigation = [
    { key: "reading", icon: <BookOutlined />, label: "阅读与批注" },
    { key: "ocr", icon: <Icon name="ScanText" />, label: "OCR 识别" },
    { key: "processing", icon: <ExperimentOutlined />, label: "处理插件" },
    { key: "api", icon: <KeyOutlined />, label: "模型接口" },
    { key: "dictionary", icon: <SlidersOutlined />, label: "自定义词表" },
  ];
  return <Layout className="nf-settings-shell">
    <Layout.Header className="nf-settings-header"><Space size={12}><a className="nf-settings-brand" href="/"><span className="brand-mark">N</span><Typography.Text strong>NoteFlow</Typography.Text></a><Divider type="vertical" /><Typography.Title level={4}>工作区设置</Typography.Title></Space><Space><AntButton href="/" icon={<ArrowLeftOutlined />}>返回阅读器</AntButton><AntButton id="saveSettings" type="primary" icon={<SaveOutlined />} onClick={saveSettings}>保存设置</AntButton></Space></Layout.Header>
    <Layout className="nf-settings-layout">
      <Layout.Sider className="nf-settings-sider" width={224} theme="light"><Menu mode="inline" defaultSelectedKeys={["reading"]} items={navigation} onClick={({ key }) => globalThis.document.getElementById(key)?.scrollIntoView({ behavior: "smooth", block: "start" })} /></Layout.Sider>
      <Layout.Content className="settings-content nf-settings-content"><Form layout="vertical">
        <section className="settings-section" id="reading">
          <div className="section-intro"><span className="eyebrow">READER</span><h2>阅读与批注</h2><p>调整朗读、勾画和分组的默认行为。</p></div>
          <Card className="settings-card" bordered>
            <div className="setting-row"><span><strong>朗读速度</strong><small>应用于勾画内容和处理结果</small></span><Slider id="speechRate" className="range-input" min={0.6} max={1.4} step={0.05} value={speechRate} onChange={setSpeechRate} /><output id="speechRateValue">{Number(speechRate).toFixed(2)}x</output></div>
            <div className="setting-row"><span><strong>单次最大勾画字数</strong><small>超过限制时不会创建批注，避免误选整页内容</small></span><Slider id="maxHighlightChars" className="range-input" min={10} max={1000} step={10} value={maxHighlightChars} onChange={setMaxHighlightChars} tooltip={{ formatter: value => `${value} 字` }} /><output id="maxHighlightCharsValue">{maxHighlightChars} 字</output></div>
            <div className="setting-row"><span><strong>自动处理新勾画</strong><small>勾画完成后使用当前插件处理</small></span><Switch id="autoProcessSetting" checked={autoProcess} onChange={setAutoProcess} /><span className="toggle" aria-hidden="true" /></div>
            <div className="setting-row"><span><strong>勾画字符串优化</strong><small>按轨迹最近文字行和词边界收敛选区，避免多选 OCR 框内容</small></span><Select className="highlight-segmentation-select" value={highlightSegmentation} onChange={setHighlightSegmentation} options={[{ value: "nearest", label: "最近字符串（推荐）" }, { value: "jieba", label: "Jieba / 词边界优化" }, { value: "ocr-box", label: "严格 OCR 框" }]} /></div>
            <div className="setting-row"><span><strong>显示 OCR 识别框</strong><small>在 PDF 上查看 MinerU 识别出的文字定位范围</small></span><Switch checked={showOcrBoxes} onChange={setShowOcrBoxes} /></div>
            <div className="setting-row"><span><strong>侧栏状态</strong><small>在阅读器中记住资料库和智能批注的收起状态</small></span><Tag color="green" className="setting-note">自动保存</Tag></div>
          </Card>
        </section>

        <section className="settings-section" id="ocr">
          <div className="section-intro"><span className="eyebrow">PDF OCR</span><h2>OCR 识别引擎</h2><p>选择 PDF 文本定位和框选区域识别所使用的引擎。</p></div>
          <Card className="settings-card ocr-card" bordered>
            <div className="setting-row ocr-engine-row"><span><strong>当前引擎</strong><small>自动模式优先使用 MinerU，失败后按可用能力回退</small></span><Select id="ocrEngine" className="ocr-engine-select" value={ocrEngine} onChange={setOcrEngine} options={[{ value: "auto", label: "自动选择（MinerU 优先）" }, { value: "mineru", label: "MinerU OCR" }, { value: "pymupdf", label: "PyMuPDF 文本定位" }, { value: "tesseract", label: "Tesseract 区域 OCR" }, { value: "pdfjs", label: "仅使用 PDF.js" }]} /></div>
            <div className="ocr-engine-status" id="ocrEngineStatus"><Tag color={ocrStatus.loading ? "gold" : ocrStatus.engines.mineru ? "green" : "default"}>{ocrStatus.loading ? "检测中" : ocrStatus.engines.mineru ? "MinerU 可用" : "未检测到 MinerU"}</Tag><span>{ocrStatus.message}</span></div>
          </Card>
        </section>

        <section className="settings-section" id="processing">
          <div className="section-intro"><span className="eyebrow">PRESETS</span><h2>预设处理插件</h2><p>选择一个插件后，可在智能批注面板中批量处理勾画内容。</p></div>
          <div className="plugin-grid">{PLUGINS.map(plugin => <AntButton key={plugin.id} data-processor={plugin.id} type="text" className={`plugin-card ${processor === plugin.id ? "selected" : ""}`} onClick={() => setProcessor(plugin.id)}><span className={`plugin-icon ${plugin.tone}`}><Icon name={plugin.icon} /></span><span><strong>{plugin.title}</strong><p>{plugin.description}</p></span><Tag color={processor === plugin.id ? "green" : "default"} className={`status-pill ${processor === plugin.id ? "" : "muted"}`}>{plugin.status}</Tag></AntButton>)}</div>
        </section>

        <section className="settings-section" id="api">
          <div className="section-intro"><span className="eyebrow">MODEL API</span><h2>模型接口</h2><p>可选配置，用于自定义插件或后续工作流处理。</p></div>
          <Card className="settings-card api-card" bordered>
            <label htmlFor="apiEndpoint">接口地址</label><Input className="text-input" id="apiEndpoint" type="url" placeholder="https://api.openai.com/v1" value={endpoint} onChange={event => setEndpoint(event.target.value)} />
            <div className="field-grid"><label><span>API Key</span><Input.Password className="text-input" id="apiKey" placeholder="sk-..." value={apiKey} onChange={event => setApiKey(event.target.value)} /></label><label><span>模型</span><Input className="text-input" id="apiModel" placeholder="gpt-4o-mini" value={model} onChange={event => setModel(event.target.value)} /></label></div>
            <div className="api-actions"><AntButton className="button secondary" id="testApi" onClick={testApi}>测试连接</AntButton><span id="apiStatus" className={apiStatus.tone} role="status">{apiStatus.text}</span></div>
          </Card>
        </section>

        <section className="settings-section" id="dictionary">
          <div className="section-intro"><span className="eyebrow">VOCABULARY</span><h2>自定义词表</h2><p>每行一个词语，可选填中文释义，用于离线翻译回退。</p></div>
          <Card className="settings-card" bordered><Input.TextArea className="dictionary-input" id="customDictionary" autoSize={{ minRows: 6, maxRows: 12 }} placeholder="serendipity = 意外发现\nnuance = 细微差别" value={dictionary} onChange={event => setDictionary(event.target.value)} /><div className="card-foot"><span id="dictionaryCount">{dictionaryCount} 条词条</span><span>自动保存在当前浏览器</span></div></Card>
        </section>
      </Form></Layout.Content>
    </Layout>
    {toast && <div className="settings-toast show" id="settingsToast" role="status">{toast}</div>}
  </Layout>;
}

createRoot(document.getElementById("root")).render(<ConfigProvider theme={{ token: { colorPrimary: "#246b57", borderRadius: 6, fontFamily: '"Noto Sans SC", "Manrope", sans-serif' } }}><SettingsApp /></ConfigProvider>);
