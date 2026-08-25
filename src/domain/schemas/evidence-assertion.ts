import { jsonValueSchema } from "@/domain/evidence";
import { z } from "zod";
import { isoDateTimeSchema } from "./common";

export const evidenceAssertionDomainSchema = z.enum([
  "profile",
  "history",
  "imaging",
  "pathology",
  "biomarker",
  "labs",
  "treatment",
  "risk",
]);

export const evidenceAssertionPolaritySchema = z.enum([
  "present",
  "absent",
  "unknown",
  "uncertain",
]);

export const evidenceAssertionSourceTypeSchema = z.enum([
  "clinician_input",
  "clinician_answer",
  "signed_report",
  "ct_model",
  "wsi_model",
  "rag_citation",
]);

export const evidenceAssertionSchema = z.object({
  assertion_id: z.string().min(1),
  case_id: z.string().min(1),
  domain: evidenceAssertionDomainSchema,
  assertion_key: z.string().min(1),
  value: jsonValueSchema,
  polarity: evidenceAssertionPolaritySchema,
  source_type: evidenceAssertionSourceTypeSchema,
  source_ref: z.string().min(1),
  source_input_id: z.string().min(1).optional(),
  excerpt: z.string().min(1).optional(),
  observed_at: isoDateTimeSchema.optional(),
  model_version: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  created_at: isoDateTimeSchema,
}).strict();

export type EvidenceAssertion = z.infer<typeof evidenceAssertionSchema>;
export type EvidenceAssertionDomain = z.infer<typeof evidenceAssertionDomainSchema>;
export type EvidenceAssertionPolarity = z.infer<typeof evidenceAssertionPolaritySchema>;
export type EvidenceAssertionSourceType = z.infer<typeof evidenceAssertionSourceTypeSchema>;
