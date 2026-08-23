import { z } from "zod";
import { isoDateTimeSchema } from "./common";

export const imagingToolKindSchema = z.enum(["ct", "wsi"]);
export const imagingToolJobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "quality_insufficient",
]);

export const imagingToolJobSchema = z.object({
  job_id: z.string().min(1),
  kind: imagingToolKindSchema,
  case_id: z.string().min(1),
  run_id: z.string().min(1),
  input_id: z.string().min(1),
  input_hash: z.string().min(1),
  idempotency_key: z.string().min(1),
  status: imagingToolJobStatusSchema,
  model_version: z.string().min(1),
  result_evidence_ids: z.array(z.string().min(1)),
  error_message: z.string().min(1).optional(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
}).strict();

export type ImagingToolKind = z.infer<typeof imagingToolKindSchema>;
export type ImagingToolJobStatus = z.infer<typeof imagingToolJobStatusSchema>;
export type ImagingToolJob = z.infer<typeof imagingToolJobSchema>;
