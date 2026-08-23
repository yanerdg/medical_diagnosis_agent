import { z } from "zod";
import { type CancerSite, cancerSiteSchema } from "@/domain/schemas";
import {
  evidenceModelSchema,
  type EvidenceModel,
} from "@/domain/evidence";
import { loadKnowledgeBase, type KnowledgeChunk } from "./loader";
import { knowledgeCitationSchema, type KnowledgeCitation } from "./citation";
import { searchLocalKnowledgeChunks } from "./local-search";

export { knowledgeCitationSchema, type KnowledgeCitation } from "./citation";

const searchKnowledgeOptionsSchema = z
  .object({
    query: z.string().min(1),
    cancerSite: cancerSiteSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    limit: z.number().int().positive().max(20).default(5),
    rootDir: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  })
  .strict();

export const knowledgeSearchResultSchema = z
  .object({
    version: z.string().min(1),
    citations: z.array(knowledgeCitationSchema),
  })
  .strict();

const knowledgeEvidenceInputSchema = z
  .object({
    caseId: z.string().min(1),
    field: z.string().min(1),
    citation: knowledgeCitationSchema,
    createdAt: z.string().datetime({ offset: true }).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export type SearchKnowledgeBaseOptions = z.input<
  typeof searchKnowledgeOptionsSchema
>;
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;
export type KnowledgeEvidenceInput = z.input<
  typeof knowledgeEvidenceInputSchema
>;

export async function searchKnowledgeBase(
  options: SearchKnowledgeBaseOptions,
): Promise<KnowledgeSearchResult> {
  const parsedOptions = searchKnowledgeOptionsSchema.parse(options);
  let localCitations: KnowledgeCitation[] = [];
  try {
    localCitations = await searchLocalKnowledgeChunks({
      query: parsedOptions.query,
      cancerSite: parsedOptions.cancerSite,
      tags: parsedOptions.tags,
      limit: parsedOptions.limit,
      version: parsedOptions.version,
    });
  } catch {
    // Keep the existing file-backed KB usable when local SQLite has not yet been initialized.
    localCitations = [];
  }

  if (localCitations.length > 0) {
    return knowledgeSearchResultSchema.parse({
      version: parsedOptions.version ?? localCitations[0].version,
      citations: localCitations,
    });
  }

  const knowledgeBase = await loadKnowledgeBase({
    rootDir: parsedOptions.rootDir,
    version: parsedOptions.version,
  });

  return knowledgeSearchResultSchema.parse({
    version: knowledgeBase.version,
    citations: searchKnowledgeChunks(knowledgeBase.chunks, parsedOptions),
  });
}

export function searchKnowledgeChunks(
  chunks: KnowledgeChunk[],
  options: SearchKnowledgeBaseOptions,
): KnowledgeCitation[] {
  const parsedOptions = searchKnowledgeOptionsSchema.parse(options);
  const queryTerms = tokenizeSearchText(parsedOptions.query);
  const tagTerms = (parsedOptions.tags ?? []).flatMap(tokenizeSearchText);
  const terms = uniqueTerms([...queryTerms, ...tagTerms]);

  return chunks
    .filter((chunk) => appliesToCancerSite(chunk, parsedOptions.cancerSite))
    .map((chunk) => rankKnowledgeChunk(chunk, terms))
    .filter((citation): citation is KnowledgeCitation => citation !== null)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.citation_id.localeCompare(right.citation_id);
    })
    .slice(0, parsedOptions.limit);
}

export function knowledgeCitationToEvidenceModel(
  input: KnowledgeEvidenceInput,
): EvidenceModel {
  const parsedInput = knowledgeEvidenceInputSchema.parse(input);
  const confidence =
    parsedInput.confidence ?? citationScoreToConfidence(parsedInput.citation.score);

  return evidenceModelSchema.parse({
    evidence_id: buildKnowledgeEvidenceId(
      parsedInput.caseId,
      parsedInput.field,
      parsedInput.citation.citation_id,
    ),
    case_id: parsedInput.caseId,
    source_type: "knowledge_base",
    source_ref: parsedInput.citation.citation_id,
    field: parsedInput.field,
    value: {
      citation_id: parsedInput.citation.citation_id,
      source_title: parsedInput.citation.source_title,
      source_type: parsedInput.citation.source_type,
      version: parsedInput.citation.version,
      cancer_site_scope: parsedInput.citation.cancer_site_scope,
      evidence_level: parsedInput.citation.evidence_level,
      review_status: parsedInput.citation.review_status,
      structured_tags: parsedInput.citation.structured_tags,
    },
    quote: parsedInput.citation.text_chunk,
    confidence,
    extracted_by: "knowledge_base",
    created_at: parsedInput.createdAt ?? new Date().toISOString(),
  });
}

function rankKnowledgeChunk(
  chunk: KnowledgeChunk,
  terms: string[],
): KnowledgeCitation | null {
  const normalizedTitle = normalizeSearchText(chunk.source_title);
  const normalizedText = normalizeSearchText(chunk.text_chunk);
  const normalizedTags = chunk.structured_tags.map(normalizeSearchText);
  const normalizedSourceType = normalizeSearchText(chunk.source_type);
  const normalizedEvidenceLevel = normalizeSearchText(chunk.evidence_level);
  const matchedKeywords = new Set<string>();
  let score = 0;

  for (const term of terms) {
    if (normalizedTitle.includes(term)) {
      score += 4;
      matchedKeywords.add(term);
    }

    if (
      normalizedTags.some(
        (tag) => tag === term || tag.includes(term) || term.includes(tag),
      )
    ) {
      score += 5;
      matchedKeywords.add(term);
    }

    if (normalizedText.includes(term)) {
      score += 3;
      matchedKeywords.add(term);
    }

    if (
      normalizedSourceType.includes(term) ||
      normalizedEvidenceLevel.includes(term)
    ) {
      score += 1;
      matchedKeywords.add(term);
    }
  }

  if (score === 0) {
    return null;
  }

  return knowledgeCitationSchema.parse({
    id: chunk.id,
    chunk_id: chunk.chunk_id,
    cancer_site_scope: chunk.cancer_site_scope,
    evidence_level: chunk.evidence_level,
    text_chunk: chunk.text_chunk,
    structured_tags: chunk.structured_tags,
    version: chunk.version,
    source_id: chunk.source_id,
    source_title: chunk.source_title,
    source_type: chunk.source_type,
    publish_date: chunk.publish_date,
    review_status: chunk.review_status,
    citation_id: chunk.id,
    score,
    matched_keywords: [...matchedKeywords],
  });
}

function appliesToCancerSite(
  chunk: KnowledgeChunk,
  cancerSite: CancerSite | undefined,
): boolean {
  if (!cancerSite || cancerSite === "unknown") {
    return true;
  }

  return chunk.cancer_site_scope.includes(cancerSite);
}

function tokenizeSearchText(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const terms = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);

  return uniqueTerms([normalized, ...terms]);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms.filter((term) => term.length > 0))];
}

function citationScoreToConfidence(score: number): number {
  return Math.min(0.95, Math.max(0.55, 0.55 + score / 50));
}

export function buildKnowledgeEvidenceId(
  caseId: string,
  field: string,
  citationId: string,
): string {
  return `kb-evidence:${caseId}:${field}:${citationId}`.replace(
    /[^a-zA-Z0-9:_-]/g,
    "_",
  );
}
