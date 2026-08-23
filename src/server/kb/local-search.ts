import { type CancerSite } from "@/domain/schemas";
import { getDatabase, type SqliteDatabase } from "@/server/db";
import { LocalEmbeddingClient } from "./local-embedding";
import { knowledgeCitationSchema, type KnowledgeCitation } from "./citation";

type LocalSearchOptions = {
  query: string;
  cancerSite?: CancerSite;
  tags?: string[];
  limit: number;
  version?: string;
};

type LocalChunkRow = {
  chunk_id: string;
  source_id: string;
  source_title: string;
  source_type: string;
  cancer_site_scope_json: string;
  evidence_level: string;
  review_status: string;
  publish_date: string;
  original_path: string;
  knowledge_version: string;
  heading_path: string;
  page_start: number | null;
  page_end: number | null;
  text_chunk: string;
  embedding_json: string | null;
  lexical_score: number | null;
  structured_tags: string;
};

const RRF_K = 60;

export async function searchLocalKnowledgeChunks(
  options: LocalSearchOptions,
  database: SqliteDatabase = getDatabase(),
  embeddingClient = new LocalEmbeddingClient(),
): Promise<KnowledgeCitation[]> {
  const lexicalRows = findLexicalCandidates(database, options);
  const allRows = findVersionCandidates(database, options);
  if (lexicalRows.length === 0 && allRows.length === 0) return [];

  let vectorRows: Array<{ row: LocalChunkRow; score: number }> = [];
  try {
    const [queryVector] = await embeddingClient.embed([options.query], "query");
    vectorRows = allRows
      .filter((row): row is LocalChunkRow & { embedding_json: string } => row.embedding_json !== null)
      .map((row) => ({ row, score: cosineSimilarity(queryVector, parseVector(row.embedding_json)) }))
      .filter((item) => Number.isFinite(item.score))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(options.limit * 4, 20));
  } catch {
    // A local model outage must leave lexical retrieval available and visible through null vector ranks.
  }

  const lexicalRank = new Map(lexicalRows.map((row, index) => [row.chunk_id, index + 1]));
  const vectorRank = new Map(vectorRows.map((item, index) => [item.row.chunk_id, index + 1]));
  const candidates = new Map<string, LocalChunkRow>();
  for (const row of lexicalRows) candidates.set(row.chunk_id, row);
  for (const item of vectorRows) candidates.set(item.row.chunk_id, item.row);

  return [...candidates.values()]
    .map((row) => {
      const lexical = lexicalRank.get(row.chunk_id);
      const vector = vectorRank.get(row.chunk_id);
      const score = (lexical ? 1 / (RRF_K + lexical) : 0) + (vector ? 1 / (RRF_K + vector) : 0);
      return toKnowledgeCitation(row, score, options.query);
    })
    .sort((left, right) => right.score - left.score || left.citation_id.localeCompare(right.citation_id))
    .slice(0, options.limit);
}

export function loadLocalKnowledgeCitationsByIds(
  citationIds: Iterable<string>,
  database: SqliteDatabase = getDatabase(),
): KnowledgeCitation[] {
  const ids = [...new Set(citationIds)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = database.prepare(
    `
    SELECT c.chunk_id, d.source_id, d.source_title, d.source_type, d.cancer_site_scope_json,
           d.evidence_level, d.review_status, d.publish_date, d.original_path,
           dv.knowledge_version, c.heading_path, c.page_start, c.page_end, c.text_chunk,
           NULL AS embedding_json, NULL AS lexical_score, COALESCE(f.structured_tags, '[]') AS structured_tags
    FROM knowledge_chunks c
    JOIN knowledge_document_versions dv ON dv.document_version_id = c.document_version_id
    JOIN knowledge_documents d ON d.document_id = dv.document_id
    LEFT JOIN knowledge_chunk_fts f ON f.chunk_id = c.chunk_id
    WHERE c.chunk_id IN (${placeholders})
      AND dv.status = 'completed'
      AND d.review_status IN ('approved', 'clinician_reviewed')
    ORDER BY c.chunk_id ASC
    `,
  ).all(...ids) as LocalChunkRow[];
  return rows.map((row) => toKnowledgeCitation(row, 0, ""));
}

function findLexicalCandidates(database: SqliteDatabase, options: LocalSearchOptions): LocalChunkRow[] {
  const match = toFtsQuery(options.query, options.tags ?? []);
  if (!match) return [];
  const rows = database.prepare(
    `
    SELECT f.chunk_id, d.source_id, d.source_title, d.source_type, d.cancer_site_scope_json,
           d.evidence_level, d.review_status, d.publish_date, d.original_path,
           dv.knowledge_version, c.heading_path, c.page_start, c.page_end, c.text_chunk,
           e.embedding_json, bm25(knowledge_chunk_fts) AS lexical_score, f.structured_tags
    FROM knowledge_chunk_fts f
    JOIN knowledge_chunks c ON c.chunk_id = f.chunk_id
    JOIN knowledge_document_versions dv ON dv.document_version_id = c.document_version_id
    JOIN knowledge_documents d ON d.document_id = dv.document_id
    LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.chunk_id AND e.embedding_model = ?
    WHERE knowledge_chunk_fts MATCH ?
      AND dv.status = 'completed'
      AND d.review_status IN ('approved', 'clinician_reviewed')
      ${options.version ? "AND dv.knowledge_version = ?" : ""}
    ORDER BY lexical_score ASC, c.chunk_id ASC
    LIMIT ?
    `,
  ).all(
    embeddingModel(),
    match,
    ...(options.version ? [options.version] : []),
    Math.max(options.limit * 4, 20),
  ) as LocalChunkRow[];
  return filterScope(rows, options.cancerSite);
}

function findVersionCandidates(database: SqliteDatabase, options: LocalSearchOptions): LocalChunkRow[] {
  const rows = database.prepare(
    `
    SELECT c.chunk_id, d.source_id, d.source_title, d.source_type, d.cancer_site_scope_json,
           d.evidence_level, d.review_status, d.publish_date, d.original_path,
           dv.knowledge_version, c.heading_path, c.page_start, c.page_end, c.text_chunk,
           e.embedding_json, NULL AS lexical_score, COALESCE(f.structured_tags, '[]') AS structured_tags
    FROM knowledge_chunks c
    JOIN knowledge_document_versions dv ON dv.document_version_id = c.document_version_id
    JOIN knowledge_documents d ON d.document_id = dv.document_id
    LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.chunk_id AND e.embedding_model = ?
    LEFT JOIN knowledge_chunk_fts f ON f.chunk_id = c.chunk_id
    WHERE dv.status = 'completed'
      AND d.review_status IN ('approved', 'clinician_reviewed')
      ${options.version ? "AND dv.knowledge_version = ?" : ""}
    ORDER BY c.chunk_id ASC
    LIMIT 500
    `,
  ).all(embeddingModel(), ...(options.version ? [options.version] : [])) as LocalChunkRow[];
  return filterScope(rows, options.cancerSite);
}

function filterScope(rows: LocalChunkRow[], cancerSite: CancerSite | undefined): LocalChunkRow[] {
  if (!cancerSite || cancerSite === "unknown") return rows;
  return rows.filter((row) => JSON.parse(row.cancer_site_scope_json).includes(cancerSite));
}

function toFtsQuery(query: string, tags: string[]): string | null {
  const terms = [...new Set(`${query} ${tags.join(" ")}`.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))].slice(0, 12);
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") : null;
}

function matchedTerms(query: string, row: LocalChunkRow): string[] {
  const haystack = `${row.source_title}\n${row.text_chunk}\n${row.structured_tags}`.toLocaleLowerCase("zh-CN");
  return [...new Set(query.split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))]
    .filter((term) => haystack.includes(term.toLocaleLowerCase("zh-CN")));
}

function toKnowledgeCitation(row: LocalChunkRow, score: number, query: string): KnowledgeCitation {
  return knowledgeCitationSchema.parse({
    id: row.chunk_id,
    chunk_id: row.chunk_id,
    cancer_site_scope: JSON.parse(row.cancer_site_scope_json),
    evidence_level: row.evidence_level,
    text_chunk: row.text_chunk,
    structured_tags: JSON.parse(row.structured_tags),
    version: row.knowledge_version,
    source_id: row.source_id,
    source_title: row.source_title,
    source_type: row.source_type,
    publish_date: row.publish_date,
    review_status: row.review_status,
    citation_id: row.chunk_id,
    score,
    matched_keywords: query ? matchedTerms(query, row) : [],
  });
}

function parseVector(value: string): number[] {
  const vector: unknown = JSON.parse(value);
  if (!Array.isArray(vector) || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("Invalid persisted embedding vector");
  }
  return vector;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function embeddingModel(): string {
  return process.env.LOCAL_EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B";
}
