import type { SpecialtyStructure } from "@/domain/schemas";
import { getPatientMemorySnapshotForRead } from "@/server/memory/patient-memory-snapshots";
import type { MedicalRepository } from "@/server/repositories";
import { detectStructureConflicts } from "./conflict-detection";
import type {
  ClinicalFact,
  ContextBundle,
  ContextProfile,
  CreateClinicalFactParams,
  SourceExcerpt,
} from "./types";

const CORE_FACT_KEYS = new Set([
  "cancer_site",
  "pathology.status",
  "pathology.pathology_type",
  "ct.primary_site",
  "labs.ecog",
  "labs.blood_routine_available",
  "labs.liver_function_available",
  "labs.kidney_function_available",
  "labs.albumin_available",
]);

const EXCERPT_LIMIT_BY_PROFILE: Record<ContextProfile, number> = {
  required_information_check: 3,
  conflict_check: 4,
  react_planner: 2,
  rag_search: 1,
  draft_report: 4,
  verifier: 4,
};

const EXCERPT_CHAR_LIMIT = 900;

export class ClinicalContextManager {
  constructor(private readonly repository: MedicalRepository) {}

  build(params: {
    case_id: string;
    run_id: string;
    structure: SpecialtyStructure;
    profile: ContextProfile;
  }): ContextBundle {
    const caseRecord = this.repository.getCase(params.case_id);
    if (!caseRecord) throw new Error(`Case not found: ${params.case_id}`);

    const facts = this.synchronizeFacts(params.structure);
    const conflicts = detectStructureConflicts({
      case_id: params.case_id,
      structure: params.structure,
      created_at: new Date().toISOString(),
    });
    this.repository.replaceUnresolvedClinicalConflicts({
      case_id: params.case_id,
      structure_id: params.structure.structure_id,
      conflicts,
    });
    const memory = getPatientMemorySnapshotForRead({
      caseRecord,
      repository: this.repository,
    });

    const coreFactCard = facts.filter((fact) => CORE_FACT_KEYS.has(fact.fact_key));
    const taskFacts = selectTaskFacts(facts, params.profile);
    const unresolvedConflicts = this.repository.listUnresolvedClinicalConflicts(params.case_id);
    const toolJobs = this.repository.listImagingToolJobsForRun(params.run_id).map((job) => ({
      job_id: job.job_id,
      kind: job.kind,
      status: job.status,
      model_version: job.model_version,
      result_evidence_ids: job.result_evidence_ids,
    }));
    const sourceExcerpts = this.loadBoundedExcerpts(params.case_id, params.profile);
    const manifest = buildContextManifest({
      profile: params.profile,
      sourceFingerprint: memory.status.sourceFingerprint,
      coreFactCard,
      taskFacts,
      unresolvedConflicts,
      sourceExcerpts,
      toolJobs,
    });

    return {
      case_id: params.case_id,
      run_id: params.run_id,
      clinical_snapshot_id: this.repository.getLatestPatientMemorySnapshot(params.case_id)?.snapshot_id,
      source_fingerprint: memory.status.sourceFingerprint,
      profile: params.profile,
      core_fact_card: coreFactCard,
      task_facts: taskFacts,
      unresolved_conflicts: unresolvedConflicts,
      patient_memory: memory.memory,
      tool_jobs: toolJobs,
      source_excerpts: sourceExcerpts,
      manifest,
    };
  }

  private synchronizeFacts(structure: SpecialtyStructure): ClinicalFact[] {
    return this.repository.replaceClinicalFactsForStructure({
      case_id: structure.case_id,
      structure_id: structure.structure_id,
      facts: factsFromStructure(structure),
    });
  }

  private loadBoundedExcerpts(caseId: string, profile: ContextProfile): SourceExcerpt[] {
    return this.repository
      .listCaseInputs(caseId)
      .slice(0, EXCERPT_LIMIT_BY_PROFILE[profile])
      .flatMap((input) => {
        const text = this.repository.readCaseInputRawText(input.input_id)?.trim() ?? "";
        return text ? [{
          input_id: input.input_id,
          input_type: input.input_type,
          submitted_at: input.submitted_at,
          text: text.slice(0, EXCERPT_CHAR_LIMIT),
        }] : [];
      });
  }
}

function buildContextManifest(params: {
  profile: ContextProfile;
  sourceFingerprint: string;
  coreFactCard: ClinicalFact[];
  taskFacts: ClinicalFact[];
  unresolvedConflicts: import("./types").ConflictItem[];
  sourceExcerpts: SourceExcerpt[];
  toolJobs: ContextBundle["tool_jobs"];
}): ContextBundle["manifest"] {
  const selected = {
    core_facts: params.coreFactCard,
    task_facts: params.taskFacts,
    conflicts: params.unresolvedConflicts.map((item) => item.conflict_id),
    source_excerpts: params.sourceExcerpts.map((item) => item.input_id),
    tool_jobs: params.toolJobs.map((item) => item.job_id),
  };
  return {
    profile: params.profile,
    source_fingerprint: params.sourceFingerprint,
    core_fact_ids: params.coreFactCard.map((item) => item.fact_id),
    task_fact_ids: params.taskFacts.map((item) => item.fact_id),
    unresolved_conflict_ids: params.unresolvedConflicts.map((item) => item.conflict_id),
    source_input_ids: params.sourceExcerpts.map((item) => item.input_id),
    tool_job_ids: params.toolJobs.map((item) => item.job_id),
    estimated_tokens: Math.ceil(JSON.stringify(selected).length / 4),
    budget_tokens: 6500,
    selection_policy: "core safety facts + profile-specific facts + unresolved conflicts + bounded excerpts + tool states",
  };
}

function factsFromStructure(structure: SpecialtyStructure): CreateClinicalFactParams[] {
  const now = structure.created_at;
  const facts: CreateClinicalFactParams[] = [
    fact(structure, "history", "cancer_site", structure.cancer_site, structure.cancer_site === "unknown" ? "unknown" : "reported", structure.evidence_ids, now),
    fact(structure, "pathology", "pathology.status", structure.pathology.status, structure.pathology.status === "confirmed" ? "confirmed" : "unknown", structure.pathology.evidence_ids, now),
    fact(structure, "labs", "labs.blood_routine_available", structure.labs.blood_routine_available, "reported", structure.labs.evidence_ids, now),
    fact(structure, "labs", "labs.liver_function_available", structure.labs.liver_function_available, "reported", structure.labs.evidence_ids, now),
    fact(structure, "labs", "labs.kidney_function_available", structure.labs.kidney_function_available, "reported", structure.labs.evidence_ids, now),
    fact(structure, "labs", "labs.albumin_available", structure.labs.albumin_available, "reported", structure.labs.evidence_ids, now),
    fact(structure, "imaging", "ct.invasion_clues", structure.ct.invasion_clues, "reported", structure.ct.evidence_ids, now),
    fact(structure, "imaging", "ct.lymph_node_clues", structure.ct.lymph_node_clues, "reported", structure.ct.evidence_ids, now),
    fact(structure, "imaging", "ct.distant_metastasis_clues", structure.ct.distant_metastasis_clues, "reported", structure.ct.evidence_ids, now),
    fact(structure, "labs", "labs.abnormal_clues", structure.labs.abnormal_clues, "reported", structure.labs.evidence_ids, now),
  ];
  if (structure.pathology.pathology_type) facts.push(fact(structure, "pathology", "pathology.pathology_type", structure.pathology.pathology_type, "reported", structure.pathology.evidence_ids, now));
  if (structure.ct.primary_site) facts.push(fact(structure, "imaging", "ct.primary_site", structure.ct.primary_site, "reported", structure.ct.evidence_ids, now));
  if (structure.labs.ecog !== undefined) facts.push(fact(structure, "labs", "labs.ecog", structure.labs.ecog, "reported", structure.labs.evidence_ids, now));
  for (const [name, value] of Object.entries(structure.biomarkers)) facts.push(fact(structure, "biomarker", `biomarker.${name}`, value, "reported", structure.pathology.evidence_ids, now));
  return facts;
}

function fact(
  structure: SpecialtyStructure,
  domain: CreateClinicalFactParams["domain"],
  factKey: string,
  value: CreateClinicalFactParams["value"],
  status: CreateClinicalFactParams["status"],
  evidenceIds: string[],
  observedAt: string,
): CreateClinicalFactParams {
  return {
    case_id: structure.case_id,
    domain,
    fact_key: factKey,
    value,
    status,
    evidence_ids: evidenceIds,
    source_priority: status === "confirmed" ? 100 : 70,
    observed_at: observedAt,
  };
}

function selectTaskFacts(facts: ClinicalFact[], profile: ContextProfile): ClinicalFact[] {
  if (profile === "rag_search") {
    return facts.filter((fact) => ["cancer_site", "pathology.pathology_type", "ct.primary_site"].includes(fact.fact_key));
  }
  if (profile === "react_planner") {
    return facts.filter((fact) => !CORE_FACT_KEYS.has(fact.fact_key)).slice(0, 12);
  }
  return facts;
}
