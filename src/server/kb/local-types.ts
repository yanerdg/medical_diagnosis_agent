import { z } from "zod";
import { cancerSiteSchema } from "@/domain/schemas";

const isoDateTimeSchema = z.string().datetime({ offset: true });
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const injectedKnowledgeSourceTypeSchema = z.enum([
  "guideline",
  "expert_consensus",
  "institutional_protocol",
  "peer_reviewed",
  "reference_material",
]);

export const injectedKnowledgeEvidenceLevelSchema = z.enum([
  "guideline_consensus",
  "expert_consensus",
  "peer_reviewed",
  "institutional_reviewed",
]);

export const injectedKnowledgeReviewStatusSchema = z.enum([
  "draft",
  "clinician_reviewed",
  "approved",
  "retired",
]);

export const supportedKnowledgeFileTypeSchema = z.enum(["markdown", "text", "docx", "pdf"]);

export const knowledgeDocumentMetadataSchema = z.object({
  source_id: z.string().min(1).max(160),
  source_title: z.string().min(1).max(500),
  source_type: injectedKnowledgeSourceTypeSchema,
  cancer_site_scope: z.array(cancerSiteSchema).min(1),
  evidence_level: injectedKnowledgeEvidenceLevelSchema,
  review_status: injectedKnowledgeReviewStatusSchema,
  publish_date: dateOnlySchema,
  structured_tags: z.array(z.string().min(1).max(80)).default([]),
});

export const extractedKnowledgeSectionSchema = z.object({
  text: z.string().min(1),
  heading_path: z.array(z.string().min(1)).default([]),
  page_start: z.number().int().positive().optional(),
  page_end: z.number().int().positive().optional(),
});

export const knowledgeChunkRecordSchema = extractedKnowledgeSectionSchema.extend({
  chunk_id: z.string().min(1),
  document_version_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  content_sha256: z.string().length(64),
  token_estimate: z.number().int().nonnegative(),
  created_at: isoDateTimeSchema,
});

export const localKnowledgeCitationSchema = z.object({
  citation_id: z.string().min(1),
  chunk_id: z.string().min(1),
  source_id: z.string().min(1),
  source_title: z.string().min(1),
  source_type: injectedKnowledgeSourceTypeSchema,
  cancer_site_scope: z.array(cancerSiteSchema).min(1),
  evidence_level: injectedKnowledgeEvidenceLevelSchema,
  review_status: injectedKnowledgeReviewStatusSchema,
  publish_date: dateOnlySchema,
  knowledge_version: z.string().min(1),
  text_chunk: z.string().min(1),
  heading_path: z.array(z.string()),
  page_start: z.number().int().positive().nullable(),
  page_end: z.number().int().positive().nullable(),
  rrf_score: z.number().nonnegative(),
  lexical_rank: z.number().int().positive().nullable(),
  vector_rank: z.number().int().positive().nullable(),
  matched_keywords: z.array(z.string()),
});

export type KnowledgeDocumentMetadata = z.infer<typeof knowledgeDocumentMetadataSchema>;
export type ExtractedKnowledgeSection = z.infer<typeof extractedKnowledgeSectionSchema>;
export type KnowledgeChunkRecord = z.infer<typeof knowledgeChunkRecordSchema>;
export type LocalKnowledgeCitation = z.infer<typeof localKnowledgeCitationSchema>;
