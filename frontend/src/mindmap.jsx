import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Checkbox, ConfigProvider, Input, Select, Space, Tag, Tooltip, Typography } from "antd";
import { ArrowLeftOutlined, DownloadOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import * as Icons from "lucide-react";
import "antd/dist/reset.css";
import "./mindmap.css";

const Icon = ({ name, ...props }) => { const Component = Icons[name] || Icons.Circle; return <Component {...props} />; };
const DRAFT_KEY = "noteflow-mindmap-draft-v1";
const GRAPH_KEY = "noteflow-mindmap-graph-v1";
const DEFAULT_COLORS = { yellow: { label: "重点词汇", hex: "#f1d85a" }, mint: { label: "熟悉词汇", hex: "#61c9a3" }, lavender: { label: "待复习", hex: "#aa93db" }, coral: { label: "易错词", hex: "#ed856c" } };

function readJson(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key) || ""); return value || fallback; } catch { return fallback; } }
function makeNode(id, label, kind = "concept", x = 120, y = 110, color = "yellow") { return { id, label, kind, x, y, color }; }
function buildInitialGraph(draft) {
  const notes = Array.isArray(draft.notes) ? draft.notes : [];
  const colors = { ...DEFAULT_COLORS, ...(draft.colors || {}) };
  const groups = Object.keys(colors).filter(color => notes.some(note => note.color === color));
  const root = makeNode("root", draft.document?.name || "选中内容", "root", 420, 58, "yellow");
  const groupNodes = groups.map((color, index) => makeNode(`group-${color}`, colors[color]?.label || color, "group", 120 + (index % 3) * 250, 190 + Math.floor(index / 3) * 150, color));
  const noteNodes = notes.map((note, index) => makeNode(`note-${note.id}`, note.text, "note", 100 + (index % 4) * 220, 360 + Math.floor(index / 4) * 110, note.color || "yellow"));
  const edges = groupNodes.map(node => ({ id: `edge-root-${node.id}`, from: "root", to: node.id }));
  noteNodes.forEach(node => { const note = notes.find(item => `note-${item.id}` === node.id); if (note?.color) edges.push({ id: `edge-${node.id}`, from: `group-${note.color}`, to: node.id }); });
  return { document: draft.document || {}, sourceCreatedAt: draft.createdAt || "", nodes: [root, ...groupNodes, ...noteNodes], edges, prompt: "", workflow: [{ id: "source", type: "source", label: "选中批注" }, { id: "cluster", type: "cluster", label: "按概念分组" }, { id: "outline", type: "outline", label: "提炼主干" }] };
}

function MindmapApp() {
  const draft = useMemo(() => readJson(DRAFT_KEY, { document: { name: "未命名文档" }, notes: [], colors: DEFAULT_COLORS }), []);
  const [graph, setGraph] = useState(() => { const savedGraph = readJson(GRAPH_KEY, null); return savedGraph?.document?.id && savedGraph.document.id === draft.document?.id && savedGraph.sourceCreatedAt === (draft.createdAt || "") ? savedGraph : buildInitialGraph(draft); });
  const [selectedNode, setSelectedNode] = useState("root");
  const [mode, setMode] = useState("canvas");
  const [prompt, setPrompt] = useState(graph.prompt || "");
  const [saved, setSaved] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const selected = graph.nodes.find(node => node.id === selectedNode) || graph.nodes[0];
  const updateNode = (id, patch) => setGraph(previous => ({ ...previous, nodes: previous.nodes.map(node => node.id === id ? { ...node, ...patch } : node) }));
  const addNode = () => {
    const id = `concept-${Date.now()}`;
    setGraph(previous => ({ ...previous, nodes: [...previous.nodes, makeNode(id, "新概念", "concept", 420, 300, "mint")], edges: [...previous.edges, { id: `edge-${id}`, from: selectedNode || "root", to: id }] }));
    setSelectedNode(id);
  };
  const buildPrompt = () => {
    const terms = graph.nodes.filter(node => node.kind === "note").map(node => node.label).slice(0, 80);
    return `你是知识图谱整理助手。仅根据以下选中内容构建主干思维导图：${terms.join("、")}。请输出不超过 3 层的主题-概念-要点结构，模糊或省略其他细节，避免超出上下文。`;
  };
  const generatePrompt = () => {
    const next = buildPrompt();
    setPrompt(next); setGraph(previous => ({ ...previous, prompt: next })); setMode("workflow");
  };
  const autoBuild = async () => {
    const next = buildPrompt();
    const endpoint = String(localStorage.getItem("noteflow-api-endpoint") || "").trim();
    const apiKey = String(localStorage.getItem("noteflow-api-key") || "").trim();
    const model = String(localStorage.getItem("noteflow-api-model") || "").trim();
    if (!endpoint) { generatePrompt(); return; }
    setAiBusy(true);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model, messages: [{ role: "system", content: "只返回 JSON，格式为 {nodes:[{id,label,kind,x,y,color}],edges:[{id,from,to}]}，节点最多 30 个，关系最多 50 条。" }, { role: "user", content: next }] }) });
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content || payload?.output || payload;
      const parsed = typeof content === "string" ? JSON.parse(content.replace(/^```json\s*|\s*```$/g, "")) : content;
      if (!Array.isArray(parsed?.nodes) || !Array.isArray(parsed?.edges)) throw new Error("AI 返回格式不完整");
      setGraph(previous => ({ ...previous, nodes: parsed.nodes.slice(0, 30), edges: parsed.edges.slice(0, 50), prompt: next })); setPrompt(next); setMode("canvas");
    } catch (error) {
      setPrompt(`${next}\n\nAI 自动构建失败：${error.message || "接口不可用"}`); setGraph(previous => ({ ...previous, prompt: next })); setMode("workflow");
    } finally { setAiBusy(false); }
  };
  const save = () => { localStorage.setItem(GRAPH_KEY, JSON.stringify({ ...graph, sourceCreatedAt: draft.createdAt || graph.sourceCreatedAt || "", prompt })); setSaved(true); setTimeout(() => setSaved(false), 1800); };
  const exportGraph = () => { const blob = new Blob([JSON.stringify({ ...graph, prompt }, null, 2)], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "noteflow-mindmap.json"; link.click(); URL.revokeObjectURL(link.href); };
  return <ConfigProvider theme={{ token: { colorPrimary: "#246b57", borderRadius: 6, fontFamily: '"Noto Sans SC", "Manrope", sans-serif' } }}><main className="mindmap-app">
    <header className="mindmap-topbar"><Space size={10}><Button type="text" href="/" icon={<ArrowLeftOutlined />} aria-label="返回阅读器" /><span className="mindmap-brand-mark">N</span><Typography.Text strong>NoteFlow</Typography.Text><Tag color="green">图谱工作流</Tag><Typography.Text type="secondary">{draft.document?.name || "选中内容"}</Typography.Text></Space><Space><Button icon={<SaveOutlined />} onClick={save}>{saved ? "已保存" : "保存"}</Button><Button icon={<DownloadOutlined />} onClick={exportGraph}>导出</Button></Space></header>
    <div className="mindmap-layout"><aside className="mindmap-sidebar"><div className="mindmap-sidebar-title"><span>构建流程</span><Tag>{graph.nodes.length} 节点</Tag></div><div className="workflow-list">{graph.workflow.map((step, index) => <div className={`workflow-step ${mode === "workflow" && index === 2 ? "active" : ""}`} key={step.id}><span>{index + 1}</span><div><strong>{step.label}</strong><small>{step.type === "source" ? "来自分组选择" : step.type === "cluster" ? "合并相近概念" : "只保留主干结构"}</small></div><Icon name="GripVertical" /></div>)}</div><Button block type={mode === "workflow" ? "primary" : "default"} icon={<Icon name="Workflow" />} onClick={() => setMode("workflow")}>打开工作流</Button><Button block icon={<Icon name="Network" />} onClick={() => setMode("canvas")}>返回图谱画布</Button><div className="prompt-panel"><div className="panel-label"><span>AI 主干提示词</span><Tooltip title="只生成主题、概念和要点主干，降低上下文长度"><Icon name="Info" /></Tooltip></div><Input.TextArea value={prompt} onChange={event => { setPrompt(event.target.value); setGraph(previous => ({ ...previous, prompt: event.target.value })); }} autoSize={{ minRows: 5, maxRows: 9 }} placeholder="点击生成，或编辑提示词" /><Button block icon={<Icon name="Sparkles" />} onClick={generatePrompt}>生成主干提示词</Button><Button block type="primary" loading={aiBusy} icon={<Icon name="BrainCircuit" />} onClick={autoBuild}>AI 自动构建主干</Button></div></aside>
      <section className="mindmap-workspace">{mode === "workflow" ? <WorkflowView graph={graph} prompt={prompt} /> : <GraphCanvas graph={graph} selectedNode={selectedNode} setSelectedNode={setSelectedNode} updateNode={updateNode} />}<div className="mindmap-inspector"><div className="inspector-head"><strong>节点属性</strong><Button type="text" icon={<PlusOutlined />} aria-label="新增节点" onClick={addNode} /></div>{selected && <><Input value={selected.label} onChange={event => updateNode(selected.id, { label: event.target.value })} /><Select value={selected.kind} onChange={value => updateNode(selected.id, { kind: value })} options={[{ value: "root", label: "主题" }, { value: "group", label: "概念类型" }, { value: "note", label: "选中内容" }, { value: "concept", label: "自定义概念" }]} /><Checkbox checked={selected.id === "root"} disabled>主干节点</Checkbox><Typography.Paragraph type="secondary">拖动节点调整结构；点击节点编辑名称。连接线展示当前层级关系。</Typography.Paragraph></>}</div></section></div>
  </main></ConfigProvider>;
}

function GraphCanvas({ graph, selectedNode, setSelectedNode, updateNode }) {
  const [dragging, setDragging] = useState(null);
  const width = 980; const height = 680;
  const point = node => ({ x: node.x + 84, y: node.y + 24 });
  const nodeColor = color => ({ yellow: "#f1d85a", mint: "#61c9a3", lavender: "#aa93db", coral: "#ed856c" }[color] || "#8ba79a");
  const groups = graph.nodes.filter(node => node.kind === "group");
  const notesForGroup = group => graph.edges
    .filter(edge => edge.from === group.id)
    .map(edge => graph.nodes.find(node => node.id === edge.to))
    .filter(node => node?.kind === "note");
  return <div className="graph-canvas-wrap">
    <div className="canvas-toolbar"><span>主干画布</span><Typography.Text type="secondary">{graph.nodes.filter(node => node.kind !== "note").length} 个概念 · {graph.edges.length} 条关系</Typography.Text></div>
    <div className="group-card-strip" aria-label="分组卡片">
      {groups.length ? groups.map(group => {
        const groupNotes = notesForGroup(group);
        const previews = groupNotes.slice(0, 2).map(note => note.label).join(" · ");
        return <button key={group.id} type="button" className={`group-card ${selectedNode === group.id ? "selected" : ""}`} onClick={() => setSelectedNode(group.id)} title={`选择分组：${group.label}`}>
          <span className="group-card-color" style={{ background: nodeColor(group.color) }} />
          <span className="group-card-content"><strong>{group.label}</strong><small>{groupNotes.length} 条批注</small><span className="group-card-preview">{previews || "暂无批注预览"}</span></span>
        </button>;
      }) : <Typography.Text type="secondary">暂无分组卡片</Typography.Text>}
    </div>
    <div className="graph-canvas" onPointerMove={event => { if (!dragging) return; const rect = event.currentTarget.getBoundingClientRect(); updateNode(dragging, { x: Math.max(12, Math.min(width - 190, event.clientX - rect.left - 84)), y: Math.max(12, Math.min(height - 80, event.clientY - rect.top - 24)) }); }} onPointerUp={() => setDragging(null)} onPointerLeave={() => setDragging(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="知识图谱关系图">{graph.edges.map(edge => { const from = graph.nodes.find(node => node.id === edge.from); const to = graph.nodes.find(node => node.id === edge.to); if (!from || !to) return null; const a = point(from); const b = point(to); return <line key={edge.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />; })}</svg>
      {graph.nodes.map(node => <button key={node.id} className={`graph-node kind-${node.kind} ${selectedNode === node.id ? "selected" : ""}`} style={{ left: node.x, top: node.y, "--node-color": nodeColor(node.color) }} onClick={() => setSelectedNode(node.id)} onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId); setDragging(node.id); }}><span>{node.kind === "root" ? "主题" : node.kind === "group" ? "概念类型" : node.kind === "note" ? "选中内容" : "概念"}</span><strong>{node.label}</strong></button>)}
    </div>
  </div>;
}

function WorkflowView({ graph, prompt }) { return <div className="workflow-view"><div className="canvas-toolbar"><span>工作流编排</span><Typography.Text type="secondary">输入 → 聚类 → 主干输出</Typography.Text></div><div className="workflow-board"><div className="workflow-node"><Icon name="ListTree" /><strong>选中内容</strong><small>{graph.nodes.filter(node => node.kind === "note").length} 条批注</small></div><Icon name="ArrowRight" className="workflow-arrow" /><div className="workflow-node"><Icon name="GitMerge" /><strong>概念聚类</strong><small>按分组和语义合并</small></div><Icon name="ArrowRight" className="workflow-arrow" /><div className="workflow-node accent"><Icon name="Sparkles" /><strong>主干导图</strong><small>最多 3 层，模糊其他细节</small></div></div><div className="workflow-output"><div className="panel-label"><span>提示词预览</span><Tag color="green">可复制给 AI</Tag></div><Input.TextArea value={prompt || "尚未生成提示词"} readOnly autoSize={{ minRows: 7, maxRows: 12 }} /></div></div>; }

createRoot(document.getElementById("mindmap-root")).render(<MindmapApp />);
