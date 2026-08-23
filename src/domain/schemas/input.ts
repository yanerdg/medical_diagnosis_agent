import { z } from "zod";
import { evidenceSourceTypeSchema, isoDateTimeSchema } from "./common";

export const caseInputTypeSchema = evidenceSourceTypeSchema.exclude([
  "clarification_response",
  "clinician_correction",
  "knowledge_base",
]);

export const caseInputSchema = z
  .object({
    input_id: z.string().min(1),
    case_id: z.string().min(1),
    input_type: caseInputTypeSchema,
    raw_text_path: z.string().min(1),
    raw_text_hash: z.string().min(1),
    version: z.number().int().positive(),
    submitted_at: isoDateTimeSchema,
  })
  .strict();

export type CaseInputType = z.infer<typeof caseInputTypeSchema>;
export type CaseInput = z.infer<typeof caseInputSchema>;
