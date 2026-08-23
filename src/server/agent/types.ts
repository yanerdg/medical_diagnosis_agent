import type {
  AssessmentReportJson,
  AssessmentRunStatus,
  ClarificationRequest,
  SpecialtyStructure,
} from "@/domain/schemas";
import type { RuleIssue, DetectedRedFlag } from "@/domain/rules";
import type { KnowledgeCitation } from "@/server/kb/search";
import type { ContextBundle } from "@/server/context";

// Includes deterministic gates plus ReAct plan/act/observe/decide nodes.
export const MAX_AGENT_LOOP_COUNT = 16;
export const MAX_REACT_TURN_COUNT = 6;

export type PlannedAction = "rag_search" | "generate_draft" | "finish";

export type AssessmentNodeName =
  | "intake_validation"
  | "pathology_gate"
  | "missing_evidence_check"
  | "conflict_check"
  | "clarification_gate"
  | "react_plan"
  | "react_act"
  | "react_observe"
  | "react_decide";

export type AssessmentGraphTerminal = "completed" | "paused" | "failed";

export type AssessmentGraphNext = AssessmentNodeName | AssessmentGraphTerminal;

export type WhitelistedToolName =
  | "parser"
  | "lab_checker"
  | "tnm_mapper"
  | "rag_search"
  | "sensitivity_assessor"
  | "tolerance_assessor"
  | "contradiction_checker"
  | "report_generator"
  | "output_schema_validator";

export interface MissingEvidenceItem {
  code: string;
  label: string;
  severity: "blocking" | "recommended";
  question: string;
  clinical_purpose: string;
}

export interface ParsedCaseFacts {
  case_id: string;
  cancer_site: SpecialtyStructure["cancer_site"];
  pathology_status: SpecialtyStructure["pathology"]["status"];
  pathology_type: string;
  biomarkers: Record<string, string>;
  primary_site?: string;
  stage_clues: string[];
  evidence_ids: string[];
}

export interface LabCheckResult {
  missing: string[];
  available: string[];
  abnormal_clues: string[];
}

export interface TnmMappingResult {
  t_stage: string;
  n_stage: string;
  m_stage: string;
  stage_clues: string[];
  missing_for_staging: string[];
}

export interface ContradictionCheckResult {
  contradictions: RuleIssue[];
}

export interface OutputValidationResult {
  valid: boolean;
  schema_errors: string[];
  verifier_issues: RuleIssue[];
  safety_issues: RuleIssue[];
  red_flags: DetectedRedFlag[];
}

export interface AssessmentToolOutputs {
  parser?: ParsedCaseFacts;
  lab_checker?: LabCheckResult;
  tnm_mapper?: TnmMappingResult;
  rag_search?: {
    version: string;
    citations: KnowledgeCitation[];
  };
  sensitivity_assessor?: AssessmentReportJson["sensitivity_assessment"];
  tolerance_assessor?: AssessmentReportJson["tolerance_assessment"];
  contradiction_checker?: ContradictionCheckResult;
  report_generator?: {
    report_json: AssessmentReportJson;
    report_markdown: string;
  };
  output_schema_validator?: OutputValidationResult;
}

export interface AssessmentRunState {
  run_id: string;
  case_id: string;
  structure_id?: string;
  status: AssessmentRunStatus;
  loop_count: number;
  max_loop_count: number;
  react_turn_count: number;
  planned_action?: PlannedAction;
  current_node?: AssessmentNodeName;
  next: AssessmentGraphNext;
  structure?: SpecialtyStructure;
  source_texts: string[];
  missing_evidence: MissingEvidenceItem[];
  acknowledged_missing_evidence_codes: string[];
  pending_clarification?: ClarificationRequest;
  report?: AssessmentReportJson;
  report_markdown?: string;
  knowledge_version?: string;
  context_bundle?: ContextBundle;
  errors: string[];
  tool_outputs: AssessmentToolOutputs;
}

export interface AssessmentGraphNode {
  name: AssessmentNodeName;
  invoke: (state: AssessmentRunState) => Promise<AssessmentRunState>;
}

export interface AssessmentGraphDefinition {
  max_loop_count: number;
  entrypoint: AssessmentNodeName;
  nodes: Record<AssessmentNodeName, AssessmentGraphNode>;
}
