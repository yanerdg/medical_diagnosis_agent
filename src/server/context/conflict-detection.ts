import type { SpecialtyStructure } from "@/domain/schemas";
import type { KnowledgeCitation } from "@/server/kb/search";
import type { CreateConflictItemParams } from "./types";

export function detectStructureConflicts(params: {
  case_id: string;
  structure: SpecialtyStructure;
  created_at: string;
}): CreateConflictItemParams[] {
  const { case_id, structure, created_at } = params;
  const conflicts: CreateConflictItemParams[] = [];

  if (structure.pathology.status !== "confirmed" && structure.pathology.pathology_type) {
    conflicts.push({
      case_id,
      structure_id: structure.structure_id,
      category: "fact",
      severity: "blocking",
      field: "pathology.status",
      left_evidence_ids: structure.pathology.evidence_ids,
      right_evidence_ids: structure.pathology.evidence_ids,
      description: "存在病理类型文本，但病理确认状态并非已确认；不得将其写为确诊依据。",
      resolution: "unresolved",
      blocks: ["assessment", "draft_report", "final_report"],
      created_at,
    });
  }

  const primarySite = structure.ct.primary_site ?? "";
  if (
    structure.cancer_site === "larynx" &&
    /鼻咽|nasophary/i.test(primarySite)
  ) {
    conflicts.push({
      case_id,
      structure_id: structure.structure_id,
      category: "cross_modality",
      severity: "high",
      field: "cancer_site",
      left_evidence_ids: structure.evidence_ids,
      right_evidence_ids: structure.ct.evidence_ids,
      description: "结构化癌种为喉部，但 CT 原发部位线索提示鼻咽来源，需要医生复核。",
      resolution: "unresolved",
      blocks: ["draft_report", "final_report"],
      created_at,
    });
  }

  return conflicts;
}

export function detectRagCitationConflicts(params: {
  case_id: string;
  structure: SpecialtyStructure;
  citations: KnowledgeCitation[];
  created_at: string;
}): CreateConflictItemParams[] {
  return params.citations.flatMap((citation) => {
    if (!citation.cancer_site_scope.includes(params.structure.cancer_site)) {
      return [{
        case_id: params.case_id,
        structure_id: params.structure.structure_id,
        category: "rag_scope" as const,
        severity: "blocking" as const,
        field: "rag.cancer_site_scope",
        left_evidence_ids: params.structure.evidence_ids,
        right_evidence_ids: [citation.citation_id],
        description: `引用 ${citation.citation_id} 不适用于当前癌种 ${params.structure.cancer_site}。`,
        resolution: "unresolved" as const,
        blocks: ["draft_report", "final_report"] as const,
        created_at: params.created_at,
      }];
    }
    if (!["approved", "clinician_reviewed", "internal_mvp_review"].includes(citation.review_status)) {
      return [{
        case_id: params.case_id,
        structure_id: params.structure.structure_id,
        category: "rag_scope" as const,
        severity: "blocking" as const,
        field: "rag.review_status",
        left_evidence_ids: [],
        right_evidence_ids: [citation.citation_id],
        description: `引用 ${citation.citation_id} 的审核状态为 ${citation.review_status}，不可用于报告。`,
        resolution: "unresolved" as const,
        blocks: ["draft_report", "final_report"] as const,
        created_at: params.created_at,
      }];
    }
    return [];
  });
}
