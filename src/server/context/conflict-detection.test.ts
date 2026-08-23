import { describe, expect, it } from "vitest";
import type { SpecialtyStructure } from "@/domain/schemas";
import type { KnowledgeCitation } from "@/server/kb/search";
import { detectRagCitationConflicts } from "./conflict-detection";

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
