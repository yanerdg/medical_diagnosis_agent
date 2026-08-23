import type { JsonValue } from "@/domain/evidence";
import type {
  AssessmentReportRecord,
  AssessmentRun,
  AssessmentRunStatus,
  ClarificationRequest,
  ClarificationQuestion,
  SpecialtyStructure,
} from "@/domain/schemas";
import {
  getMedicalRepository,
  type MedicalRepository,
} from "@/server/repositories";
import {
  ClinicalContextManager,
  detectRagCitationConflicts,
  type ConflictItem,
} from "@/server/context";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
  isGraphInterrupt,
  isInterrupted,
} from "@langchain/langgraph";
import { createHash, randomUUID } from "node:crypto";
import { createAssessmentCheckpointer } from "./langgraph-checkpointer";
import {
  WHITELISTED_ASSESSMENT_TOOLS,
  type AssessmentReportGeneratorInput,
} from "./tools";
import {
  MAX_AGENT_LOOP_COUNT,
  type AssessmentGraphDefinition,
  type AssessmentGraphNext,
  type AssessmentNodeName,
  type AssessmentRunState,
  type MissingEvidenceItem,
  type WhitelistedToolName,
} from "./types";

export interface RunAssessmentGraphParams {
  case_id: string;
  run_id?: string;
  structure_id?: string;
  acknowledged_missing_evidence_codes?: string[];
  repository?: MedicalRepository;
  max_loop_count?: number;
  checkpoint_path?: string;
  now?: () => string;
}

export interface RunAssessmentGraphResult {
  run: AssessmentRun;
  state: AssessmentRunState;
  report?: AssessmentReportRecord;
  clarification_request?: ClarificationRequest;
}

export interface ResumeAssessmentGraphParams {
  case_id: string;
  run_id: string;
  structure_id: string;
  acknowledged_missing_evidence_codes: string[];
  repository?: MedicalRepository;
  max_loop_count?: number;
  checkpoint_path?: string;
  now?: () => string;
}

interface ClarificationResumePayload {
  kind: "clarification_response";
  structure_id: string;
  acknowledged_missing_evidence_codes: string[];
}

interface AssessmentGraphRuntime {
  repository: MedicalRepository;
  now: () => string;
  callTool: <Input, Output>(
    state: AssessmentRunState,
    toolName: WhitelistedToolName,
    input: Input,
    tool: (input: Input) => Output | Promise<Output>,
  ) => Promise<Output>;
  updateRunStatus: (
    state: AssessmentRunState,
    status: AssessmentRunStatus,
  ) => AssessmentRun;
}

const DurableAssessmentState = Annotation.Root({
  assessment: Annotation<AssessmentRunState>,
});

type DurableNodeName = AssessmentNodeName;

export function createAssessmentGraph(
  runtime: AssessmentGraphRuntime,
  maxLoopCount = MAX_AGENT_LOOP_COUNT,
): AssessmentGraphDefinition {
  return {
    max_loop_count: maxLoopCount,
    entrypoint: "intake_validation",
    nodes: {
      intake_validation: {
        name: "intake_validation",
        invoke: (state) => intakeValidationNode(state, runtime),
      },
      pathology_gate: {
        name: "pathology_gate",
        invoke: (state) => pathologyGateNode(state, runtime),
      },
      missing_evidence_check: {
        name: "missing_evidence_check",
        invoke: (state) => missingEvidenceCheckNode(state, runtime),
      },
      conflict_check: {
        name: "conflict_check",
        invoke: (state) => conflictCheckNode(state, runtime),
      },
      clarification_gate: {
        name: "clarification_gate",
        invoke: (state) => clarificationGateNode(state, runtime),
      },
    },
  };
}

export async function runAssessmentGraph(
  params: RunAssessmentGraphParams,
): Promise<RunAssessmentGraphResult> {
  const repository = params.repository ?? getMedicalRepository();
  const now = params.now ?? (() => new Date().toISOString());
  const caseRecord = repository.getCase(params.case_id);

  if (!caseRecord) {
    throw new Error(`Case not found: ${params.case_id}`);
  }

  const structure = loadStructure(repository, params);
  const runId = params.run_id ?? randomUUID();
  const existingRun = repository.getAssessmentRun(runId);
  const initialRun = repository.saveAssessmentRun({
    run_id: runId,
    case_id: params.case_id,
    status: "running",
    structure_id: structure?.structure_id ?? params.structure_id,
    created_at: existingRun?.created_at ?? now(),
    updated_at: now(),
  });
  const runtime = createAssessmentGraphRuntime(repository, now, initialRun);
  const graph = createAssessmentGraph(
    runtime,
    params.max_loop_count ?? MAX_AGENT_LOOP_COUNT,
  );
  const contextBundle = structure
    ? new ClinicalContextManager(repository).build({
        case_id: params.case_id,
        run_id: runId,
        structure,
        profile: "required_information_check",
      })
    : undefined;
  const initialState: AssessmentRunState = {
    run_id: runId,
    case_id: params.case_id,
    structure_id: structure?.structure_id ?? params.structure_id,
    status: "running",
    loop_count: 0,
    max_loop_count: graph.max_loop_count,
    next: graph.entrypoint,
    structure,
    source_texts: loadSourceTexts(repository, params.case_id),
    context_bundle: contextBundle,
    missing_evidence: [],
    acknowledged_missing_evidence_codes:
      params.acknowledged_missing_evidence_codes ?? [],
    errors: [],
    tool_outputs: {},
  };

  appendRunEvent(repository, initialState, "assessment.run.started", {
    case_id: initialState.case_id,
    structure_id: initialState.structure_id,
    max_loop_count: initialState.max_loop_count,
    acknowledged_missing_evidence_codes:
      initialState.acknowledged_missing_evidence_codes,
    context: contextBundle
      ? {
          source_fingerprint: contextBundle.source_fingerprint,
          core_fact_count: contextBundle.core_fact_card.length,
          task_fact_count: contextBundle.task_facts.length,
          excerpt_count: contextBundle.source_excerpts.length,
          unresolved_conflict_count: contextBundle.unresolved_conflicts.length,
        }
      : null,
  });

  const durableGraph = createDurableAssessmentGraph(
    graph,
    runtime,
    params.checkpoint_path,
  );
  const durableResult = await durableGraph.invoke(
    { assessment: initialState },
    { configurable: { thread_id: runId } },
  );
  return finalizeDurableAssessmentResult({
    repository,
    run: initialRun,
    result: durableResult,
  });
}

export async function resumeAssessmentGraph(
  params: ResumeAssessmentGraphParams,
): Promise<RunAssessmentGraphResult> {
  const repository = params.repository ?? getMedicalRepository();
  const now = params.now ?? (() => new Date().toISOString());
  const existingRun = repository.getAssessmentRun(params.run_id);

  if (!existingRun) {
    throw new Error(`Assessment run not found: ${params.run_id}`);
  }

  const run = repository.saveAssessmentRun({
    ...existingRun,
    status: "running",
    structure_id: params.structure_id,
    updated_at: now(),
  });
  const runtime = createAssessmentGraphRuntime(repository, now, run);
  const definition = createAssessmentGraph(
    runtime,
    params.max_loop_count ?? MAX_AGENT_LOOP_COUNT,
  );
  const durableGraph = createDurableAssessmentGraph(
    definition,
    runtime,
    params.checkpoint_path,
  );
  const result = await durableGraph.invoke(
    new Command<
      ClarificationResumePayload,
      { assessment?: AssessmentRunState },
      DurableNodeName | "__start__"
    >({
      resume: {
        kind: "clarification_response",
        structure_id: params.structure_id,
        acknowledged_missing_evidence_codes:
          params.acknowledged_missing_evidence_codes,
      },
    }),
    { configurable: { thread_id: params.run_id } },
  );

  return finalizeDurableAssessmentResult({ repository, run, result });
}

function createAssessmentGraphRuntime(
  repository: MedicalRepository,
  now: () => string,
  initialRun: AssessmentRun,
): AssessmentGraphRuntime {
  return {
    repository,
    now,
    callTool: (state, toolName, input, tool) =>
      callWhitelistedTool(repository, state, toolName, input, tool),
    updateRunStatus: (state, status) =>
      repository.saveAssessmentRun({
        run_id: state.run_id,
        case_id: state.case_id,
        status,
        structure_id: state.structure?.structure_id ?? state.structure_id,
        created_at:
          repository.getAssessmentRun(state.run_id)?.created_at ??
          initialRun.created_at,
        updated_at: now(),
      }),
  };
}

function finalizeDurableAssessmentResult(params: {
  repository: MedicalRepository;
  run: AssessmentRun;
  result: typeof DurableAssessmentState.State | Record<string, unknown>;
}): RunAssessmentGraphResult {
  const { repository, run, result } = params;
  const durableResult = result as Record<string | symbol, unknown>;
  const state = durableResult.assessment as AssessmentRunState;

  if (isInterrupted(result)) {
    const request = repository.listClarificationRequests(run.run_id).at(-1);
    const pausedState: AssessmentRunState = {
      ...state,
      status: "paused_for_clinician_input",
      next: "paused",
      pending_clarification: request
        ? {
            request_id: request.request_id,
            reason: request.reason,
            questions: request.questions,
          }
        : undefined,
    };
    return {
      run: repository.getAssessmentRun(run.run_id) ?? run,
      state: pausedState,
      clarification_request: pausedState.pending_clarification,
    };
  }

  appendRunEvent(repository, state, "assessment.run.finished", {
    status: state.status,
    next: state.next,
    loop_count: state.loop_count,
  });
  return {
    run: repository.getAssessmentRun(run.run_id) ?? run,
    state,
    report: repository.getAssessmentReportForRun(run.run_id) ?? undefined,
    clarification_request: state.pending_clarification,
  };
}

function createDurableAssessmentGraph(
  definition: AssessmentGraphDefinition,
  runtime: AssessmentGraphRuntime,
  checkpointPath: string | undefined,
) {
  const invoke = (nodeName: DurableNodeName) => async (state: typeof DurableAssessmentState.State) => ({
    assessment: await invokeDurableNode(
      nodeName,
      state.assessment,
      definition.nodes[nodeName].invoke,
      runtime,
    ),
  });
  return new StateGraph(DurableAssessmentState)
    .addNode("intake_validation", invoke("intake_validation"))
    .addNode("pathology_gate", invoke("pathology_gate"))
    .addNode("missing_evidence_check", invoke("missing_evidence_check"))
    .addNode("conflict_check", invoke("conflict_check"))
    .addNode("clarification_gate", invoke("clarification_gate"))
    .addEdge(START, "intake_validation")
    .addConditionalEdges("intake_validation", (state) => routeDurableNext(state.assessment.next))
    .addConditionalEdges("pathology_gate", (state) => routeDurableNext(state.assessment.next))
    .addConditionalEdges("missing_evidence_check", (state) => routeDurableNext(state.assessment.next))
    .addConditionalEdges("conflict_check", (state) => routeDurableNext(state.assessment.next))
    .addConditionalEdges("clarification_gate", (state) => routeDurableNext(state.assessment.next))
    .compile({ checkpointer: createAssessmentCheckpointer(checkpointPath) });
}

async function invokeDurableNode(
  nodeName: AssessmentNodeName,
  state: AssessmentRunState,
  invoke: (state: AssessmentRunState) => Promise<AssessmentRunState>,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (state.loop_count >= state.max_loop_count) {
    const failed = {
      ...state,
      status: "failed" as const,
      next: "failed" as const,
      errors: [...state.errors, `Agent loop limit exceeded: ${state.max_loop_count}`],
    };
    runtime.updateRunStatus(failed, "failed");
    appendRunEvent(runtime.repository, failed, "assessment.loop_limit_exceeded", {
      loop_count: failed.loop_count,
      max_loop_count: failed.max_loop_count,
    });
    return failed;
  }

  const startedState = {
    ...state,
    current_node: nodeName,
    loop_count: state.loop_count + 1,
  };
  appendRunEvent(runtime.repository, startedState, "assessment.node.started", {
    node: nodeName,
    loop_count: startedState.loop_count,
  });
  try {
    const nextState = await invoke(startedState);
    appendRunEvent(runtime.repository, nextState, "assessment.node.completed", {
      node: nodeName,
      next: nextState.next,
      status: nextState.status,
      missing_evidence_count: nextState.missing_evidence.length,
    });
    if (nextState.status === "failed") runtime.updateRunStatus(nextState, "failed");
    return nextState;
  } catch (error) {
    if (isGraphInterrupt(error)) {
      throw error;
    }
    const failed = {
      ...startedState,
      status: "failed" as const,
      next: "failed" as const,
      errors: [...startedState.errors, errorToMessage(error)],
    };
    runtime.updateRunStatus(failed, "failed");
    appendRunEvent(runtime.repository, failed, "assessment.node.failed", {
      node: nodeName,
      error: errorToMessage(error),
    });
    return failed;
  }
}

function routeDurableNext(next: AssessmentGraphNext): DurableNodeName | typeof END {
  return isNodeName(next) ? next : END;
}

async function intakeValidationNode(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (!state.structure) {
    return failState(state, "No specialty structure is available for assessment");
  }

  const parsed = await runtime.callTool(
    state,
    "parser",
    state.structure,
    WHITELISTED_ASSESSMENT_TOOLS.parser,
  );
  const missingEvidence =
    parsed.cancer_site === "unknown"
      ? [
          ...state.missing_evidence,
          {
            code: "cancer_site.unknown",
            label: "癌种部位",
            severity: "recommended" as const,
            question: "请确认肿瘤原发部位或补充影像/内镜描述。",
            clinical_purpose: "确认评估是否属于当前咽喉癌 MVP 范围。",
          },
        ]
      : state.missing_evidence;

  return {
    ...state,
    next: "pathology_gate",
    missing_evidence: dedupeMissingEvidence(missingEvidence),
    tool_outputs: {
      ...state.tool_outputs,
      parser: parsed,
    },
  };
}

async function pathologyGateNode(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (!state.structure) {
    return failState(state, "No specialty structure is available for pathology gate");
  }

  const pathologyMissingAcknowledged =
    state.acknowledged_missing_evidence_codes.includes(
      "pathology.confirmation_missing",
    );
  const missingPathology: MissingEvidenceItem[] =
    state.structure.pathology.status === "confirmed"
      ? []
      : [
          {
            code: "pathology.confirmation_missing",
            label: "病理确认",
            severity: pathologyMissingAcknowledged ? "recommended" : "blocking",
            question: "请补充病理报告结论、病理类型及取材部位。",
            clinical_purpose: "缺少病理时不能输出确诊或敏感性确定性结论。",
          },
        ];

  runtime.updateRunStatus(state, "running");

  return {
    ...state,
    next: "missing_evidence_check",
    missing_evidence: dedupeMissingEvidence([
      ...state.missing_evidence,
      ...missingPathology,
    ]),
  };
}

async function missingEvidenceCheckNode(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (!state.structure) {
    return failState(state, "No specialty structure is available for evidence check");
  }

  const labCheck = await runtime.callTool(
    state,
    "lab_checker",
    state.structure,
    WHITELISTED_ASSESSMENT_TOOLS.lab_checker,
  );
  const tnm = await runtime.callTool(
    state,
    "tnm_mapper",
    state.structure,
    WHITELISTED_ASSESSMENT_TOOLS.tnm_mapper,
  );
  const contradictions = await runtime.callTool(
    state,
    "contradiction_checker",
    state.structure,
    WHITELISTED_ASSESSMENT_TOOLS.contradiction_checker,
  );
  const labMissing = labCheck.missing.map((label) =>
    missingEvidenceItem({
      code: `labs.${normalizeCode(label)}_missing`,
      label,
      question: `请补充${label}结果或注明无法获得。`,
      clinical_purpose: "评估治疗耐受性，缺失时不能判定耐受性良好。",
    }),
  );
  const stagingMissing = tnm.missing_for_staging.map((label) =>
    missingEvidenceItem({
      code: `staging.${normalizeCode(label)}_missing`,
      label,
      question: `请补充${label}相关检查信息。`,
      clinical_purpose: "完善 TNM 分期线索，降低分期不确定性。",
    }),
  );

  return {
    ...state,
    next: "conflict_check",
    missing_evidence: dedupeMissingEvidence([
      ...state.missing_evidence,
      ...labMissing,
      ...stagingMissing,
    ]),
    tool_outputs: {
      ...state.tool_outputs,
      lab_checker: labCheck,
      tnm_mapper: tnm,
      contradiction_checker: contradictions,
    },
  };
}

async function conflictCheckNode(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (!state.structure) {
    return failState(state, "No specialty structure is available for conflict check");
  }

  const contextBundle = new ClinicalContextManager(runtime.repository).build({
    case_id: state.case_id,
    run_id: state.run_id,
    structure: state.structure,
    profile: "conflict_check",
  });
  const blockingConflicts = contextBundle.unresolved_conflicts.filter(
    (conflict) =>
      conflict.severity === "blocking" && conflict.blocks.includes("assessment"),
  );
  appendRunEvent(runtime.repository, state, "assessment.conflict.checked", {
    unresolved_conflict_count: contextBundle.unresolved_conflicts.length,
    blocking_conflict_ids: blockingConflicts.map((conflict) => conflict.conflict_id),
  });

  return {
    ...state,
    context_bundle: contextBundle,
    next: "clarification_gate",
    missing_evidence: dedupeMissingEvidence([
      ...state.missing_evidence,
      ...blockingConflicts.map(conflictToMissingEvidence),
    ]),
  };
}

function conflictToMissingEvidence(conflict: ConflictItem): MissingEvidenceItem {
  return {
    code: `conflict.${conflict.conflict_id}`,
    label: "证据冲突复核",
    severity: "blocking",
    question: `请医生裁决以下证据冲突：${conflict.description}`,
    clinical_purpose: "阻断性证据冲突未裁决前，不得生成评估结论。",
  };
}

async function clarificationGateNode(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (!state.structure) {
    return failState(state, "No specialty structure is available for clarification gate");
  }

  const blockingMissing = state.missing_evidence.filter(
    (item) => item.severity === "blocking",
  );
  if (blockingMissing.length > 0) {
    const { request: pendingClarification, created } = ensureClarificationRequest(
      state,
      runtime,
      blockingMissing,
    );
    const pausedState = {
      ...state,
      status: "paused_for_clinician_input" as const,
      next: "paused" as const,
      pending_clarification: pendingClarification,
    };
    runtime.updateRunStatus(pausedState, "paused_for_clinician_input");
    if (created) {
      appendRunEvent(runtime.repository, pausedState, "assessment.clarification.interrupted", {
        request_id: pendingClarification.request_id,
        blocking_missing_evidence_codes: blockingMissing.map((item) => item.code),
      });
    }

    const resume = interrupt<ClarificationRequest, ClarificationResumePayload>(
      pendingClarification,
    );
    const resumedStructure = runtime.repository.getSpecialtyStructure(
      resume.structure_id,
    );
    if (!resumedStructure || resumedStructure.case_id !== state.case_id) {
      return failState(state, "Clarification resume payload references an invalid structure.");
    }

    return {
      ...state,
      structure_id: resumedStructure.structure_id,
      structure: resumedStructure,
      source_texts: loadSourceTexts(runtime.repository, state.case_id),
      context_bundle: new ClinicalContextManager(runtime.repository).build({
        case_id: state.case_id,
        run_id: state.run_id,
        structure: resumedStructure,
        profile: "required_information_check",
      }),
      status: "running",
      next: "intake_validation",
      loop_count: 0,
      missing_evidence: [],
      acknowledged_missing_evidence_codes:
        resume.acknowledged_missing_evidence_codes,
      pending_clarification: undefined,
    };
  }

  const pendingClarification = undefined;
  const reportState = await runReportToolchain(
    {
      ...state,
      pending_clarification: pendingClarification,
    },
    runtime,
  );
  const validation = reportState.tool_outputs.output_schema_validator;
  recordReportGateEvents(runtime.repository, reportState, validation);
  const nextStatus: AssessmentRunStatus =
    pendingClarification !== undefined
      ? "paused_for_clinician_input"
      : validation?.valid
        ? "completed"
        : "rejected_by_safety_gate";
  const next: AssessmentGraphNext =
    nextStatus === "completed"
      ? "completed"
      : nextStatus === "paused_for_clinician_input"
        ? "paused"
        : "failed";

  if (
    reportState.report &&
    reportState.report_markdown &&
    validation?.valid
  ) {
    const savedReport = runtime.repository.saveAssessmentReport({
      report_id: randomUUID(),
      run_id: state.run_id,
      case_id: state.case_id,
      report_json: reportState.report,
      report_markdown: reportState.report_markdown,
      created_at: runtime.now(),
    });
    appendRunEvent(runtime.repository, reportState, "assessment.report.saved", {
      report_id: savedReport.report_id,
      assessment_status: savedReport.report_json.assessment_status,
      review_required: savedReport.report_json.review_required,
    });
  }

  runtime.updateRunStatus(reportState, nextStatus);

  return {
    ...reportState,
    status: nextStatus,
    next,
    pending_clarification: pendingClarification,
    errors:
      nextStatus === "rejected_by_safety_gate"
        ? [
            ...reportState.errors,
            ...(validation?.schema_errors ?? []),
            ...(validation?.verifier_issues.map((issue) => issue.message) ?? []),
            ...(validation?.safety_issues.map((issue) => issue.message) ?? []),
          ]
        : reportState.errors,
  };
}

function recordReportGateEvents(
  repository: MedicalRepository,
  state: AssessmentRunState,
  validation: AssessmentRunState["tool_outputs"]["output_schema_validator"],
): void {
  if (!validation) {
    appendRunEvent(repository, state, "assessment.report.verifier.rejected", {
      schema_errors: ["Output validator did not return a result."],
      verifier_issues: [],
    });
    appendRunEvent(repository, state, "assessment.report.safety_gate.rejected", {
      safety_issues: [],
      red_flags: [],
    });
    return;
  }

  const verifierPassed =
    validation.schema_errors.length === 0 &&
    !validation.verifier_issues.some((issue) => issue.severity === "error");
  const safetyPassed = !validation.safety_issues.some(
    (issue) => issue.severity === "error",
  );

  appendRunEvent(
    repository,
    state,
    verifierPassed
      ? "assessment.report.verifier.passed"
      : "assessment.report.verifier.rejected",
    {
      schema_errors: validation.schema_errors,
      verifier_issues: validation.verifier_issues,
    },
  );
  appendRunEvent(
    repository,
    state,
    safetyPassed
      ? "assessment.report.safety_gate.passed"
      : "assessment.report.safety_gate.rejected",
    {
      safety_issues: validation.safety_issues,
      red_flags: validation.red_flags,
    },
  );
}

async function runReportToolchain(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
): Promise<AssessmentRunState> {
  if (!state.structure) {
    return failState(state, "No specialty structure is available for report generation");
  }

  const rag = await runtime.callTool(
    state,
    "rag_search",
    {
      structure: state.structure,
      missing_evidence: state.missing_evidence,
    },
    WHITELISTED_ASSESSMENT_TOOLS.rag_search,
  );
  const ragConflicts = detectRagCitationConflicts({
    case_id: state.case_id,
    structure: state.structure,
    citations: rag.citations,
    created_at: runtime.now(),
  });
  runtime.repository.saveClinicalConflicts(ragConflicts);
  const excludedCitationIds = new Set(
    ragConflicts.flatMap((conflict) => conflict.right_evidence_ids),
  );
  const safeRag = {
    ...rag,
    citations: rag.citations.filter(
      (citation) => !excludedCitationIds.has(citation.citation_id),
    ),
  };
  if (ragConflicts.length > 0) {
    appendRunEvent(runtime.repository, state, "assessment.rag.conflict_checked", {
      conflict_ids: ragConflicts.map((conflict) => conflict.conflict_id),
      excluded_citation_ids: [...excludedCitationIds],
    });
  }
  const sensitivity = await runtime.callTool(
    state,
    "sensitivity_assessor",
    state.structure,
    (structure) =>
      WHITELISTED_ASSESSMENT_TOOLS.sensitivity_assessor(
        structure,
        safeRag.citations,
      ),
  );
  const tolerance = await runtime.callTool(
    state,
    "tolerance_assessor",
    state.structure,
    (structure) =>
      WHITELISTED_ASSESSMENT_TOOLS.tolerance_assessor(
        structure,
        state.tool_outputs.lab_checker ?? {
          missing: [],
          available: [],
          abnormal_clues: [],
        },
      ),
  );
  const reportInput: AssessmentReportGeneratorInput = {
    run_id: state.run_id,
    structure: state.structure,
    source_texts: state.source_texts,
    missing_evidence: state.missing_evidence,
    tnm: state.tool_outputs.tnm_mapper ?? {
      t_stage: "cTx",
      n_stage: "cNx",
      m_stage: "cMx",
      stage_clues: [],
      missing_for_staging: [],
    },
    citations: safeRag.citations,
    sensitivity,
    tolerance,
    contradictions:
      state.tool_outputs.contradiction_checker?.contradictions ?? [],
    pending_clarification: state.pending_clarification,
    knowledge_version: safeRag.version,
    created_at: runtime.now(),
  };
  const generated = await runtime.callTool(
    state,
    "report_generator",
    reportInput,
    WHITELISTED_ASSESSMENT_TOOLS.report_generator,
  );
  const validation = await runtime.callTool(
    state,
    "output_schema_validator",
    {
      report: generated.report_json,
      report_markdown: generated.report_markdown,
      source_texts: state.source_texts,
      structure: state.structure,
    },
    WHITELISTED_ASSESSMENT_TOOLS.output_schema_validator,
  );

  return {
    ...state,
    report: generated.report_json,
    report_markdown: generated.report_markdown,
    knowledge_version: safeRag.version,
    tool_outputs: {
      ...state.tool_outputs,
      rag_search: safeRag,
      sensitivity_assessor: sensitivity,
      tolerance_assessor: tolerance,
      report_generator: generated,
      output_schema_validator: validation,
    },
  };
}

async function callWhitelistedTool<Input, Output>(
  repository: MedicalRepository,
  state: AssessmentRunState,
  toolName: WhitelistedToolName,
  input: Input,
  tool: (input: Input) => Output | Promise<Output>,
): Promise<Output> {
  appendRunEvent(repository, state, "assessment.tool.called", {
    tool: toolName,
    input: summarizeToolInput(input),
  });

  try {
    const output = await tool(input);

    appendRunEvent(repository, state, "assessment.tool.completed", {
      tool: toolName,
      output: summarizeToolOutput(output),
    });

    return output;
  } catch (error) {
    appendRunEvent(repository, state, "assessment.tool.failed", {
      tool: toolName,
      error: errorToMessage(error),
    });
    throw error;
  }
}

function ensureClarificationRequest(
  state: AssessmentRunState,
  runtime: AssessmentGraphRuntime,
  blockingMissing: MissingEvidenceItem[],
): { request: ClarificationRequest; created: boolean } {
  const blockingCodes = blockingMissing.map((item) => item.code).sort();
  const requestId = `clarification-${createHash("sha256")
    .update(`${state.run_id}:${blockingCodes.join(",")}`)
    .digest("hex")
    .slice(0, 32)}`;
  const existing = runtime.repository.getClarificationRequest(requestId);
  if (existing) {
    return {
      request: {
        request_id: existing.request_id,
        reason: existing.reason,
        questions: existing.questions,
      },
      created: false,
    };
  }
  const request = {
    request_id: requestId,
    case_id: state.case_id,
    run_id: state.run_id,
    reason: blockingMissing.map((item) => item.label).join("、"),
    questions: blockingMissing.slice(0, 5).map(toClarificationQuestion),
    created_at: runtime.now(),
  };

  const saved = runtime.repository.saveClarificationRequest(request);
  return {
    request: {
      request_id: saved.request_id,
      reason: saved.reason,
      questions: saved.questions,
    },
    created: true,
  };
}

function toClarificationQuestion(
  item: MissingEvidenceItem,
  index: number,
): ClarificationQuestion {
  return {
    id: `${item.code}:${index + 1}`,
    priority: item.severity === "blocking" ? "high" : "medium",
    question: item.question,
    expected_answer_type: item.code.startsWith("pathology.")
      ? "report_upload"
      : "free_text",
    clinical_purpose: item.clinical_purpose,
    blocks_conclusion: item.severity === "blocking",
  };
}

function loadStructure(
  repository: MedicalRepository,
  params: RunAssessmentGraphParams,
): SpecialtyStructure | undefined {
  return params.structure_id
    ? (repository.getSpecialtyStructure(params.structure_id) ?? undefined)
    : (repository.getLatestSpecialtyStructure(params.case_id) ?? undefined);
}

function loadSourceTexts(
  repository: MedicalRepository,
  caseId: string,
): string[] {
  return repository
    .listCaseInputs(caseId)
    .map((input) => repository.readCaseInputRawText(input.input_id))
    .filter((text): text is string => text !== null && text.trim().length > 0);
}

function failState(
  state: AssessmentRunState,
  error: string,
): AssessmentRunState {
  return {
    ...state,
    status: "failed",
    next: "failed",
    errors: [...state.errors, error],
  };
}

function missingEvidenceItem(input: {
  code: string;
  label: string;
  question: string;
  clinical_purpose: string;
}): MissingEvidenceItem {
  return {
    ...input,
    severity: "recommended",
  };
}

function dedupeMissingEvidence(
  items: MissingEvidenceItem[],
): MissingEvidenceItem[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.code)) {
      return false;
    }
    seen.add(item.code);
    return true;
  });
}

function normalizeCode(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9]+/g, "_") || "item";
}

function isNodeName(next: AssessmentGraphNext): next is AssessmentNodeName {
  return [
    "intake_validation",
    "pathology_gate",
    "missing_evidence_check",
    "conflict_check",
    "clarification_gate",
  ].includes(next);
}

function appendRunEvent(
  repository: MedicalRepository,
  state: AssessmentRunState,
  eventType: string,
  payload: unknown,
  message?: string,
): void {
  repository.appendRunEvent({
    run_id: state.run_id,
    event_type: eventType,
    message,
    payload: toJsonValue(payload),
  });
}

function summarizeToolInput(input: unknown): JsonValue {
  if (isSpecialtyStructure(input)) {
    return {
      case_id: input.case_id,
      structure_id: input.structure_id,
      cancer_site: input.cancer_site,
      pathology_status: input.pathology.status,
    };
  }

  return toJsonValue(input);
}

function summarizeToolOutput(output: unknown): JsonValue {
  if (Array.isArray(output)) {
    return {
      kind: "array",
      count: output.length,
    };
  }

  if (isObject(output) && "report_json" in output) {
    const report = output.report_json;

    return isObject(report)
      ? {
          report_status: toJsonValue(report.assessment_status),
          case_id: toJsonValue(report.case_id),
        }
      : { kind: "report" };
  }

  if (isObject(output) && "citations" in output) {
    const citations = output.citations;

    return {
      kind: "knowledge_search",
      citation_count: Array.isArray(citations) ? citations.length : 0,
      version: toJsonValue(output.version),
    };
  }

  return toJsonValue(output);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }

  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isSpecialtyStructure(value: unknown): value is SpecialtyStructure {
  return isObject(value) && "structure_id" in value && "pathology" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAssessmentGraphWithRepository(
  params: RunAssessmentGraphParams,
): Promise<RunAssessmentGraphResult> {
  return runAssessmentGraph(params);
}
