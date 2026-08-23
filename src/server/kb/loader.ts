import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { cancerSiteSchema } from "@/domain/schemas";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const kbSourceTypeSchema = z.enum([
  "local_mvp_rule",
  "local_staging_note",
  "local_tolerance_rule",
]);

export const kbEvidenceLevelSchema = z.enum([
  "mvp_internal_rule",
  "expert_consensus",
  "guideline_consensus",
  "peer_reviewed",
]);

export const kbReviewStatusSchema = z.enum([
  "draft",
  "internal_mvp_review",
  "clinician_reviewed",
]);

export const kbVersionManifestSchema = z
  .object({
    version: z.string().min(1),
    directory: z.string().min(1),
    published_at: dateOnlySchema,
    review_status: kbReviewStatusSchema,
    files: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const kbVersionsSchema = z
  .object({
    current_version: z.string().min(1),
    versions: z.array(kbVersionManifestSchema).min(1),
  })
  .strict();

export const kbDocumentChunkSchema = z
  .object({
    chunk_id: z.string().min(1),
    cancer_site_scope: z.array(cancerSiteSchema).min(1),
    evidence_level: kbEvidenceLevelSchema,
    text_chunk: z.string().min(1),
    structured_tags: z.array(z.string().min(1)),
  })
  .strict();

export const kbDocumentSchema = z
  .object({
    source_id: z.string().min(1),
    source_title: z.string().min(1),
    source_type: kbSourceTypeSchema,
    publish_date: dateOnlySchema,
    review_status: kbReviewStatusSchema,
    chunks: z.array(kbDocumentChunkSchema).min(1),
  })
  .strict();

export const knowledgeChunkSchema = kbDocumentChunkSchema
  .omit({ chunk_id: true })
  .extend({
    id: z.string().min(1),
    chunk_id: z.string().min(1),
    version: z.string().min(1),
    source_id: z.string().min(1),
    source_title: z.string().min(1),
    source_type: kbSourceTypeSchema,
    publish_date: dateOnlySchema,
    review_status: kbReviewStatusSchema,
    source_path: z.string().min(1),
  })
  .strict();

export const knowledgeBaseSchema = z
  .object({
    version: z.string().min(1),
    published_at: dateOnlySchema,
    review_status: kbReviewStatusSchema,
    root_dir: z.string().min(1),
    chunks: z.array(knowledgeChunkSchema),
  })
  .strict();

export type KbSourceType = z.infer<typeof kbSourceTypeSchema>;
export type KbEvidenceLevel = z.infer<typeof kbEvidenceLevelSchema>;
export type KbReviewStatus = z.infer<typeof kbReviewStatusSchema>;
export type KbVersions = z.infer<typeof kbVersionsSchema>;
export type KbVersionManifest = z.infer<typeof kbVersionManifestSchema>;
export type KbDocument = z.infer<typeof kbDocumentSchema>;
export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;
export type KnowledgeBase = z.infer<typeof knowledgeBaseSchema>;

export type LoadKnowledgeBaseOptions = {
  rootDir?: string;
  version?: string;
};

const DEFAULT_KB_ROOT = path.join(process.cwd(), "data", "kb");
const KB_BLOCK_PATTERN = /```kb\s*([\s\S]*?)```/m;

export async function loadKnowledgeBaseVersions(
  rootDir = DEFAULT_KB_ROOT,
): Promise<KbVersions> {
  const versionsPath = path.join(rootDir, "versions.json");
  const rawVersions = await readFile(versionsPath, "utf8");
  return kbVersionsSchema.parse(JSON.parse(rawVersions));
}

export async function loadKnowledgeBase(
  options: LoadKnowledgeBaseOptions = {},
): Promise<KnowledgeBase> {
  const rootDir = options.rootDir ?? DEFAULT_KB_ROOT;
  const versions = await loadKnowledgeBaseVersions(rootDir);
  const versionId = options.version ?? versions.current_version;
  const versionManifest = versions.versions.find(
    (candidate) => candidate.version === versionId,
  );

  if (!versionManifest) {
    throw new Error(`Knowledge base version not found: ${versionId}`);
  }

  const chunks = (
    await Promise.all(
      versionManifest.files.map((fileName) =>
        loadKnowledgeDocumentChunks(rootDir, versionManifest, fileName),
      ),
    )
  ).flat();

  return knowledgeBaseSchema.parse({
    version: versionManifest.version,
    published_at: versionManifest.published_at,
    review_status: versionManifest.review_status,
    root_dir: rootDir,
    chunks,
  });
}

async function loadKnowledgeDocumentChunks(
  rootDir: string,
  versionManifest: KbVersionManifest,
  fileName: string,
): Promise<KnowledgeChunk[]> {
  const sourcePath = path.join(rootDir, versionManifest.directory, fileName);
  const rawDocument = await readFile(sourcePath, "utf8");
  const document = extractKnowledgeDocument(rawDocument, sourcePath);

  return document.chunks.map((chunk) =>
    knowledgeChunkSchema.parse({
      ...chunk,
      id: buildKnowledgeChunkId(
        versionManifest.version,
        document.source_id,
        chunk.chunk_id,
      ),
      version: versionManifest.version,
      source_id: document.source_id,
      source_title: document.source_title,
      source_type: document.source_type,
      publish_date: document.publish_date,
      review_status: document.review_status,
      source_path: path.relative(process.cwd(), sourcePath),
    }),
  );
}

function extractKnowledgeDocument(rawDocument: string, sourcePath: string): KbDocument {
  const match = rawDocument.match(KB_BLOCK_PATTERN);

  if (!match?.[1]) {
    throw new Error(`Missing kb metadata block in ${sourcePath}`);
  }

  try {
    return kbDocumentSchema.parse(JSON.parse(match[1]));
  } catch (error) {
    throw new Error(`Invalid kb metadata block in ${sourcePath}`, {
      cause: error,
    });
  }
}

export function buildKnowledgeChunkId(
  version: string,
  sourceId: string,
  chunkId: string,
): string {
  return `${version}:${sourceId}:${chunkId}`;
}
