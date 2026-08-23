import { z } from "zod";
import {
  evidenceSourceTypeSchema,
  extractedBySchema,
  isoDateTimeSchema,
} from "../schemas/common";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const evidenceModelSchema = z
  .object({
    evidence_id: z.string().min(1),
    case_id: z.string().min(1),
    source_type: evidenceSourceTypeSchema,
    source_ref: z.string().min(1),
    field: z.string().min(1),
    value: jsonValueSchema,
    quote: z.string().min(1),
    confidence: z.number().min(0).max(1),
    extracted_by: extractedBySchema,
    created_at: isoDateTimeSchema,
  })
  .strict();

export const evidenceModelListSchema = z.array(evidenceModelSchema);

export type EvidenceModel = z.infer<typeof evidenceModelSchema>;
export type EvidenceModelList = z.infer<typeof evidenceModelListSchema>;
export type { JsonValue };
