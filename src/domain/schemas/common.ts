import { z } from "zod";

export const DEFAULT_MEDICAL_DISCLAIMER =
  "本结果仅用于医生辅助评估，不能替代病理诊断、MDT 决策、治疗处方或急救处置。";

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const cancerSiteSchema = z.enum([
  "nasopharynx",
  "oropharynx",
  "hypopharynx",
  "larynx",
  "unknown",
]);

export const pathologyStatusSchema = z.enum([
  "confirmed",
  "suspicious",
  "not_available",
]);

export const sensitivityModalitySchema = z.enum([
  "radiotherapy",
  "platinum_chemo",
  "immunotherapy",
  "targeted_therapy",
]);

export const sensitivityLevelSchema = z.enum([
  "likely_sensitive",
  "possible_sensitive",
  "uncertain",
  "not_supported",
]);

export const toleranceModalitySchema = z.enum([
  "radiotherapy",
  "chemotherapy",
  "immunotherapy",
  "surgery_anesthesia",
]);

export const toleranceLevelSchema = z.enum([
  "good",
  "caution",
  "poor",
  "unknown",
]);

export const prioritySchema = z.enum(["high", "medium", "low"]);

export const expectedAnswerTypeSchema = z.enum([
  "yes_no",
  "single_select",
  "multi_select",
  "number",
  "date",
  "free_text",
  "report_upload",
]);

export const overallConfidenceSchema = z.enum(["low", "medium", "high"]);

export const extractedBySchema = z.enum([
  "agent",
  "clinician",
  "rule",
  "knowledge_base",
]);

export const evidenceSourceTypeSchema = z.enum([
  "clinician_note",
  "ct_report",
  "pathology_biomarker",
  "lab_report",
  "treatment_history",
  "demographics",
  "clarification_response",
  "clinician_correction",
  "knowledge_base",
  "other",
]);

export const reviewDecisionSchema = z.enum(["adopted", "rejected", "needs_revision"]);

export type CancerSite = z.infer<typeof cancerSiteSchema>;
export type PathologyStatus = z.infer<typeof pathologyStatusSchema>;
export type SensitivityModality = z.infer<typeof sensitivityModalitySchema>;
export type SensitivityLevel = z.infer<typeof sensitivityLevelSchema>;
export type ToleranceModality = z.infer<typeof toleranceModalitySchema>;
export type ToleranceLevel = z.infer<typeof toleranceLevelSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type ExpectedAnswerType = z.infer<typeof expectedAnswerTypeSchema>;
export type OverallConfidence = z.infer<typeof overallConfidenceSchema>;
export type ExtractedBy = z.infer<typeof extractedBySchema>;
export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
