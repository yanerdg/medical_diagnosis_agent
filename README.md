# Medical Diagnosis Agent

面向医生的咽喉癌敏感性与耐受性辅助评估原型。它用于整理检查评语、报告文本和专病知识库证据；输出必须经医生复核，不能替代病理诊断、MDT 决策或治疗处方。

## 技术栈

- Next.js 15、React 19、TypeScript
- SQLite（`better-sqlite3`）
- Zod、Vitest、ESLint、Tailwind CSS

## 本地运行

需要 Node.js 及与 `package.json` 对应的依赖管理器。

```bash
npm install
npm run dev
```

常用校验：

```bash
npm run lint
npm run typecheck
npm test
```

## 配置

如需启用火山引擎模型服务，在本地 `.env` 文件中设置 `VOLCENGINE_API_KEY`。该文件已被 Git 忽略，切勿将密钥提交到仓库。

## 安全与临床边界

完整的功能边界、审核要求与输出约束见 [AGENT.md](AGENT.md)。
