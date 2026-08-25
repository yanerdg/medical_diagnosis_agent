import type { EvidenceModel, JsonValue } from "@/domain/evidence";
import type {
  EvidenceAssertionDomain,
  EvidenceAssertionPolarity,
  EvidenceAssertionSourceType,
} from "@/domain/schemas";
import type { MedicalRepository } from "@/server/repositories";

export function persistEvidenceModels(params: {
  repository: MedicalRepository;
  evidence: EvidenceModel[];
}): void {
  if (params.evidence.length === 0) return;
  params.repository.saveEvidenceAssertions(
    params.evidence.map(evidenceModelToAssertion),
  );
}

export function evidenceModelToAssertion(evidence: EvidenceModel) {
  return {
    assertion_id: evidence.evidence_id,
    case_id: evidence.case_id,
    domain: domainFromField(evidence.field),
    assertion_key: evidence.field,
    value: evidence.value,
    polarity: polarityFromValue(evidence.value),
    source_type: sourceTypeFromEvidence(evidence.source_type),
    source_ref: evidence.source_ref,
    source_input_id: inputBackedSource(evidence.source_type)
      ? evidence.source_ref
      : undefined,
    excerpt: evidence.quote,
    confidence: evidence.confidence,
    created_at: evidence.created_at,
  };
}

function domainFromField(field: string): EvidenceAssertionDomain {
  if (field.startsWith("pathology")) return "pathology";
  if (field.startsWith("ct.")) return "imaging";
  if (field.startsWith("biomarker")) return "biomarker";
  if (field.startsWith("labs.")) return "labs";
  if (field.startsWith("tolerance")) return "treatment";
  if (field.startsWith("cancer_site") || field.startsWith("clarification")) {
    return "history";
  }
  return "profile";
}

function polarityFromValue(value: JsonValue): EvidenceAssertionPolarity {
  if (value === null || value === "unknown" || value === "not_available") {
    return "unknown";
  }
  if (value === false) return "absent";
  return "present";
}

function sourceTypeFromEvidence(
  sourceType: EvidenceModel["source_type"],
): EvidenceAssertionSourceType {
  if (sourceType === "clarification_response" || sourceType === "clinician_correction") {
    return "clinician_answer";
  }
  if (sourceType === "knowledge_base") return "rag_citation";
  if (
    sourceType === "ct_report" ||
    sourceType === "pathology_biomarker" ||
    sourceType === "lab_report" ||
    sourceType === "treatment_history"
  ) {
    return "signed_report";
  }
  return "clinician_input";
}

function inputBackedSource(sourceType: EvidenceModel["source_type"]): boolean {
  return [
    "clinician_note",
    "ct_report",
    "pathology_biomarker",
    "lab_report",
    "treatment_history",
    "demographics",
    "other",
  ].includes(sourceType);
}
