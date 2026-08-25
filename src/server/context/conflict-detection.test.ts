import { describe, expect, it } from "vitest";
import type { SpecialtyStructure } from "@/domain/schemas";
import type { KnowledgeCitation } from "@/server/kb/search";
import { detectClinicalFactEvidenceIntegrityConflicts, detectRagCitationConflicts, detectRagClaimEntailmentConflicts } from "./conflict-detection";

const createdAt = "2026-08-23T00:00:00.000Z";

describe("detectRagCitationConflicts", () => {
  it("rejects citations outside the case scope or without clinician approval", () => {
    const conflicts = detectRagCitationConflicts({
      case_id: "case-rag-conflict",
      structure: structure(),
      citations: [
        citation({ citation_id: "citation-wrong-site", cancer_site_scope: ["nasopharynx"] }),
        citation({ citation_id: "citation-draft", review_status: "draft" }),
      ],
      created_at: createdAt,
    });

    expect(conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conflict_id: "rag:structure-rag-conflict:citation-wrong-site:scope",
          field: "rag.cancer_site_scope",
          severity: "blocking",
        }),
        expect.objectContaining({
          conflict_id: "rag:structure-rag-conflict:citation-draft:review-status",
          field: "rag.review_status",
          severity: "blocking",
        }),
      ]),
    );
  });
});

it("rejects a treatment sensitivity claim without modality-entailing RAG content", () => {
  const report = {
    case_id: "case-rag-conflict",
    in_scope: true,
    assessment_status: "completed" as const,
    summary: "辅助评估",
    pending_clarification: null,
    diagnostic_evidence: { cancer_site: "larynx" as const, pathology_status: "confirmed" as const, pathology_type: "鳞状细胞癌", stage_clues: [], missing_for_staging: [] },
    sensitivity_assessment: [{ modality: "immunotherapy" as const, level: "possible_sensitive" as const, supporting_evidence: ["病理"], contradicting_evidence: [], missing_information: [], citations: ["citation-radiotherapy"], evidence_ids: ["kb-evidence"] }],
    tolerance_assessment: [], red_flags: [], recommended_missing_tests: [], evidence: [], overall_confidence: "medium" as const, knowledge_version: "v1", model_version: "test", review_required: true as const,
    disclaimer: "本结果仅用于医生辅助评估，不能替代病理诊断、MDT 决策、治疗处方或急救处置。" as const,
  };
  const conflicts = detectRagClaimEntailmentConflicts({
    case_id: "case-rag-conflict", structure: structure(), report,
    citations: [citation({ citation_id: "citation-radiotherapy", text_chunk: "放疗可作为治疗选择。" })], created_at: createdAt,
  });
  expect(conflicts).toEqual([expect.objectContaining({ severity: "high", field: "sensitivity_assessment.immunotherapy" })]);
});

it("flags a clinical fact whose evidence identifier cannot be traced", () => {
  const conflicts = detectClinicalFactEvidenceIntegrityConflicts({
    case_id: "case-rag-conflict", structure: structure(), assertions: [], created_at: createdAt,
    facts: [{
      fact_id: "fact-1", case_id: "case-rag-conflict", structure_id: "structure-rag-conflict",
      domain: "pathology", fact_key: "pathology.status", value: "confirmed", status: "confirmed",
      evidence_ids: ["missing-evidence"], source_priority: 100, created_at: createdAt, updated_at: createdAt,
    }],
  });
  expect(conflicts).toEqual([expect.objectContaining({
    severity: "high", blocks: ["final_report"], right_evidence_ids: ["missing-evidence"],
  })]);
});

function structure(): SpecialtyStructure {
  return {
    structure_id: "structure-rag-conflict",
    case_id: "case-rag-conflict",
    version: 1,
    cancer_site: "larynx",
    pathology: { status: "confirmed", evidence_ids: ["e-pathology"] },
    ct: {
      invasion_clues: [],
      lymph_node_clues: [],
      distant_metastasis_clues: [],
      evidence_ids: ["e-ct"],
    },
    biomarkers: {},
    labs: {
      blood_routine_available: true,
      liver_function_available: true,
      kidney_function_available: true,
      albumin_available: true,
      abnormal_clues: [],
      evidence_ids: ["e-labs"],
    },
    tolerance_factors: [],
    evidence_ids: ["e-pathology", "e-ct", "e-labs"],
    created_at: createdAt,
  };
}

function citation(overrides: Partial<KnowledgeCitation>): KnowledgeCitation {
  return {
    id: overrides.citation_id ?? "citation-default",
    citation_id: overrides.citation_id ?? "citation-default",
    chunk_id: overrides.citation_id ?? "citation-default",
    version: "v1",
    source_id: "source-1",
    source_title: "Knowledge source",
    source_type: "guideline",
    publish_date: "2026-01-01",
    review_status: "approved",
    cancer_site_scope: ["larynx"],
    evidence_level: "guideline_consensus",
    text_chunk: "适用于喉癌的外部知识。",
    structured_tags: ["sensitivity"],
    score: 1,
    matched_keywords: ["larynx"],
    ...overrides,
  };
}
