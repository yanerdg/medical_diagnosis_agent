import {
  detectRedFlags,
  evaluatePathologyRules,
  evaluateClaimEvidenceRules,
  evaluateRedFlagRules,
  evaluateSafetyRules,
  evaluateToleranceRules,
  type RuleIssue,
} from "@/domain/rules";
import {
  assessmentReportJsonSchema,
  DEFAULT_MEDICAL_DISCLAIMER,
  type AssessmentReportJson,
  type ClarificationRequest,
  type SensitivityAssessmentItem,
  type SpecialtyStructure,
  type ToleranceAssessmentItem,
} from "@/domain/schemas";
import {
  buildKnowledgeEvidenceId,
  knowledgeCitationToEvidenceModel,
  searchKnowledgeBase,
} from "@/server/kb/search";
import type {
  ContradictionCheckResult,
  LabCheckResult,
  MissingEvidenceItem,
  OutputValidationResult,
  ParsedCaseFacts,
  TnmMappingResult,
} from "./types";

export interface RagSearchInput {
  structure: SpecialtyStructure;
  missing_evidence: MissingEvidenceItem[];
}

export interface AssessmentReportGeneratorInput {
  run_id: string;
  structure: SpecialtyStructure;
  source_texts: string[];
  missing_evidence: MissingEvidenceItem[];
  tnm: TnmMappingResult;
  citations: Awaited<ReturnType<typeof searchKnowledgeBase>>["citations"];
  sensitivity: SensitivityAssessmentItem[];
  tolerance: ToleranceAssessmentItem[];
  contradictions: RuleIssue[];
  pending_clarification?: ClarificationRequest;
  knowledge_version: string;
  model_version?: string;
  created_at?: string;
}

export interface OutputSchemaValidatorInput {
  report: AssessmentReportJson;
  report_markdown: string;
  source_texts: string[];
  structure: SpecialtyStructure;
}

export const WHITELISTED_ASSESSMENT_TOOLS = {
  parser: parseSpecialtyStructure,
  lab_checker: checkLabs,
  tnm_mapper: mapTnm,
  rag_search: searchAssessmentKnowledge,
  sensitivity_assessor: assessSensitivity,
  tolerance_assessor: assessTolerance,
  contradiction_checker: checkContradictions,
  report_generator: generateAssessmentReport,
  output_schema_validator: validateAssessmentOutput,
} as const;

export function parseSpecialtyStructure(
  structure: SpecialtyStructure,
): ParsedCaseFacts {
  return {
    case_id: structure.case_id,
    cancer_site: structure.cancer_site,
    pathology_status: structure.pathology.status,
    pathology_type: structure.pathology.pathology_type ?? "unknown",
    biomarkers: structure.biomarkers,
    primary_site: structure.ct.primary_site,
    stage_clues: unique([
      ...structure.ct.invasion_clues,
      ...structure.ct.lymph_node_clues,
      ...structure.ct.distant_metastasis_clues,
    ]),
    evidence_ids: structure.evidence_ids,
  };
}

export function checkLabs(structure: SpecialtyStructure): LabCheckResult {
  const available: string[] = [];
  const missing: string[] = [];

  if (structure.labs.ecog === undefined) {
    missing.push("ECOG");
  } else {
    available.push("ECOG");
  }

  addAvailability(available, missing, "血常规", structure.labs.blood_routine_available);
  addAvailability(available, missing, "肝功能", structure.labs.liver_function_available);
  addAvailability(available, missing, "肾功能", structure.labs.kidney_function_available);
  addAvailability(available, missing, "白蛋白", structure.labs.albumin_available);

  return {
    missing,
    available,
    abnormal_clues: [...structure.labs.abnormal_clues],
  };
}

export function mapTnm(structure: SpecialtyStructure): TnmMappingResult {
  const invasionText = structure.ct.invasion_clues.join("；");
  const lymphNodeText = structure.ct.lymph_node_clues.join("；");
  const metastasisText = structure.ct.distant_metastasis_clues.join("；");
  const hasPrimarySite =
    structure.ct.primary_site !== undefined || invasionText.length > 0;
  const tStage =
    hasPrimarySite && /甲状软骨|环状软骨|喉外|皮肤|食管|气管|侵犯/.test(invasionText)
      ? "cT4_or_above"
      : hasPrimarySite
        ? "cT_present"
        : "cTx";
  const nStage =
    lymphNodeText.length === 0
      ? "cNx"
      : /未见|无|阴性/.test(lymphNodeText)
        ? "cN0"
        : "cN_positive";
  const mStage =
    metastasisText.length === 0
      ? "cMx"
      : /未见|无|阴性/.test(metastasisText)
        ? "cM0"
        : "cM1_suspected";
  const missingForStaging = [
    ...(tStage === "cTx" ? ["原发灶范围"] : []),
    ...(nStage === "cNx" ? ["颈部淋巴结评估"] : []),
    ...(mStage === "cMx" ? ["远处转移评估"] : []),
  ];

  return {
    t_stage: tStage,
    n_stage: nStage,
    m_stage: mStage,
    stage_clues: unique([
      structure.ct.primary_site,
      ...structure.ct.invasion_clues,
      ...structure.ct.lymph_node_clues,
      ...structure.ct.distant_metastasis_clues,
    ]),
    missing_for_staging: missingForStaging,
  };
}

export async function searchAssessmentKnowledge(
  input: RagSearchInput,
): Promise<Awaited<ReturnType<typeof searchKnowledgeBase>>> {
  const query = [
    input.structure.cancer_site,
    input.structure.pathology.pathology_type,
    ...input.missing_evidence.map((item) => item.label),
    "敏感性 耐受性 分期",
  ]
    .filter(Boolean)
    .join(" ");

  return searchKnowledgeBase({
    query,
    cancerSite: input.structure.cancer_site,
    tags: ["sensitivity", "tolerance", "staging"],
    limit: 5,
  });
}

export function assessSensitivity(
  structure: SpecialtyStructure,
  citations: Awaited<ReturnType<typeof searchKnowledgeBase>>["citations"],
): SensitivityAssessmentItem[] {
  const hasConfirmedPathology = structure.pathology.status === "confirmed";
  const hasKnowledgeSupport = citations.length > 0;
  const citationIds = citations.map((citation) => citation.citation_id);
  const knowledgeEvidenceIds = citations.map((citation) =>
    buildKnowledgeEvidenceId(
      structure.case_id,
      "sensitivity_assessment",
      citation.citation_id,
    ),
  );
  const pathologyMissing = hasConfirmedPathology ? [] : ["病理确认"];

  return [
    {
      modality: "radiotherapy",
      level: hasConfirmedPathology && hasKnowledgeSupport ? "possible_sensitive" : "uncertain",
      supporting_evidence: hasConfirmedPathology && hasKnowledgeSupport
        ? compact([structure.pathology.pathology_type, structure.ct.primary_site])
        : [],
      contradicting_evidence: [],
      missing_information: unique([
        ...pathologyMissing,
        ...(hasKnowledgeSupport ? [] : ["已审核外部知识引用"]),
      ]),
      citations: citationIds,
      evidence_ids: knowledgeEvidenceIds,
    },
    {
      modality: "platinum_chemo",
      level: hasConfirmedPathology && hasKnowledgeSupport ? "possible_sensitive" : "uncertain",
      supporting_evidence: hasConfirmedPathology && hasKnowledgeSupport
        ? compact([structure.pathology.pathology_type])
        : [],
      contradicting_evidence: [],
      missing_information: unique([
        ...pathologyMissing,
        ...(hasKnowledgeSupport ? [] : ["已审核外部知识引用"]),
        ...missingBiomarkers(structure, ["PD-L1", "p16", "EBV"]),
      ]),
      citations: citationIds,
      evidence_ids: knowledgeEvidenceIds,
    },
    {
      modality: "immunotherapy",
      level: hasConfirmedPathology ? "uncertain" : "uncertain",
      supporting_evidence: biomarkerEvidence(structure, ["PD-L1", "MSI", "TMB"]),
      contradicting_evidence: [],
      missing_information: unique([
        ...pathologyMissing,
        ...(hasKnowledgeSupport ? [] : ["已审核外部知识引用"]),
        ...missingBiomarkers(structure, ["PD-L1", "MSI", "TMB"]),
      ]),
      citations: citationIds,
      evidence_ids: knowledgeEvidenceIds,
    },
    {
      modality: "targeted_therapy",
      level: "uncertain",
      supporting_evidence: biomarkerEvidence(structure, ["EGFR", "NTRK"]),
      contradicting_evidence: [],
      missing_information: unique([
        ...pathologyMissing,
        ...(hasKnowledgeSupport ? [] : ["已审核外部知识引用"]),
        ...missingBiomarkers(structure, ["EGFR", "NTRK"]),
      ]),
      citations: citationIds,
      evidence_ids: knowledgeEvidenceIds,
    },
  ];
}

export function assessTolerance(
  structure: SpecialtyStructure,
  labCheck: LabCheckResult,
): ToleranceAssessmentItem[] {
  return [
    buildToleranceItem("radiotherapy", structure, labCheck),
    buildToleranceItem("chemotherapy", structure, labCheck),
    buildToleranceItem("immunotherapy", structure, labCheck),
    buildToleranceItem("surgery_anesthesia", structure, labCheck),
  ];
}

export function checkContradictions(
  structure: SpecialtyStructure,
): ContradictionCheckResult {
  const contradictions: RuleIssue[] = [];
  const primarySite = structure.ct.primary_site ?? "";
  const pathologyType = structure.pathology.pathology_type ?? "";

  if (
    structure.cancer_site === "larynx" &&
    /鼻咽|nasophary/i.test(`${primarySite}\n${pathologyType}`)
  ) {
    contradictions.push({
      code: "contradiction.site_larynx_vs_nasopharynx",
      severity: "warning",
      path: "cancer_site",
      message: "结构化癌种为喉癌，但 CT 或病理文本提示鼻咽来源。",
      evidence: compact([primarySite, pathologyType]).join("；"),
    });
  }

  if (
    structure.pathology.status === "not_available" &&
    pathologyType !== "unknown" &&
    pathologyType.trim().length > 0
  ) {
    contradictions.push({
      code: "contradiction.pathology_type_without_status",
      severity: "warning",
      path: "pathology",
      message: "病理状态为未提供，但存在病理类型文本，需要医生复核。",
      evidence: pathologyType,
    });
  }

  return { contradictions };
}

export function generateAssessmentReport(
  input: AssessmentReportGeneratorInput,
): {
  report_json: AssessmentReportJson;
  report_markdown: string;
} {
  const redFlags = detectRedFlags(input.source_texts).map(
    (flag) => `${flag.category}: ${flag.matched_text}`,
  );
  const isPaused = input.pending_clarification !== undefined;
  const blockingMissing = input.missing_evidence.filter(
    (item) => item.severity === "blocking",
  );
  const knowledgeEvidence = input.citations.map((citation) =>
    knowledgeCitationToEvidenceModel({
      caseId: input.structure.case_id,
      field: "sensitivity_assessment",
      citation,
      createdAt: input.created_at,
    }),
  );
  const recommendedMissing = unique([
    ...input.missing_evidence.map((item) => item.label),
    ...input.tnm.missing_for_staging,
  ]);
  const reportJson = assessmentReportJsonSchema.parse({
    case_id: input.structure.case_id,
    in_scope: input.structure.cancer_site !== "unknown",
    assessment_status: isPaused ? "paused_for_clinician_input" : "completed",
    summary: buildSummary(input.structure, blockingMissing, input.contradictions),
    pending_clarification: input.pending_clarification ?? null,
    diagnostic_evidence: {
      cancer_site: input.structure.cancer_site,
      pathology_status: input.structure.pathology.status,
      pathology_type: input.structure.pathology.pathology_type ?? "unknown",
      stage_clues: input.tnm.stage_clues,
      missing_for_staging: input.tnm.missing_for_staging,
    },
    sensitivity_assessment: input.sensitivity,
    tolerance_assessment: input.tolerance,
    red_flags: redFlags,
    recommended_missing_tests: recommendedMissing,
    evidence: knowledgeEvidence,
    overall_confidence: inferOverallConfidence(
      input.structure,
      blockingMissing,
      input.contradictions,
    ),
    knowledge_version: input.knowledge_version,
    model_version: input.model_version ?? "mvp-rule-graph-v0.1",
    review_required: true,
    disclaimer: DEFAULT_MEDICAL_DISCLAIMER,
  });

  return {
    report_json: reportJson,
    report_markdown: renderReportMarkdown(reportJson),
  };
}

export function validateAssessmentOutput(
  input: OutputSchemaValidatorInput,
): OutputValidationResult {
  const parsed = assessmentReportJsonSchema.safeParse(input.report);
  const schemaErrors = parsed.success
    ? []
    : parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "<root>"}: ${issue.message}`,
      );
  const redFlagResult = parsed.success
    ? evaluateRedFlagRules(parsed.data, input.source_texts)
    : { issues: [], red_flags: [] };
  const verifierIssues = parsed.success
    ? [
        ...evaluatePathologyRules(parsed.data),
        ...evaluateClaimEvidenceRules(parsed.data),
        ...evaluateToleranceRules(parsed.data, input.structure.labs),
        ...redFlagResult.issues,
      ]
    : [];
  const safetyIssues = parsed.success
    ? evaluateSafetyRules(input.report_markdown)
    : [];
  const hasVerifierError = verifierIssues.some(
    (issue) => issue.severity === "error",
  );
  const hasSafetyError = safetyIssues.some((issue) => issue.severity === "error");

  return {
    valid: parsed.success && !hasVerifierError && !hasSafetyError,
    schema_errors: schemaErrors,
    verifier_issues: verifierIssues,
    safety_issues: safetyIssues,
    red_flags: redFlagResult.red_flags,
  };
}

function addAvailability(
  available: string[],
  missing: string[],
  label: string,
  isAvailable: boolean,
): void {
  if (isAvailable) {
    available.push(label);
  } else {
    missing.push(label);
  }
}

function buildToleranceItem(
  modality: ToleranceAssessmentItem["modality"],
  structure: SpecialtyStructure,
  labCheck: LabCheckResult,
): ToleranceAssessmentItem {
  const factor = structure.tolerance_factors.find(
    (item) => item.modality === modality,
  );
  const missingInformation = unique([
    ...labCheck.missing,
    ...(factor?.missing_information ?? []),
  ]);
  const riskFactors = unique([
    ...labCheck.abnormal_clues,
    ...(factor?.risk_factors ?? []),
  ]);

  return {
    modality,
    level: inferToleranceLevel(structure, missingInformation, riskFactors),
    risk_factors: riskFactors,
    protective_factors:
      missingInformation.length === 0 && riskFactors.length === 0
        ? ["关键实验室与 ECOG 信息较完整"]
        : [],
    missing_information: missingInformation,
  };
}

function inferToleranceLevel(
  structure: SpecialtyStructure,
  missingInformation: string[],
  riskFactors: string[],
): ToleranceAssessmentItem["level"] {
  if (missingInformation.length > 0) {
    return "unknown";
  }

  if ((structure.labs.ecog ?? 5) >= 3 || riskFactors.length >= 2) {
    return "poor";
  }

  if ((structure.labs.ecog ?? 5) === 2 || riskFactors.length === 1) {
    return "caution";
  }

  return "good";
}

function inferOverallConfidence(
  structure: SpecialtyStructure,
  blockingMissing: MissingEvidenceItem[],
  contradictions: RuleIssue[],
): AssessmentReportJson["overall_confidence"] {
  if (blockingMissing.length > 0 || structure.pathology.status !== "confirmed") {
    return "low";
  }

  if (contradictions.length > 0) {
    return "medium";
  }

  return "high";
}

function buildSummary(
  structure: SpecialtyStructure,
  blockingMissing: MissingEvidenceItem[],
  contradictions: RuleIssue[],
): string {
  if (blockingMissing.length > 0) {
    return `当前评估已暂停，需补充${blockingMissing
      .map((item) => item.label)
      .join("、")}后再生成结论。`;
  }

  const pathologyText =
    structure.pathology.status === "confirmed"
      ? `已有病理信息：${structure.pathology.pathology_type ?? "未标注类型"}`
      : "尚无病理确认";
  const contradictionText =
    contradictions.length > 0 ? "；存在需复核的不一致证据" : "";

  return `${pathologyText}，本报告仅给出辅助评估线索${contradictionText}。`;
}

function renderReportMarkdown(report: AssessmentReportJson): string {
  return [
    `# 辅助评估报告`,
    ``,
    `状态：${report.assessment_status}`,
    ``,
    `## 摘要`,
    report.summary,
    ``,
    `## 待补充信息`,
    report.recommended_missing_tests.length > 0
      ? report.recommended_missing_tests.map((item) => `- ${item}`).join("\n")
      : "无",
    ``,
    `## 红旗风险`,
    report.red_flags.length > 0
      ? report.red_flags.map((item) => `- ${item}`).join("\n")
      : "无",
    ``,
    `## 免责声明`,
    report.disclaimer,
  ].join("\n");
}

function missingBiomarkers(
  structure: SpecialtyStructure,
  names: string[],
): string[] {
  const existingKeys = Object.keys(structure.biomarkers).map((key) =>
    key.toLocaleLowerCase("zh-CN"),
  );

  return names.filter(
    (name) => !existingKeys.includes(name.toLocaleLowerCase("zh-CN")),
  );
}

function biomarkerEvidence(
  structure: SpecialtyStructure,
  names: string[],
): string[] {
  const entries = Object.entries(structure.biomarkers);

  return entries
    .filter(([key]) =>
      names.some(
        (name) =>
          key.toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"),
      ),
    )
    .map(([key, value]) => `${key}: ${value}`);
}

function unique<T>(values: Array<T | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))];
}

function compact(values: Array<string | undefined>): string[] {
  return values.filter(
    (value): value is string => value !== undefined && value.trim().length > 0,
  );
}
