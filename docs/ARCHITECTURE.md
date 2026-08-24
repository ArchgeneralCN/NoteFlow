# NoteFlow 架构说明

## 运行边界

NoteFlow 是一个本地优先的单机应用：浏览器负责交互和视图状态，Python 服务负责静态文件、文件写入、OCR 任务队列和持久化。后端没有引入 Web 框架，使用 `http.server.ThreadingHTTPServer` 处理请求。

```text
浏览器
  ├── React 阅读器（/）
  ├── React 设置页（/settings.html）
  └── React 图谱页（/mindmap.html）
          │
          │ HTTP / JSON / multipart
          ▼
Python AppHandler
  ├── 静态文件：frontend/dist/
  ├── DocumentStore：SQLite + 文件目录
  ├── PdfJobQueue：FIFO OCR Worker
  └── OcrEngine：MinerU / PyMuPDF / Tesseract

浏览器端另有 PDF.js 文本层作为无后端 OCR 时的阅读降级。
```

## 前端页面

- `src/main.jsx`：资料库、阅读器、OCR 文本层、勾画、批注、分组和批处理。
- `src/mindmap.jsx`：读取 `localStorage` 中的图谱草稿，按分组创建 root/group/note 节点和关系，并保存用户调整后的图谱。
- `src/settings.jsx`：处理插件、OCR 引擎、词表和 API 配置。
- `vite.config.js`：把三个 HTML 入口构建到同一个 `dist/` 目录。

阅读器打开图谱时，会把当前文档的批注和颜色分组写入 `noteflow-mindmap-draft-v1`，然后打开带时间参数的 `/mindmap.html`。图谱页使用文档 ID 和草稿时间戳校验已保存图谱，避免新增批注后继续显示旧图。

## 后端持久化

`DocumentStore` 管理三类 SQLite 数据：

1. `documents`：原始文件、OCR 引擎、任务状态、结果 JSON 和内容哈希。
2. `document_annotations`：批注数组和颜色分组。
3. `document_ocr_regions`：用户框选区域的文字、bbox、页码和 OCR 来源。

文件本体和 OCR 结果分别位于 `backend/data/uploads/` 与 `backend/data/processed/`。OCR Worker 完成任务时会合并已保存的用户区域，避免覆盖用户在处理期间提交的区域识别结果。

## OCR 生命周期

1. 浏览器向 `POST /api/ocr/pdf` 上传 PDF。
2. 服务按内容哈希和引擎复用已完成或正在处理的任务；新任务进入 FIFO 队列并返回 `job_id`。
3. Worker 执行可用 OCR 引擎，统一生成页、文本项、bbox 和尺寸信息。
4. 浏览器轮询 `GET /api/ocr/pdf/<job_id>`，完成后渲染定位文本层。
5. 用户框选区域走 `POST /api/ocr/region`，带 `document_id` 时会同步写入用户 OCR 区域表。
6. 批注修改通过 `PUT /api/documents/<id>/annotations` 保存，区域文字修订同步回 OCR 结果。

## 部署约束

生产服务启动前必须存在 `frontend/dist/`。推荐部署步骤：

```bash
cd frontend && npm ci && npm run build
cd .. && python backend/main.py
```

当前服务默认只监听 `127.0.0.1:8000`，适合本机使用。若要放到局域网或公网，需额外增加反向代理、身份认证、上传限制和 HTTPS，不建议直接暴露当前开发服务器。
