# 开发与提交约定

## 分支和提交

- 一个提交尽量只包含一个可说明的主题。
- 提交信息使用动词开头，例如 `fix: preserve OCR annotations` 或 `docs: update setup guide`。
- 不要提交 `backend/data/`、`frontend/dist/`、`frontend/node_modules/`、`.venv/`、IDE 配置和 API Key。

## 修改前端

```bash
cd frontend
npm ci
npm run dev
```

完成后运行 `npm run build`，确保三个入口都能构建。

## 修改后端

```bash
python -m compileall backend
python backend/main.py
```

涉及 OCR 或持久化时，至少手动验证：上传 PDF、刷新后恢复批注、框选区域 OCR、修改分组、合并分组和打开图谱。

## Pull Request 检查清单

- [ ] README 或 API 行为有变化时同步更新文档。
- [ ] 没有把本地数据库、上传文件或密钥带入提交。
- [ ] `npm run build` 通过。
- [ ] Python 文件可以编译。
- [ ] 说明了 OCR 引擎或外部 API 的新增依赖。
