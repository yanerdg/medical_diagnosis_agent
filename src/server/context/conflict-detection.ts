import type { SpecialtyStructure } from "@/domain/schemas";
import type { AssessmentReportJson } from "@/domain/schemas";
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
      conflict_id: `${structure.structure_id}:pathology-status`,
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
      conflict_id: `${structure.structure_id}:cancer-site-ct-primary`,
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
        conflict_id: `rag:${params.structure.structure_id}:${citation.citation_id}:scope`,
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
    if (!["approved", "clinician_reviewed"].includes(citation.review_status)) {
      return [{
        conflict_id: `rag:${params.structure.structure_id}:${citation.citation_id}:review-status`,
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

export function detectRagClaimEntailmentConflicts(params: {
  case_id: string;
  structure: SpecialtyStructure;
  report: AssessmentReportJson;
  citations: KnowledgeCitation[];
  created_at: string;
}): CreateConflictItemParams[] {
  const citationsById = new Map(
    params.citations.map((citation) => [citation.citation_id, citation]),
  );
  return params.report.sensitivity_assessment.flatMap((claim) => {
    if (claim.level !== "possible_sensitive" && claim.level !== "likely_sensitive") {
      return [];
    }
    const matchedCitationIds = claim.citations.filter((citationId) => {
      const citation = citationsById.get(citationId);
      return citation !== undefined && citationSupportsModality(citation, claim.modality);
    });
    if (matchedCitationIds.length > 0) return [];
    return [{
      conflict_id: `rag:${params.structure.structure_id}:entailment:${claim.modality}`,
      case_id: params.case_id,
      structure_id: params.structure.structure_id,
      category: "claim_evidence" as const,
      severity: "high" as const,
      field: `sensitivity_assessment.${claim.modality}`,
      left_evidence_ids: claim.evidence_ids,
      right_evidence_ids: claim.citations,
      description: `敏感性主张 ${claim.modality} 缺少能够支持该治疗方式的 RAG 引文内容或标签。`,
      resolution: "unresolved" as const,
      blocks: ["draft_report", "final_report"] as const,
      created_at: params.created_at,
    }];
  });
}

function citationSupportsModality(
  citation: KnowledgeCitation,
  modality: AssessmentReportJson["sensitivity_assessment"][number]["modality"],
): boolean {
  const terms: Record<typeof modality, RegExp> = {
    radiotherapy: /放疗|radiotherap|radiation/i,
    platinum_chemo: /铂类|顺铂|卡铂|platinum|chemotherap|化疗/i,
    immunotherapy: /免疫治疗|免疫检查点|pd-?1|pd-?l1|immunotherap/i,
    targeted_therapy: /靶向治疗|egfr|ntrk|targeted therap/i,
  };
  return terms[modality].test([
    citation.text_chunk,
    citation.source_title,
    ...citation.structured_tags,
  ].join("\n"));
}
