import { z } from "zod";
import { isoDateTimeSchema, reviewDecisionSchema } from "./common";

export const reviewSchema = z
  .object({
    review_id: z.string().min(1),
    report_id: z.string().min(1),
    reviewer_id: z.string().min(1),
    decision: reviewDecisionSchema,
    comment: z.string().min(1).optional(),
    reviewed_at: isoDateTimeSchema,
  })
  .strict();

export type Review = z.infer<typeof reviewSchema>;
