import { caseInputTypeSchema, reviewDecisionSchema } from "@/domain/schemas";
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

export const assessmentRunRouteParamsSchema = z
  .object({
    runId: trimmedNonBlankString,
  })
  .strict();

export const assessmentReportRouteParamsSchema = z
  .object({
    reportId: trimmedNonBlankString,
  })
  .strict();

export const clarificationRequestRouteParamsSchema = z
  .object({
    requestId: trimmedNonBlankString,
  })
  .strict();

export const createAssessmentRunRequestSchema = z
  .object({
    structure_id: optionalTrimmedNonBlankString,
  })
  .strict();

const clarificationResponseItemSchema = z
  .object({
    question_id: trimmedNonBlankString,
    answer_text: optionalTrimmedNonBlankString,
    marked_unknown: z.boolean().optional().default(false),
    conflict_resolution: z
      .enum(["confirm_left", "confirm_right", "acknowledge_unknown"])
      .optional(),
  })
  .strict()
  .refine(
    (response) => response.marked_unknown || response.answer_text !== undefined,
    {
      message: "answer_text is required unless marked_unknown is true.",
      path: ["answer_text"],
    },
  );

export const submitClarificationResponsesRequestSchema = z
  .object({
    clinician_id: optionalTrimmedNonBlankString,
    responses: z.array(clarificationResponseItemSchema).min(1),
    supplemental_report_text: optionalTrimmedNonBlankString,
    supplemental_input_type: caseInputTypeSchema.optional(),
  })
  .strict();

export const resumeAssessmentRunRequestSchema = z
  .object({
    clinician_id: optionalTrimmedNonBlankString,
  })
  .strict();

export const submitReportReviewRequestSchema = z
  .object({
    reviewer_id: optionalTrimmedNonBlankString.default("doctor-mvp"),
    decision: reviewDecisionSchema,
    comment: optionalTrimmedNonBlankString,
  })
  .strict();

export type CreateAssessmentRunRequest = z.infer<
  typeof createAssessmentRunRequestSchema
>;
export type SubmitClarificationResponsesRequest = z.infer<
  typeof submitClarificationResponsesRequestSchema
>;
export type ResumeAssessmentRunRequest = z.infer<
  typeof resumeAssessmentRunRequestSchema
>;
export type SubmitReportReviewRequest = z.infer<
  typeof submitReportReviewRequestSchema
>;
