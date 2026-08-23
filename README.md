# Medical Diagnosis Agent

面向医生的咽喉癌敏感性与耐受性辅助评估原型。它用于整理检查评语、报告文本和专病知识库证据；输出必须经医生复核，不能替代病理诊断、MDT 决策或治疗处方。

## 技术栈

- Next.js 15、React 19、TypeScript
- SQLite（`better-sqlite3`）
- Zod、Vitest、ESLint、Tailwind CSS

## 本地运行

需要 Node.js 及与 `package.json` 对应的依赖管理器。仓库使用 pnpm：

```bash
pnpm install
pnpm dev
```

常用校验：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## 配置

如需启用火山引擎模型服务，在本地 `.env` 文件中设置 `VOLCENGINE_API_KEY`。该文件已被 Git 忽略，切勿将密钥提交到仓库。

## 本地 RAG（外部知识注入）

RAG 只接收人工明确导入的 Markdown、TXT、DOCX 或文本型 PDF；患者病例输入不会进入知识库。启动本地 Qwen3-Embedding 服务的步骤见 [services/local-embedding/README.md](services/local-embedding/README.md)。

复制 `.env.example` 为 `.env`，配置 `KNOWLEDGE_INGESTION_TOKEN` 后，通过受令牌保护的接口导入文件：

```powershell
$metadata = @{
  source_id = "larynx-guideline-2026"; source_title = "喉癌诊疗指南"
  source_type = "guideline"; cancer_site_scope = @("larynx")
  evidence_level = "guideline_consensus"; review_status = "approved"
  publish_date = "2026-01-01"; structured_tags = @("分期", "敏感性")
} | ConvertTo-Json -Compress

curl.exe -X POST http://localhost:3000/api/knowledge-documents `
  -H "x-knowledge-ingestion-token: <你的令牌>" `
  -F "file=@C:\knowledge\larynx-guideline.md" `
  -F "metadata=$metadata" `
  -F "knowledge_version=rag-v1"
```

导入成功后，`rag_search` 会优先使用通过审核的 SQLite 知识版本，混合 FTS5/BM25 与本地向量召回；本地 embedding 服务不可用时，会保留关键词召回。运行与故障边界见 [docs/RAG_ROADMAP.md](docs/RAG_ROADMAP.md)。

## 安全与临床边界

完整的功能边界、审核要求与输出约束见 [AGENT.md](AGENT.md)。
