import {
  cancerSiteSchema,
  caseInputTypeSchema,
  pathologyStatusSchema,
  toleranceFactorSummarySchema,
} from "@/domain/schemas";
import { z } from "zod";

const trimmedNonBlankString = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1, "Required"));

const optionalTrimmedNonBlankString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim().length === 0 ? undefined : value,
  trimmedNonBlankString.optional(),
);

export const createCaseRequestSchema = z
  .object({
    display_name: trimmedNonBlankString,
    patient_ref: optionalTrimmedNonBlankString,
  })
  .strict();

export const caseRouteParamsSchema = z
  .object({
    caseId: trimmedNonBlankString,
  })
  .strict();

export const createCaseInputRequestSchema = z
  .object({
    input_type: caseInputTypeSchema,
    raw_text: z.string().refine((value) => value.trim().length > 0, "Required"),
    run_agent_turn: z.boolean().optional().default(false),
  })
  .strict();

export const createCaseInputsBatchRequestSchema = z
  .object({
    inputs: z
      .array(
        z
          .object({
            input_type: caseInputTypeSchema,
            raw_text: z
              .string()
              .refine((value) => value.trim().length > 0, "Required"),
          })
          .strict(),
      )
      .min(1, "At least one input is required."),
  })
  .strict();

export const createCaseInputsRequestSchema = z.union([
  createCaseInputRequestSchema,
  createCaseInputsBatchRequestSchema,
]);

const optionalNullableTrimmedString = z.union([
  trimmedNonBlankString,
  z.null(),
]).optional();

const stringListSchema = z.array(trimmedNonBlankString);

export const specialtyStructureCorrectionsRequestSchema = z
  .object({
    cancer_site: cancerSiteSchema.optional(),
    pathology: z
      .object({
        status: pathologyStatusSchema.optional(),
        pathology_type: optionalNullableTrimmedString,
        differentiation: optionalNullableTrimmedString,
      })
      .strict()
      .optional(),
    ct: z
      .object({
        primary_site: optionalNullableTrimmedString,
        invasion_clues: stringListSchema.optional(),
        lymph_node_clues: stringListSchema.optional(),
        distant_metastasis_clues: stringListSchema.optional(),
      })
      .strict()
      .optional(),
    biomarkers: z.record(trimmedNonBlankString, trimmedNonBlankString).optional(),
    labs: z
      .object({
        ecog: z.number().int().min(0).max(5).nullable().optional(),
        blood_routine_available: z.boolean().optional(),
        liver_function_available: z.boolean().optional(),
        kidney_function_available: z.boolean().optional(),
        albumin_available: z.boolean().optional(),
        abnormal_clues: stringListSchema.optional(),
      })
      .strict()
      .optional(),
    tolerance_factors: z.array(toleranceFactorSummarySchema).optional(),
  })
  .strict();

export const structureSpecialtyRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("extract"),
    })
    .strict(),
  z
    .object({
      action: z.literal("correct"),
      clinician_id: optionalTrimmedNonBlankString,
      corrections: specialtyStructureCorrectionsRequestSchema,
    })
    .strict(),
]);

export type CreateCaseRequest = z.infer<typeof createCaseRequestSchema>;
export type CreateCaseInputRequest = z.infer<
  typeof createCaseInputRequestSchema
>;
export type CreateCaseInputsBatchRequest = z.infer<
  typeof createCaseInputsBatchRequestSchema
>;
export type CreateCaseInputsRequest = z.infer<
  typeof createCaseInputsRequestSchema
>;
export type SpecialtyStructureCorrectionsRequest = z.infer<
  typeof specialtyStructureCorrectionsRequestSchema
>;
export type StructureSpecialtyRequest = z.infer<
  typeof structureSpecialtyRequestSchema
>;
