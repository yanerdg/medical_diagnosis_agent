import { z } from "zod";
import { evidenceModelSchema } from "@/domain/evidence";
import { clarificationRequestSchema } from "./clarification";
import {
  cancerSiteSchema,
  DEFAULT_MEDICAL_DISCLAIMER,
  isoDateTimeSchema,
  overallConfidenceSchema,
  pathologyStatusSchema,
  sensitivityLevelSchema,
  sensitivityModalitySchema,
  toleranceLevelSchema,
  toleranceModalitySchema,
} from "./common";

export const assessmentStatusSchema = z.enum([
  "completed",
  "paused_for_clinician_input",
]);

export const assessmentRunStatusSchema = z.enum([
  "created",
  "running",
  "paused_for_clinician_input",
  "completed",
  "failed",
  "rejected_by_safety_gate",
]);

export const diagnosticEvidenceSchema = z
  .object({
    cancer_site: cancerSiteSchema,
    pathology_status: pathologyStatusSchema,
    pathology_type: z.string(),
    stage_clues: z.array(z.string()),
    missing_for_staging: z.array(z.string()),
  })
  .strict();

export const sensitivityAssessmentItemSchema = z
  .object({
    modality: sensitivityModalitySchema,
    level: sensitivityLevelSchema,
    supporting_evidence: z.array(z.string()),
    contradicting_evidence: z.array(z.string()),
    missing_information: z.array(z.string()),
    citations: z.array(z.string()),
    evidence_ids: z.array(z.string()),
  })
  .strict();

export const toleranceAssessmentItemSchema = z
  .object({
    modality: toleranceModalitySchema,
    level: toleranceLevelSchema,
    risk_factors: z.array(z.string()),
    protective_factors: z.array(z.string()),
    missing_information: z.array(z.string()),
  })
  .strict();

export const assessmentReportJsonSchema = z
  .object({
    case_id: z.string().min(1),
    in_scope: z.boolean(),
    assessment_status: assessmentStatusSchema,
    summary: z.string().min(1),
    pending_clarification: clarificationRequestSchema.nullable(),
    diagnostic_evidence: diagnosticEvidenceSchema,
    sensitivity_assessment: z.array(sensitivityAssessmentItemSchema),
    tolerance_assessment: z.array(toleranceAssessmentItemSchema),
    red_flags: z.array(z.string()),
    recommended_missing_tests: z.array(z.string()),
    evidence: z.array(evidenceModelSchema),
    overall_confidence: overallConfidenceSchema,
    knowledge_version: z.string().min(1),
    model_version: z.string().min(1),
    review_required: z.literal(true),
    disclaimer: z.literal(DEFAULT_MEDICAL_DISCLAIMER),
  })
  .strict()
  .superRefine((report, ctx) => {
    if (
      report.assessment_status === "paused_for_clinician_input" &&
      report.pending_clarification === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["pending_clarification"],
        message: "paused reports require pending_clarification",
      });
    }

    if (
      report.assessment_status === "completed" &&
      report.pending_clarification !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["pending_clarification"],
        message: "completed reports must not carry pending_clarification",
      });
    }

    const knowledgeEvidenceByCitation = new Map(
      report.evidence
        .filter((item) => item.source_type === "knowledge_base")
        .map((item) => [item.source_ref, item.evidence_id]),
    );

    report.sensitivity_assessment.forEach((item, index) => {
      item.citations.forEach((citationId) => {
        const evidenceId = knowledgeEvidenceByCitation.get(citationId);

        if (evidenceId === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["sensitivity_assessment", index, "citations"],
            message: "knowledge citations must be backed by knowledge_base EvidenceModel records",
          });
          return;
        }

        if (!item.evidence_ids.includes(evidenceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["sensitivity_assessment", index, "evidence_ids"],
            message: "sensitivity evidence_ids must include the EvidenceModel backing each citation",
          });
        }
      });
    });
  });

export const assessmentRunSchema = z
  .object({
    run_id: z.string().min(1),
    case_id: z.string().min(1),
    status: assessmentRunStatusSchema,
    structure_id: z.string().min(1).optional(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .strict();

export const assessmentReportRecordSchema = z
  .object({
    report_id: z.string().min(1),
    run_id: z.string().min(1),
    case_id: z.string().min(1),
    report_json: assessmentReportJsonSchema,
    report_markdown: z.string().min(1),
    created_at: isoDateTimeSchema,
  })
  .strict();

export const reportJsonSchema = assessmentReportJsonSchema;

export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;
export type AssessmentRunStatus = z.infer<typeof assessmentRunStatusSchema>;
export type DiagnosticEvidence = z.infer<typeof diagnosticEvidenceSchema>;
export type SensitivityAssessmentItem = z.infer<
  typeof sensitivityAssessmentItemSchema
>;
export type ToleranceAssessmentItem = z.infer<
  typeof toleranceAssessmentItemSchema
>;
export type AssessmentReportJson = z.infer<typeof assessmentReportJsonSchema>;
export type AssessmentRun = z.infer<typeof assessmentRunSchema>;
export type AssessmentReportRecord = z.infer<
  typeof assessmentReportRecordSchema
>;
