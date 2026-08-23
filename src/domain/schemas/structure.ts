import { z } from "zod";
import {
  cancerSiteSchema,
  isoDateTimeSchema,
  pathologyStatusSchema,
  toleranceLevelSchema,
} from "./common";

export const pathologySummarySchema = z
  .object({
    status: pathologyStatusSchema,
    pathology_type: z.string().min(1).optional(),
    differentiation: z.string().min(1).optional(),
    evidence_ids: z.array(z.string().min(1)),
  })
  .strict();

export const ctSummarySchema = z
  .object({
    primary_site: z.string().min(1).optional(),
    invasion_clues: z.array(z.string().min(1)),
    lymph_node_clues: z.array(z.string().min(1)),
    distant_metastasis_clues: z.array(z.string().min(1)),
    evidence_ids: z.array(z.string().min(1)),
  })
  .strict();

export const labSummarySchema = z
  .object({
    ecog: z.number().int().min(0).max(5).optional(),
    blood_routine_available: z.boolean(),
    liver_function_available: z.boolean(),
    kidney_function_available: z.boolean(),
    albumin_available: z.boolean(),
    abnormal_clues: z.array(z.string().min(1)),
    evidence_ids: z.array(z.string().min(1)),
  })
  .strict();

export const toleranceFactorSummarySchema = z
  .object({
    modality: z.enum([
      "radiotherapy",
      "chemotherapy",
      "immunotherapy",
      "surgery_anesthesia",
    ]),
    provisional_level: toleranceLevelSchema,
    risk_factors: z.array(z.string().min(1)),
    missing_information: z.array(z.string().min(1)),
  })
  .strict();

export const specialtyStructureSchema = z
  .object({
    structure_id: z.string().min(1),
    case_id: z.string().min(1),
    version: z.number().int().positive(),
    cancer_site: cancerSiteSchema,
    pathology: pathologySummarySchema,
    ct: ctSummarySchema,
    biomarkers: z.record(z.string(), z.string()),
    labs: labSummarySchema,
    tolerance_factors: z.array(toleranceFactorSummarySchema),
    evidence_ids: z.array(z.string().min(1)),
    created_at: isoDateTimeSchema,
  })
  .strict();

export type PathologySummary = z.infer<typeof pathologySummarySchema>;
export type CtSummary = z.infer<typeof ctSummarySchema>;
export type LabSummary = z.infer<typeof labSummarySchema>;
export type ToleranceFactorSummary = z.infer<typeof toleranceFactorSummarySchema>;
export type SpecialtyStructure = z.infer<typeof specialtyStructureSchema>;
