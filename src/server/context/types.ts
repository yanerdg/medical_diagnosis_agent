import { z } from "zod";
import { jsonValueSchema, type JsonValue } from "@/domain/evidence";
import type { PatientMemory } from "@/lib/clinical-memory";

export const clinicalFactStatusSchema = z.enum([
  "confirmed",
  "reported",
  "unknown",
  "conflicting",
]);

export const clinicalFactSchema = z.object({
  fact_id: z.string().min(1),
  case_id: z.string().min(1),
  structure_id: z.string().min(1).optional(),
  domain: z.enum(["profile", "history", "imaging", "pathology", "biomarker", "labs", "treatment", "risk"]),
  fact_key: z.string().min(1),
  value: jsonValueSchema,
  status: clinicalFactStatusSchema,
  evidence_ids: z.array(z.string().min(1)),
  source_priority: z.number().int().nonnegative(),
  observed_at: z.string().datetime({ offset: true }).optional(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict();

export const conflictItemSchema = z.object({
  conflict_id: z.string().min(1),
  case_id: z.string().min(1),
  structure_id: z.string().min(1).optional(),
  category: z.enum(["fact", "cross_modality", "temporal", "claim_evidence", "rag_scope", "quality"]),
  severity: z.enum(["blocking", "high", "medium", "low"]),
  field: z.string().min(1),
  left_evidence_ids: z.array(z.string().min(1)),
  right_evidence_ids: z.array(z.string().min(1)),
  description: z.string().min(1),
  resolution: z.enum(["unresolved", "clinician_confirmed", "superseded", "acknowledged_unknown"]),
  blocks: z.array(z.enum(["assessment", "draft_report", "final_report"])),
  created_at: z.string().datetime({ offset: true }),
  resolved_at: z.string().datetime({ offset: true }).optional(),
}).strict();

export const contextProfileSchema = z.enum([
  "required_information_check",
  "conflict_check",
  "react_planner",
  "rag_search",
  "draft_report",
  "verifier",
]);

export const sourceExcerptSchema = z.object({
  input_id: z.string().min(1),
  input_type: z.string().min(1),
  submitted_at: z.string().datetime({ offset: true }),
  text: z.string().min(1),
}).strict();

export type ClinicalFact = z.infer<typeof clinicalFactSchema>;
export type ConflictItem = z.infer<typeof conflictItemSchema>;
export type ContextProfile = z.infer<typeof contextProfileSchema>;
export type SourceExcerpt = z.infer<typeof sourceExcerptSchema>;

export type ContextBundle = {
  case_id: string;
  run_id: string;
  clinical_snapshot_id?: string;
  source_fingerprint: string;
  profile: ContextProfile;
  core_fact_card: ClinicalFact[];
  task_facts: ClinicalFact[];
  unresolved_conflicts: ConflictItem[];
  patient_memory: PatientMemory;
  source_excerpts: SourceExcerpt[];
};

export type CreateClinicalFactParams = Omit<ClinicalFact, "fact_id" | "created_at" | "updated_at"> &
  Partial<Pick<ClinicalFact, "fact_id" | "created_at" | "updated_at">>;

export type CreateConflictItemParams = Omit<ConflictItem, "conflict_id" | "created_at"> &
  Partial<Pick<ConflictItem, "conflict_id" | "created_at">>;

export type ClinicalFactValue = JsonValue;
