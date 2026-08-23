import { z } from "zod";
import {
  expectedAnswerTypeSchema,
  isoDateTimeSchema,
  prioritySchema,
} from "./common";

export const clarificationQuestionSchema = z
  .object({
    id: z.string().min(1),
    priority: prioritySchema,
    question: z.string().min(1),
    expected_answer_type: expectedAnswerTypeSchema,
    clinical_purpose: z.string().min(1),
    blocks_conclusion: z.boolean(),
  })
  .strict();

export const clarificationRequestSchema = z
  .object({
    request_id: z.string().min(1),
    reason: z.string().min(1),
    questions: z.array(clarificationQuestionSchema).min(1).max(5),
  })
  .strict();

export const clarificationRequestRecordSchema = clarificationRequestSchema
  .extend({
    case_id: z.string().min(1),
    run_id: z.string().min(1),
    created_at: isoDateTimeSchema,
  })
  .strict();

export const clarificationResponseSchema = z
  .object({
    response_id: z.string().min(1),
    request_id: z.string().min(1),
    question_id: z.string().min(1),
    answer_text: z.string().min(1).optional(),
    marked_unknown: z.boolean(),
    conflict_resolution: z
      .enum(["confirm_left", "confirm_right", "acknowledge_unknown"])
      .optional(),
    supplemental_input_id: z.string().min(1).optional(),
    submitted_at: isoDateTimeSchema,
  })
  .strict();

export type ClarificationQuestion = z.infer<typeof clarificationQuestionSchema>;
export type ClarificationRequest = z.infer<typeof clarificationRequestSchema>;
export type ClarificationRequestRecord = z.infer<
  typeof clarificationRequestRecordSchema
>;
export type ClarificationResponse = z.infer<typeof clarificationResponseSchema>;
