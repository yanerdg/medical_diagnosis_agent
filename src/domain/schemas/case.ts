import { z } from "zod";
import { isoDateTimeSchema } from "./common";

export const caseStatusSchema = z.enum(["draft", "ready_for_assessment", "archived"]);

export const caseSchema = z
  .object({
    case_id: z.string().min(1),
    display_name: z.string().min(1),
    patient_ref: z.string().min(1).optional(),
    status: caseStatusSchema,
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict();

export type CaseStatus = z.infer<typeof caseStatusSchema>;
export type CaseRecord = z.infer<typeof caseSchema>;
