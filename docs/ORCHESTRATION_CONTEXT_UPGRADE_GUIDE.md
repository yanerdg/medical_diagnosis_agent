# 编排与上下文升级行动指南

## 1. 目标与边界

本指南将现有固定评估流程升级为 **TypeScript LangGraph 的受限 ReAct 编排**，同时保留医疗场景必须的确定性门禁、可审计证据链和医生最终复核。

目标：

- 每个病例有可持续更新的“病历本”，关键事实在每个必要节点都进入上下文。
- Agent 只在受限范围内决定如何补证：检索 RAG、请求医生补充、提交/获取 CT 或 WSI 工具结果、生成草稿。
- 冲突检测覆盖病例、原始报告、CT/WSI 理解模型、RAG 证据和最终模型主张。
- 每个节点可 checkpoint、暂停、重启恢复；昂贵的影像模型任务不可重复提交。

非目标：

- 不让 Agent 自动确诊、开处方或替代医生裁决。
- 不让 CT/WSI 模型输出自动覆盖正式病理、正式影像报告或医生确认。
- 不将病例资料写入外部知识库，RAG 仅检索人工导入且审核通过的知识。

## 2. 技术决策

```text
Next.js / TypeScript
  └─ LangGraph.js：状态图、ReAct、checkpoint、interrupt、事件流
       ├─ 现有 SQLite：病例、证据、病历本、审计、RAG
       └─ Checkpointer：本地先 SQLite；多实例部署时切换 Postgres

Python 推理服务
  ├─ Qwen3 embedding
  ├─ CT multimodal understanding
  └─ WSI understanding
```

- 继续以 TypeScript 作为 Agent 后端。Python 只承载 GPU/医学模型推理服务。
- `assessment_run.run_id` 同时作为 LangGraph `thread_id`。
- 不使用开放式通用 `createReactAgent`；使用自定义 `StateGraph` 与白名单动作。
- 检查点保存编排状态；病例事实、原始资料、报告和审计继续保存在业务数据库中。

## 3. 证据、事实与病历本

### 3.1 三层模型

```text
原始资料 / 医生回答 / 工具输出
             ↓
EvidenceAssertion（带来源、时间、版本、置信度）
             ↓
ClinicalFact（规范化临床事实，可存在冲突）
             ↓
PatientMemorySnapshot（可读病历本 + 事实索引）
```

### 3.2 基本原则

1. 原始资料和 `EvidenceAssertion` 是可追溯依据；病历本是派生索引，不能成为唯一事实来源。
2. Agent 推理、草稿和自然语言结论不得直接写入长期事实或病历本。
3. 医生确认、正式病理/影像报告、原始检验结果优先级高于模型输出。
4. “未知”“不适用”“低质量”“相互矛盾”是有效状态，不能被压缩成阴性或正常。
5. 每条关键事实和每项冲突必须可回到原始输入、医生回答或工具结果。

### 3.3 建议契约

```ts
type EvidenceAssertion = {
  assertion_id: string;
  case_id: string;
  domain: "profile" | "history" | "imaging" | "pathology" | "biomarker" | "labs" | "treatment" | "risk";
  key: string;
  value: unknown;
  polarity: "present" | "absent" | "unknown" | "uncertain";
  source_type: "clinician_input" | "clinician_answer" | "signed_report" | "ct_model" | "wsi_model" | "rag_citation";
  source_ref: string;
  observed_at?: string;
  model_version?: string;
  confidence?: number;
  created_at: string;
};

type ClinicalFact = {
  fact_id: string;
  case_id: string;
  domain: EvidenceAssertion["domain"];
  key: string;
  value: unknown;
  status: "confirmed" | "reported" | "unknown" | "conflicting";
  evidence_ids: string[];
  observed_at?: string;
  updated_at: string;
};
```

模型输出可形成证据，但默认只能把事实状态提升到 `reported` 或 `uncertain`；只有经过医生确认的结果才可成为 `confirmed`。

## 4. 上下文管理器

新增 `ClinicalContextManager`，作为任何 LangGraph 节点取得病例上下文的唯一入口。节点、工具和 prompt 禁止自行读取整份病例原文后拼接上下文。

```ts
type ContextProfile =
  | "required_information_check"
  | "conflict_check"
  | "react_planner"
  | "rag_search"
  | "ct_tool"
  | "wsi_tool"
  | "draft_report"
  | "verifier";

type ContextBundle = {
  case_id: string;
  run_id: string;
  clinical_snapshot_id: string;
  source_fingerprint: string;
  core_fact_card: ClinicalFact[];
  task_facts: ClinicalFact[];
  unresolved_gaps: MissingEvidenceItem[];
  unresolved_conflicts: ConflictItem[];
  working_memory: RunWorkingMemory;
  source_excerpts: SourceExcerpt[];
  budget: ContextBudget;
};
```

### 4.1 始终带入的核心事实卡

- 当前癌种/原发部位与确认状态；
- 病理确认状态、关键病理与标志物；
- 既往和当前治疗；
- 高危红旗；
- ECOG、关键实验室及其时间；
- 阻断性缺失项；
- 未解决冲突；
- 病历本快照版本、来源指纹。

这些内容由结构化事实构成，不使用长篇摘要。其余信息根据 `ContextProfile` 选择性加入。

### 4.2 按节点装配

| Profile | 必带内容 | 禁止带入 |
| --- | --- | --- |
| `required_information_check` | 核心事实、缺失项、数据可用性 | 无关历史全文 |
| `conflict_check` | 同一事实键的全部候选证据、RAG 条件、模型版本 | 无关患者叙述 |
| `react_planner` | 核心事实、缺失/冲突、已执行动作、工具任务状态 | 原始影像、完整病历全文 |
| `rag_search` | 癌种、病理、分期线索、当前缺口 | 身份信息、无关治疗史 |
| `ct_tool` / `wsi_tool` | 文件引用、输入哈希、任务参数 | 无关临床全文 |
| `draft_report` | 已确认/已报告事实、冲突、未知项、引用 | 被淘汰的旧原文 |
| `verifier` | 待验证主张及其证据映射 | 未引用的自由文本 |

### 4.3 预算与淘汰

建议默认预算：核心事实卡 1,500 tokens、专题事实 2,500、工作记忆 1,500、近期医生对话 1,000、RAG 引文 2,000。按实际模型上下文窗口调整。

淘汰顺序：已解决追问 → 旧且低优先级摘录 → 无关专题 → 冗余描述。以下永不因预算淘汰：红旗、病理确认状态、当前治疗、阻断性缺失项、未解决冲突。

## 5. 冲突检测设计

冲突检测不是只比较 CT 与 WSI；它负责比较所有可影响患者结论的断言与主张。

```text
病例原始资料 / 医生回答 ─┐
正式病理、影像、检验报告 ─┼→ Evidence normalization → Conflict detection
CT / WSI 模型结构化输出 ─┤                              ↓
RAG 规则与引用条件 ────────┤                         ConflictItem
报告草稿与模型主张 ─────────┘                              ↓
                                            阻断、追问、降级或进入 verifier
```

### 5.1 冲突类别

| 类别 | 示例 | 默认处置 |
| --- | --- | --- |
| 事实值冲突 | 医生记录为喉部原发，CT 模型提示鼻咽来源 | `blocking`，请求复核 |
| 跨模态冲突 | 病理为鳞癌，WSI 模型强提示另一组织类型 | `blocking`，不能自动覆盖病理 |
| 时间冲突 | 使用已过期化验支持当前耐受性结论 | `high`，请求最新资料 |
| 状态冲突 | 报告宣称“病理确认”，事实层仍是未确认 | `blocking`，拦截报告 |
| 证据充分性冲突 | 模型主张治疗耐受良好，但缺 ECOG/肝肾功能 | `blocking` 或 `high` |
| RAG 适用性冲突 | 引用仅适用于另一癌种、版本已退役或审核未通过 | `blocking`，剔除引用 |
| RAG 蕴含冲突 | 报告主张与引用片段的限定条件相反 | `high`，返回 ReAct 补证/改写 |
| 工具质量冲突 | CT/WSI 任务为低质量或失败，却被当作正常结果 | `high`，改为 `unknown` |

### 5.2 冲突对象

```ts
type ConflictItem = {
  conflict_id: string;
  case_id: string;
  category: "fact" | "cross_modality" | "temporal" | "claim_evidence" | "rag_scope" | "quality";
  severity: "blocking" | "high" | "medium" | "low";
  field: string;
  left_evidence_ids: string[];
  right_evidence_ids: string[];
  description: string;
  resolution: "unresolved" | "clinician_confirmed" | "superseded" | "acknowledged_unknown";
  blocks: Array<"assessment" | "draft_report" | "final_report">;
  created_at: string;
  resolved_at?: string;
};
```

### 5.3 检测与裁决规则

1. 先运行确定性检测：字段不一致、日期时效、状态不一致、RAG metadata/版本/审核状态、引用与主张映射完整性。
2. 再允许模型做“候选语义冲突”识别；模型只能提出 `potential_conflict`，必须附两侧证据 ID，不能自行裁决。
3. 由来源优先级与医生确认进行裁决：

```text
医生确认 / 正式报告
  > 结构化解析的正式报告
  > 医生自由文本
  > CT / WSI 模型辅助输出
  > Agent 推理（不可作为事实依据）
```

4. `blocking` 冲突必须进入 `clarification_interrupt` 或将相关结论降为 `unknown`；不得自动选择一方。
5. 每次裁决都写入规则留痕：规则 ID、输入证据、输出、时间、执行版本。

## 6. 目标 LangGraph 编排

```text
START
  → hydrate_context
  → intake_validation
  → required_information_check
  → deterministic_rule_trace
  → preflight_conflict_check
  → gate: blocking gap/conflict?
       ├─ yes → clarification_interrupt → Command(resume) → hydrate_context
       └─ no  → react_plan

react_plan → react_act → react_observe → context_refresh → react_decide
  ↑                                                        │
  └──────────────── continue (max 6 reasoning turns) ─────┘
                                                           ├─ clinician_interrupt
                                                           ├─ verifier_chain
                                                           └─ failed / exhausted

verifier_chain
  → claim_to_evidence_check
  → rag_provenance_check
  → final_conflict_summary
  → output_schema_check
  → safety_gate
  → save_report → END
```

### 6.1 确定性节点职责

- `required_information_check`：生成缺失项、临床用途、阻断等级和可追问性。
- `deterministic_rule_trace`：执行病理、红旗、耐受性、时间时效等规则并保存 trace。
- `preflight_conflict_check`：草稿前检查病例事实、已有证据和已检索 RAG；阻断性冲突进入追问，不适用引用在生成草稿前剔除。
- `final_conflict_summary`：草稿后汇总 RAG 蕴含、主张—证据、事实可回查性、带日期检查的时效性和所有最终报告冲突。
- `clarification_interrupt`：保存结构化问题并暂停；不在暂停状态绕过证据缺口。
- `verifier_chain`：验证最终主张与病例证据、RAG 引用、冲突状态是否一致。

### 6.2 受限 ReAct 内核

`react_plan` 必须输出受 schema 限制的单一动作：

```ts
type PlannedAction =
  | "rag_search"
  | "request_clinician_input"
  | "submit_ct_job"
  | "collect_ct_result"
  | "submit_wsi_job"
  | "collect_wsi_result"
  | "generate_draft"
  | "finish";
```

每轮遵守：

1. `plan`：仅根据 `ContextBundle` 决定一个白名单动作；
2. `act`：执行一次工具调用；
3. `observe`：保存结构化结果、证据 ID、失败/质量状态和上下文变化；
4. `decide`：继续、暂停追问、进入 verifier 或因上限失败；
5. 病理、红旗、阻断性冲突和 safety gate 始终高于 planner 决策。

## 7. CT / WSI 工具服务

CT、WSI 是异步且幂等的白名单工具，不是事实裁决器。

```ts
type ImagingToolJob = {
  job_id: string;
  kind: "ct" | "wsi";
  case_id: string;
  input_ref: string;
  input_hash: string;
  idempotency_key: string;
  status: "queued" | "running" | "completed" | "failed" | "quality_insufficient";
  model_version: string;
  result_evidence_ids: string[];
};
```

- 提交 key：`run_id + tool_kind + input_hash + model_version`。
- 重启后优先按 key/`job_id` 读取已存在任务，绝不重新提交已完成任务。
- 结果必须包含置信度、质量状态、模型版本和影像/切片定位引用。
- `quality_insufficient`、`failed` 与 `uncertain` 进入冲突/缺失管理，不可转写为阴性。

## 8. 持久化、恢复与幂等

### 8.1 LangGraph 状态

```ts
type AssessmentGraphState = {
  run_id: string;
  case_id: string;
  context_manifest: ContextManifest;
  working_memory: RunWorkingMemory;
  planned_action?: PlannedAction;
  observations: StructuredObservation[];
  conflict_ids: string[];
  pending_tool_jobs: ImagingToolJob[];
  iteration: number;
};
```

- 每个 node 边界写入 checkpoint。
- API 使用同一 `run_id` / `thread_id` 读取状态并恢复。
- 医生回答经 schema 校验后以 `Command(resume)` 传入，而非重跑一整次流程。
- checkpoint 只存 ID、结构化状态和摘要；原始影像与大文本仍存业务存储。

### 8.2 副作用幂等键

| 副作用 | 幂等键 |
| --- | --- |
| CT/WSI 推理任务 | `run_id + input_hash + model_version + tool` |
| RAG 请求记录 | `run_id + iteration + normalized_query` |
| 医生追问 | `run_id + missing_evidence_code` |
| 报告修订 | `run_id + report_revision` |
| 规则留痕 | `run_id + rule_id + evidence_fingerprint` |
| 审计事件 | `run_id + node + action + attempt` |

## 9. 实施阶段

### 阶段 A：证据链与上下文基础

1. 修复 SQLite RAG 引用在报告详情页的回查。
2. 定义 `EvidenceAssertion`、`ClinicalFact`、`ConflictItem`、`ContextBundle` schema 与存储表。
3. 将现有 `PatientMemorySnapshot` 保留为兼容层，新增事实 ID/来源关联。
4. 实现 `ClinicalContextManager`，先替换评估图的全量 `source_texts` 读取。

当前完成状态：`ClinicalFact`、`ConflictItem`、`ContextBundle` 与上下文管理器已投入图执行。每次装配会生成 `ContextManifest`，记录 profile、选取的事实/摘录/冲突/工具任务、估算 token 和预算，随图节点事件留痕。新增不可变的 SQLite `EvidenceAssertion` 层，结构化提取、医生修正和追问回答产生的既有 `EvidenceModel` 现在以同一 evidence ID 持久化为断言，保留来源输入、原文摘录、置信度与时间；模型输出断言和事实归一化仍待后续接入。

### 阶段 B：多校验节点

1. 拆出必要信息、规则留痕、冲突检测、证据充分性节点。
2. 为病理、红旗、实验室时效、治疗状态、RAG 来源适用性实现确定性规则。
3. 增加冲突持久化、医生裁决和 `clarification_interrupt`。

当前完成状态：`deterministic_rule_trace`、`preflight_conflict_check` 与 `final_conflict_summary` 已作为显式图节点运行。前置冲突节点在初始资料和 RAG 检索后复用：阻断病例冲突会进入可审计医生追问，不适用/未审核引用会在生成草稿前剔除；后置节点在草稿后集中汇总 RAG 蕴含、主张—证据、事实可回查性及最终报告冲突。医生必须显式选择冲突裁决方向或“未知”，该选择随追问回答持久化；同一结构刷新时只替换结构检测器自身的未解决冲突，不会删除 RAG 或主张证据冲突。CT/WSI 冲突仍待其结构化输出接入后处理。

### 阶段 C：LangGraph 与恢复控制

1. 引入 LangGraph.js 和 SQLite checkpointer。
2. `run_id = thread_id`，保留现有 API 的兼容适配层。
3. 将暂停/恢复改为 `interrupt` / `Command(resume)`；补进程重启恢复测试。

当前完成状态：评估图已使用 SQLite checkpointer；阻断性缺失在 `clarification_gate` 创建幂等追问请求后触发 `interrupt`，恢复接口先校验并落库医生回答，再以原 `run_id`/`thread_id` 的 `Command(resume)` 继续。暂停时不生成报告；恢复后会重新装配病例上下文并从信息校验节点继续。已覆盖关闭 SQLite saver 后重新编译图并恢复同一中断 run 的回归测试。

### 阶段 D：受限 ReAct 内核

1. 接入 `plan → act → observe → decide`，限制动作 enum、轮次和输入上下文。
2. 仅让 planner 选择补证手段，不让其裁决病理、红旗或安全门。
3. 接入 claim-to-evidence、RAG provenance 与最终跨模态校验。

当前完成状态：评估图已在全部确定性门禁之后运行受限的 `react_plan → react_act → react_observe → context_refresh → react_decide` 循环。每次观察后，`context_refresh` 重建有界上下文并带入未解决冲突与任务状态；当前白名单动作包含 `submit_ct_job`、`collect_ct_result`、`rag_search` 与 `generate_draft`，每一步均写入 run event；只有存在 `ct_report` 输入且同一 run 尚无已完成 CT job 时才会选择 CT 动作。草稿后进入 RAG 主张蕴含、ClinicalFact 证据可回查性和最终证据状态校验，未解决的高/阻断级最终报告冲突会拒绝落库。WSI 动作、CT/WSI 结果的结构化事实归一化仍待接入。

### 阶段 E：CT / WSI 工具

1. 先使用 mock 异步 job 跑通提交、等待、重启恢复和冲突流。
2. 再接入真实 Python 推理服务与模型版本记录。
3. 建立针对低质量、失败、模型与人工报告冲突的测试集。

当前完成状态：已建立 SQLite 持久化的 CT/WSI mock 异步任务底座。提交按 `run_id + input_hash + model_version + tool` 去重，任务状态、结果证据 ID 与审计事件可在重启后读取；重复收集已完成任务不会再次生成结果。CT mock 的提交与收集已接入 ReAct 白名单；下一步接入 WSI、真实 Python 推理服务、质量状态和结构化证据/冲突流。

## 10. 验收标准

- 任意节点/服务重启后，从最后成功 checkpoint 恢复；已成功的 CT/WSI 任务不会重复执行。
- 每个最终主张均能列出病例事实、原始证据和 RAG 引用；无来源主张被 verifier 拦截。
- 病理未确认、红旗、阻断性缺失或 `blocking` 冲突不能被 ReAct 绕过。
- RAG 不适用、版本退役、审核未通过或与主张不蕴含时，引用会被剔除并留下记录。
- CT/WSI 低质量、失败或与正式报告矛盾时，不产生伪阴性结论，转为冲突或待补充项。
- 每个 node 的上下文均可输出 `ContextManifest`：使用了哪些事实/摘要/证据、为何选择、消耗多少预算。

## 11. 近期实施优先级

1. `ClinicalContextManager` + 核心事实卡；
2. `ConflictItem` 与确定性冲突检测；
3. SQLite RAG 引用回查闭环；
4. LangGraph checkpoint 与 interrupt；
5. 受限 ReAct；
6. CT/WSI 异步工具接入。
