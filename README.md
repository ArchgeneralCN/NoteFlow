# NoteFlow

NoteFlow 是一个面向长文档阅读的本地优先工作台：用户可以导入 PDF、文本或 Markdown，进行精细勾画，保存 OCR 定位和批注结果，再按颜色分组构建知识图谱和思维导图。

项目采用 React + Vite 前端和 Python 标准库后端。默认数据保存在本机，适合个人学习、论文阅读和知识整理场景。

## 功能

- 文档资料库：导入 PDF、TXT、Markdown，支持收藏夹、移动、删除和恢复。
- 阅读与勾画：PDF 文本层、OCR 定位框、区域 OCR、颜色分组、撤销和批注编辑。
- OCR 持久化：PDF OCR 任务、用户框选区域、文字修订和批注统一写入本地 SQLite。
- 批处理：翻译、离线词典、词性释义和自定义 JavaScript 处理函数。
- 分组整理：分组标题拖动合并，分组和批注复选框选择。
- 图谱工作流：从当前文档的完整分组生成节点、关系和分组卡片，支持拖动节点、编辑、添加、保存和 JSON 导出。
- AI 辅助：生成“只保留主干、模糊其他细节”的提示词；配置 API 后可自动构建主干图谱。

## 项目结构

```text
.
├── backend/
│   ├── __init__.py           # Python 包入口
│   ├── main.py              # 静态文件服务、OCR 任务和 SQLite 存储
│   └── data/                # 运行时数据，不提交到 Git
├── frontend/
│   ├── index.html            # 阅读器入口
│   ├── mindmap.html          # 图谱工作流入口
│   ├── settings.html         # 设置入口
│   ├── src/
│   │   ├── main.jsx          # 阅读器和批注工作区
│   │   ├── mindmap.jsx       # 图谱工作流和画布
│   │   ├── settings.jsx      # 设置页
│   │   └── *.css             # 页面样式
│   ├── package.json
│   └── vite.config.js
├── docs/
│   ├── ARCHITECTURE.md       # 数据流、接口和部署说明
│   └── CONTRIBUTING.md       # 开发和提交约定
├── .github/workflows/ci.yml  # GitHub Actions 基础检查
├── pyproject.toml            # Python 项目和可选 OCR 依赖
├── uv.lock                   # Python 锁文件
└── README.md
```

`frontend/dist/`、`frontend/node_modules/`、Python 虚拟环境和 `backend/data/` 都是本地生成目录，不应提交。

## 环境要求

- Python 3.12+
- Node.js 18+，建议使用当前 LTS
- npm
- 可选：`uv`，用于按 `pyproject.toml` 管理 Python 依赖

## 快速开始

### 1. 安装前端依赖并构建

```bash
cd frontend
npm install
npm run build
```

### 2. 启动应用

回到项目根目录执行：

```bash
python backend/main.py
```

浏览器访问 <http://127.0.0.1:8000>。

后端会直接提供 `frontend/dist/` 中的生产构建。如果修改了前端源码，需要重新执行 `npm run build`。

安装 Python 项目后，也可以使用命令行入口启动：

```bash
python -m pip install -e .
noteflow
```

### 前端开发模式

```bash
cd frontend
npm run dev
```

Vite 默认地址是 <http://127.0.0.1:5173>。开发模式下，页面仍会把 OCR 和文档持久化请求发送到 `http://127.0.0.1:8000`。也可以在页面加载前设置 `window.__NOTEFLOW_API_BASE` 覆盖后端地址。

## Python 依赖和 OCR

基础后端只使用 Python 标准库。可选能力通过 extras 安装：

```bash
# 使用 uv
uv pip install -e .
uv pip install -e '.[ocr]'

# 或使用 pip
python -m pip install -e .
python -m pip install -e '.[ocr]'
```

可选 OCR 引擎：

- `pymupdf`：提取 PDF 原生文本并定位。
- `pytesseract` + Tesseract：扫描文档和区域 OCR 的降级方案。
- `mineru`：更完整的 PDF 版面解析和 OCR。首次使用可能需要下载模型。
- `chromadb`：可选的 OCR 文本向量索引，不安装不影响 SQLite 持久化。

后端启动后可通过以下接口查看当前可用引擎：

```text
GET http://127.0.0.1:8000/api/ocr/status
```

## 主要 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/ocr/status` | 查询 OCR 引擎状态 |
| `POST` | `/api/ocr/pdf` | 提交 PDF OCR 任务 |
| `GET` | `/api/ocr/pdf/<job_id>` | 查询 OCR 任务 |
| `POST` | `/api/ocr/region` | 对用户框选区域执行 OCR |
| `GET` | `/api/documents` | 查询已保存文档 |
| `GET` | `/api/documents/<id>/ocr` | 获取文档 OCR 结果 |
| `GET` | `/api/documents/<id>/annotations` | 获取批注和分组 |
| `PUT` | `/api/documents/<id>/annotations` | 保存批注和分组 |

PDF 上传上限为 64 MB，单个文档批注状态上限为 8 MB。接口实现和数据校验集中在 `backend/main.py`，详细数据流见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 数据和隐私

运行时数据默认写入 `backend/data/`：

- `noteflow.sqlite3`：文档元数据、任务状态、批注、分组和用户 OCR 区域。
- `uploads/`：上传的原始 PDF。
- `processed/`：OCR 归一化 JSON。
- `chroma/`：安装 Chroma 后生成的可选向量索引。

这些数据不会被 Git 跟踪。使用云端 LLM 时，只有你在设置页主动配置并调用的接口会收到相应内容，请在提交仓库前检查 API Key、上传文件和本地数据库是否仍在工作区中。

## 开发检查

提交前至少执行：

```bash
cd frontend
npm run build
cd ..
python -m compileall backend
```

本项目当前没有独立的自动化测试套件；涉及 OCR、文件上传或批注持久化的修改，建议手动验证导入、刷新恢复、区域 OCR、分组合并和图谱跳转流程。

## 后续计划

- 将 OCR Worker 和 API 服务拆分为可独立部署的进程。
- 为 OCR、批注恢复和图谱草稿增加自动化回归测试。
- 增加更完善的词表、分词和可视化布局配置。
- 支持更多工作流节点类型和可复用处理函数。

## License

当前仓库未声明开源许可证。公开发布前，请根据你的使用和分发计划补充 `LICENSE` 文件。
