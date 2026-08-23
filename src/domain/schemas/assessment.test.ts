import { describe, expect, it } from "vitest";
import {
  assessmentReportJsonSchema,
  DEFAULT_MEDICAL_DISCLAIMER,
  overallConfidenceSchema,
  pathologyStatusSchema,
  sensitivityLevelSchema,
  toleranceLevelSchema,
} from ".";

const validClarification = {
  request_id: "clarification-1",
  reason: "缺少病理证据会影响是否能输出最终评估。",
  questions: [
    {
      id: "question-1",
      priority: "high",
      question: "是否已有病理或细胞学结果？",
      expected_answer_type: "report_upload",
      clinical_purpose: "用于判断病理确认状态。",
      blocks_conclusion: true,
    },
  ],
};

const knowledgeEvidence = {
  evidence_id: "kb-evidence-case-1-radiotherapy",
  case_id: "case-1",
  source_type: "knowledge_base",
  source_ref: "kb-v0.1:lxxx",
  field: "sensitivity_assessment",
  value: {
    citation_id: "kb-v0.1:lxxx",
  },
  quote: "本地知识库引用片段。",
  confidence: 0.8,
  extracted_by: "knowledge_base",
  created_at: "2026-07-09T00:00:00.000Z",
};

function buildCompletedReport() {
  return {
    case_id: "case-1",
    in_scope: true,
    assessment_status: "completed",
    summary: "喉癌疑似病例，已有病理和 CT 文字证据。",
    pending_clarification: null,
    diagnostic_evidence: {
      cancer_site: "larynx",
      pathology_status: "confirmed",
      pathology_type: "鳞状细胞癌",
      stage_clues: ["CT 提示声门区占位"],
      missing_for_staging: ["正式 TNM 分期"],
    },
    sensitivity_assessment: [
      {
        modality: "radiotherapy",
        level: "possible_sensitive",
        supporting_evidence: ["鳞癌病理类型"],
        contradicting_evidence: [],
        missing_information: ["既往放疗史"],
        citations: ["kb-v0.1:lxxx"],
        evidence_ids: ["kb-evidence-case-1-radiotherapy"],
      },
    ],
    tolerance_assessment: [
      {
        modality: "chemotherapy",
        level: "unknown",
        risk_factors: [],
        protective_factors: [],
        missing_information: ["血常规", "肝肾功能", "ECOG"],
      },
    ],
    red_flags: [],
    recommended_missing_tests: ["补充 ECOG、血常规、肝肾功能和白蛋白"],
    evidence: [knowledgeEvidence],
    overall_confidence: "medium",
    knowledge_version: "kb-v0.1",
    model_version: "model-v0.1",
    review_required: true,
    disclaimer: DEFAULT_MEDICAL_DISCLAIMER,
  };
}

describe("assessmentReportJsonSchema", () => {
  it("accepts the standard completed report JSON fields", () => {
    const result = assessmentReportJsonSchema.safeParse(buildCompletedReport());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.review_required).toBe(true);
      expect(result.data.disclaimer).toBe(DEFAULT_MEDICAL_DISCLAIMER);
    }
  });

  it("requires fixed review and disclaimer fields", () => {
    expect(
      assessmentReportJsonSchema.safeParse({
        ...buildCompletedReport(),
        review_required: false,
      }).success,
    ).toBe(false);

    expect(
      assessmentReportJsonSchema.safeParse({
        ...buildCompletedReport(),
        disclaimer: "仅供参考。",
      }).success,
    ).toBe(false);
  });

  it("requires pending clarification only for paused reports", () => {
    expect(
      assessmentReportJsonSchema.safeParse({
        ...buildCompletedReport(),
        assessment_status: "paused_for_clinician_input",
        pending_clarification: validClarification,
      }).success,
    ).toBe(true);

    expect(
      assessmentReportJsonSchema.safeParse({
        ...buildCompletedReport(),
        assessment_status: "paused_for_clinician_input",
        pending_clarification: null,
      }).success,
    ).toBe(false);

    expect(
      assessmentReportJsonSchema.safeParse({
        ...buildCompletedReport(),
        pending_clarification: validClarification,
      }).success,
    ).toBe(false);
  });
});

describe("level enums", () => {
  it("accepts only the AGENT.md assessment levels", () => {
    expect(sensitivityLevelSchema.safeParse("likely_sensitive").success).toBe(true);
    expect(sensitivityLevelSchema.safeParse("highly_sensitive").success).toBe(false);

    expect(toleranceLevelSchema.safeParse("good").success).toBe(true);
    expect(toleranceLevelSchema.safeParse("excellent").success).toBe(false);

    expect(overallConfidenceSchema.safeParse("high").success).toBe(true);
    expect(overallConfidenceSchema.safeParse("certain").success).toBe(false);

    expect(pathologyStatusSchema.safeParse("not_available").success).toBe(true);
    expect(pathologyStatusSchema.safeParse("diagnosed").success).toBe(false);
  });
});
