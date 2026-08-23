import { describe, expect, it } from "vitest";
import {
  assessmentReportJsonSchema,
  DEFAULT_MEDICAL_DISCLAIMER,
} from "@/domain/schemas";
import { loadKnowledgeBase } from "./loader";
import {
  knowledgeCitationToEvidenceModel,
  searchKnowledgeBase,
} from "./search";

describe("local knowledge base", () => {
  it("loads the current version and validates chunk metadata", async () => {
    const knowledgeBase = await loadKnowledgeBase();

    expect(knowledgeBase.version).toBe("kb-v0.1");
    expect(knowledgeBase.chunks.length).toBeGreaterThan(0);
    expect(knowledgeBase.chunks[0]).toMatchObject({
      source_title: expect.any(String),
      source_type: expect.any(String),
      version: "kb-v0.1",
      evidence_level: expect.any(String),
      text_chunk: expect.any(String),
      review_status: "internal_mvp_review",
    });
  });

  it("returns report-bindable citations from keyword search", async () => {
    const result = await searchKnowledgeBase({
      query: "病理 敏感性",
      cancerSite: "larynx",
      limit: 3,
    });

    expect(result.version).toBe("kb-v0.1");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]).toMatchObject({
      citation_id: expect.stringContaining("kb-v0.1:"),
      source_title: expect.any(String),
      source_type: expect.any(String),
      version: "kb-v0.1",
      cancer_site_scope: expect.arrayContaining(["larynx"]),
      evidence_level: expect.any(String),
      text_chunk: expect.any(String),
    });

    const evidence = result.citations.map((citation) =>
      knowledgeCitationToEvidenceModel({
        caseId: "case-1",
        field: "sensitivity_assessment",
        citation,
        createdAt: "2026-07-09T08:00:00.000Z",
      }),
    );
    const reportJson = {
      case_id: "case-1",
      in_scope: true,
      assessment_status: "completed",
      summary: "喉癌疑似病例，报告引用本地知识库。",
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
          supporting_evidence: ["已有病理证据"],
          contradicting_evidence: [],
          missing_information: [],
          citations: result.citations.map((citation) => citation.citation_id),
          evidence_ids: evidence.map((item) => item.evidence_id),
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
      evidence,
      overall_confidence: "medium",
      knowledge_version: result.version,
      model_version: "model-v0.1",
      review_required: true,
      disclaimer: DEFAULT_MEDICAL_DISCLAIMER,
    };

    expect(assessmentReportJsonSchema.safeParse(reportJson).success).toBe(true);
  });

  it("converts a citation into an EvidenceModel record", async () => {
    const result = await searchKnowledgeBase({
      query: "气道 红旗",
      cancerSite: "larynx",
      limit: 1,
    });

    const evidence = knowledgeCitationToEvidenceModel({
      caseId: "case-1",
      field: "red_flags",
      citation: result.citations[0],
      createdAt: "2026-07-09T08:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      case_id: "case-1",
      source_type: "knowledge_base",
      source_ref: result.citations[0].citation_id,
      field: "red_flags",
      extracted_by: "knowledge_base",
    });
  });
});
