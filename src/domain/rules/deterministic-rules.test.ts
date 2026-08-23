import { describe, expect, it } from "vitest";
import { DEFAULT_MEDICAL_DISCLAIMER } from "../schemas";
import type { AssessmentReportJson, LabSummary } from "../schemas";
import {
  detectRedFlags,
  evaluatePathologyRules,
  evaluateSafetyRules,
  evaluateToleranceRules,
  runDeterministicSafetyGate,
} from "./deterministic-rules";

function buildReport(
  overrides: Partial<AssessmentReportJson> = {},
): AssessmentReportJson {
  const knowledgeEvidence = {
    evidence_id: "kb-evidence-case-1-lxxx",
    case_id: "case-1",
    source_type: "knowledge_base" as const,
    source_ref: "kb-v0.1:lxxx",
    field: "sensitivity_assessment",
    value: {
      citation_id: "kb-v0.1:lxxx",
    },
    quote: "本地知识库引用片段。",
    confidence: 0.8,
    extracted_by: "knowledge_base" as const,
    created_at: "2026-07-09T00:00:00.000Z",
  };

  return {
    case_id: "case-1",
    in_scope: true,
    assessment_status: "completed",
    summary: "喉癌疑似病例，等待医生复核。",
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
        missing_information: [],
        citations: ["kb-v0.1:lxxx"],
        evidence_ids: ["kb-evidence-case-1-lxxx"],
      },
    ],
    tolerance_assessment: [
      {
        modality: "chemotherapy",
        level: "caution",
        risk_factors: [],
        protective_factors: [],
        missing_information: [],
      },
    ],
    red_flags: [],
    recommended_missing_tests: [],
    evidence: [knowledgeEvidence],
    overall_confidence: "medium",
    knowledge_version: "kb-v0.1",
    model_version: "model-v0.1",
    review_required: true,
    disclaimer: DEFAULT_MEDICAL_DISCLAIMER,
    ...overrides,
  };
}

function buildLabs(overrides: Partial<LabSummary> = {}): LabSummary {
  return {
    ecog: 1,
    blood_routine_available: true,
    liver_function_available: true,
    kidney_function_available: true,
    albumin_available: true,
    abnormal_clues: [],
    evidence_ids: ["evidence-lab-1"],
    ...overrides,
  };
}

describe("evaluatePathologyRules", () => {
  it("blocks confirmed diagnosis wording and likely sensitivity without pathology", () => {
    const report = buildReport({
      summary: "患者已确诊喉癌，建议进入治疗评估。",
      diagnostic_evidence: {
        cancer_site: "larynx",
        pathology_status: "not_available",
        pathology_type: "",
        stage_clues: ["CT 提示声门区占位"],
        missing_for_staging: ["病理"],
      },
      sensitivity_assessment: [
        {
          modality: "radiotherapy",
          level: "likely_sensitive",
          supporting_evidence: ["影像疑似局部病变"],
          contradicting_evidence: [],
          missing_information: ["病理"],
          citations: [],
          evidence_ids: [],
        },
      ],
    });

    const issueCodes = evaluatePathologyRules(report).map((issue) => issue.code);

    expect(issueCodes).toContain(
      "pathology.no_confirmed_text_without_pathology",
    );
    expect(issueCodes).toContain(
      "pathology.no_likely_sensitive_without_pathology",
    );
  });

  it("blocks confirmed pathology status when pathology detail is absent", () => {
    const issueCodes = evaluatePathologyRules(
      buildReport({
        diagnostic_evidence: {
          cancer_site: "larynx",
          pathology_status: "confirmed",
          pathology_type: "未提供",
          stage_clues: [],
          missing_for_staging: ["病理报告"],
        },
      }),
    ).map((issue) => issue.code);

    expect(issueCodes).toContain("pathology.confirmed_requires_pathology");
  });
});

describe("evaluateToleranceRules", () => {
  it("blocks good tolerance when key lab and ECOG inputs are missing", () => {
    const report = buildReport({
      tolerance_assessment: [
        {
          modality: "chemotherapy",
          level: "good",
          risk_factors: [],
          protective_factors: [],
          missing_information: [],
        },
      ],
    });
    const labs = buildLabs({
      ecog: undefined,
      blood_routine_available: false,
      liver_function_available: false,
      kidney_function_available: false,
      albumin_available: false,
    });

    const issues = evaluateToleranceRules(report, labs);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "tolerance.no_good_with_missing_key_inputs",
      path: "tolerance_assessment.0.level",
    });
    expect(issues[0].evidence).toContain("ECOG");
    expect(issues[0].evidence).toContain("血常规");
    expect(issues[0].evidence).toContain("肝功能");
    expect(issues[0].evidence).toContain("肾功能");
    expect(issues[0].evidence).toContain("白蛋白");
  });

  it("blocks good tolerance when report itself carries missing key inputs", () => {
    const report = buildReport({
      tolerance_assessment: [
        {
          modality: "chemotherapy",
          level: "caution",
          risk_factors: [],
          protective_factors: [],
          missing_information: ["缺少 ECOG、血常规、肝肾功能和白蛋白"],
        },
        {
          modality: "radiotherapy",
          level: "good",
          risk_factors: [],
          protective_factors: [],
          missing_information: ["缺少 ECOG、血常规、肝肾功能和白蛋白"],
        },
        {
          modality: "immunotherapy",
          level: "good",
          risk_factors: [],
          protective_factors: ["已补充免疫治疗相关禁忌评估"],
          missing_information: [],
        },
      ],
    });

    const issues = evaluateToleranceRules(report);

    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("tolerance_assessment.1.level");
  });
});

describe("detectRedFlags", () => {
  it("detects airway, bleeding, dysphagia, infection, and critical value risks", () => {
    const redFlags = detectRedFlags([
      "内镜提示喉腔明显狭窄并有喘鸣。",
      "医生评语记录活动性出血和咯血。",
      "患者严重吞咽困难，伴误吸风险。",
      "入院时高热，考虑严重感染。",
      "检验报告提示血小板低于 20，属于危急值。",
    ]);

    expect(redFlags.map((redFlag) => redFlag.category)).toEqual([
      "airway",
      "bleeding",
      "severe_dysphagia",
      "infection",
      "critical_value",
    ]);
    expect(redFlags[0].level).toBe("emergency");
  });
});

describe("evaluateSafetyRules", () => {
  it("rejects dose, treatment course, automatic order, and review bypass text", () => {
    const issues = evaluateSafetyRules(
      [
        "建议顺铂 75 mg/m2 静滴。",
        "每 3 周一次，共 3 个周期疗程。",
        "系统可自动开医嘱并直接写回病历。",
        "无需医生复核，可直接执行。",
      ].join("\n"),
    );

    expect(issues.map((issue) => issue.code)).toEqual([
      "safety.no_dose",
      "safety.no_course",
      "safety.no_automatic_order",
      "safety.require_clinician_review",
    ]);
  });
});

describe("runDeterministicSafetyGate", () => {
  it("rejects reports that miss surfaced red flags or contain unsafe output", () => {
    const result = runDeterministicSafetyGate({
      report: buildReport(),
      sourceTexts: ["患者存在喉梗阻和静息呼吸困难。"],
      outputText: "无需医生复核，可直接执行。",
    });

    expect(result.allowed).toBe(false);
    expect(result.status).toBe("rejected");
    expect(result.red_flags[0]).toMatchObject({
      category: "airway",
      level: "emergency",
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "red_flag.must_surface",
        "safety.require_clinician_review",
      ]),
    );
  });

  it("passes when required pathology, tolerance, red flag, and safety constraints hold", () => {
    const result = runDeterministicSafetyGate({
      report: buildReport({
        red_flags: ["气道风险：存在喘鸣，需立即由医生评估。"],
        tolerance_assessment: [
          {
            modality: "chemotherapy",
            level: "good",
            risk_factors: [],
            protective_factors: ["ECOG 1，血常规、肝肾功能和白蛋白已评估"],
            missing_information: [],
          },
        ],
      }),
      sourceTexts: ["患者有喘鸣。"],
      labs: buildLabs(),
      outputText: "本报告仅作医生辅助评估，必须由医生复核。",
    });

    expect(result).toMatchObject({
      allowed: true,
      status: "passed",
      issues: [],
    });
  });
});
