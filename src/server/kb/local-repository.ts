import { createHash, randomUUID } from "node:crypto";
import { getDatabase, type SqliteDatabase } from "@/server/db";
import {
  knowledgeChunkRecordSchema,
  knowledgeDocumentMetadataSchema,
  type ExtractedKnowledgeSection,
  type KnowledgeChunkRecord,
  type KnowledgeDocumentMetadata,
} from "./local-types";

export type SaveInjectedDocumentParams = KnowledgeDocumentMetadata & {
  original_filename: string;
  original_path: string;
  original_sha256: string;
  created_at?: string;
};

export type CreateKnowledgeDocumentVersionParams = {
  document_id: string;
  knowledge_version: string;
  source_sha256: string;
  parser_name: string;
  parser_version: string;
  created_at?: string;
};

export type ReplaceKnowledgeChunksParams = {
  document_version_id: string;
  sections: ExtractedKnowledgeSection[];
  structured_tags?: string[];
  created_at?: string;
};

export class LocalKnowledgeRepository {
  constructor(private readonly database: SqliteDatabase = getDatabase()) {}

  saveDocument(params: SaveInjectedDocumentParams): { document_id: string } {
    const metadata = knowledgeDocumentMetadataSchema.parse(params);
    const now = params.created_at ?? new Date().toISOString();
    const existing = this.database
      .prepare("SELECT document_id FROM knowledge_documents WHERE source_id = ?")
      .get(metadata.source_id) as { document_id: string } | undefined;
    const documentId = existing?.document_id ?? randomUUID();

    this.database
      .prepare(
        `
        INSERT INTO knowledge_documents (
          document_id, source_id, source_title, source_type,
          cancer_site_scope_json, evidence_level, review_status, publish_date,
          original_filename, original_path, original_sha256, created_at, updated_at
        ) VALUES (
          @document_id, @source_id, @source_title, @source_type,
          @cancer_site_scope_json, @evidence_level, @review_status, @publish_date,
          @original_filename, @original_path, @original_sha256, @created_at, @updated_at
        )
        ON CONFLICT(source_id) DO UPDATE SET
          source_title = excluded.source_title,
          source_type = excluded.source_type,
          cancer_site_scope_json = excluded.cancer_site_scope_json,
          evidence_level = excluded.evidence_level,
          review_status = excluded.review_status,
          publish_date = excluded.publish_date,
          original_filename = excluded.original_filename,
          original_path = excluded.original_path,
          original_sha256 = excluded.original_sha256,
          updated_at = excluded.updated_at
        `,
      )
      .run({
        ...metadata,
        document_id: documentId,
        cancer_site_scope_json: JSON.stringify(metadata.cancer_site_scope),
        original_filename: params.original_filename,
        original_path: params.original_path,
        original_sha256: params.original_sha256,
        created_at: now,
        updated_at: now,
      });

    return { document_id: documentId };
  }

  createDocumentVersion(
    params: CreateKnowledgeDocumentVersionParams,
  ): { document_version_id: string; is_duplicate: boolean } {
    const existing = this.database
      .prepare(
        `
        SELECT document_version_id, status
        FROM knowledge_document_versions
        WHERE document_id = ? AND knowledge_version = ? AND source_sha256 = ?
        `,
      )
      .get(params.document_id, params.knowledge_version, params.source_sha256) as
      | { document_version_id: string; status: "pending" | "processing" | "completed" | "failed" }
      | undefined;

    if (existing) {
      if (existing.status === "completed") {
        return { document_version_id: existing.document_version_id, is_duplicate: true };
      }

      // Failed or interrupted runs are deliberately retryable.  Reusing the same
      // version keeps the audit trail stable while replaceChunks refreshes its data.
      this.database
        .prepare(
          `UPDATE knowledge_document_versions
           SET status = 'pending', error_message = NULL, completed_at = NULL
           WHERE document_version_id = ?`,
        )
        .run(existing.document_version_id);
      return { document_version_id: existing.document_version_id, is_duplicate: false };
    }

    const documentVersionId = randomUUID();
    this.database
      .prepare(
        `
        INSERT INTO knowledge_document_versions (
          document_version_id, document_id, knowledge_version, source_sha256,
          parser_name, parser_version, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
        `,
      )
      .run(
        documentVersionId,
        params.document_id,
        params.knowledge_version,
        params.source_sha256,
        params.parser_name,
        params.parser_version,
        params.created_at ?? new Date().toISOString(),
      );

    return { document_version_id: documentVersionId, is_duplicate: false };
  }

  replaceChunks(params: ReplaceKnowledgeChunksParams): KnowledgeChunkRecord[] {
    const now = params.created_at ?? new Date().toISOString();
    const insert = this.database.transaction(() => {
      const oldChunkIds = this.database
        .prepare("SELECT chunk_id FROM knowledge_chunks WHERE document_version_id = ?")
        .all(params.document_version_id) as Array<{ chunk_id: string }>;

      for (const row of oldChunkIds) {
        this.database.prepare("DELETE FROM knowledge_chunk_fts WHERE chunk_id = ?").run(row.chunk_id);
      }
      this.database
        .prepare("DELETE FROM knowledge_chunks WHERE document_version_id = ?")
        .run(params.document_version_id);

      const chunks = params.sections.map((section, ordinal) =>
        knowledgeChunkRecordSchema.parse({
          chunk_id: randomUUID(),
          document_version_id: params.document_version_id,
          ordinal,
          text: section.text,
          heading_path: section.heading_path,
          page_start: section.page_start,
          page_end: section.page_end,
          content_sha256: sha256(section.text),
          token_estimate: estimateTokens(section.text),
          created_at: now,
        }),
      );

      const insertChunk = this.database.prepare(
        `
        INSERT INTO knowledge_chunks (
          chunk_id, document_version_id, ordinal, heading_path, page_start, page_end,
          text_chunk, content_sha256, token_estimate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      const insertFts = this.database.prepare(
        `INSERT INTO knowledge_chunk_fts (chunk_id, source_title, heading_path, text_chunk, structured_tags)
          SELECT c.chunk_id, d.source_title, c.heading_path, c.text_chunk, ?
         FROM knowledge_chunks c
         JOIN knowledge_document_versions dv ON dv.document_version_id = c.document_version_id
         JOIN knowledge_documents d ON d.document_id = dv.document_id
         WHERE c.chunk_id = ?`,
      );

      for (const chunk of chunks) {
        insertChunk.run(
          chunk.chunk_id,
          chunk.document_version_id,
          chunk.ordinal,
          JSON.stringify(chunk.heading_path),
          chunk.page_start ?? null,
          chunk.page_end ?? null,
          chunk.text,
          chunk.content_sha256,
          chunk.token_estimate,
          chunk.created_at,
        );
        insertFts.run(JSON.stringify(params.structured_tags ?? []), chunk.chunk_id);
      }

      this.database
        .prepare(
          `UPDATE knowledge_document_versions
           SET status = 'processing', error_message = NULL, completed_at = NULL
           WHERE document_version_id = ?`,
        )
        .run(params.document_version_id);

      return chunks;
    });

    return insert();
  }

  saveEmbeddings(params: {
    chunks: KnowledgeChunkRecord[];
    embedding_model: string;
    vectors: number[][];
    created_at?: string;
  }): void {
    if (params.chunks.length !== params.vectors.length) {
      throw new Error("Embedding vector count does not match knowledge chunk count");
    }
    const now = params.created_at ?? new Date().toISOString();
    const save = this.database.transaction(() => {
      const statement = this.database.prepare(
        `
        INSERT INTO knowledge_embeddings (
          chunk_id, embedding_model, embedding_dimension, embedding_json,
          embedded_content_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id, embedding_model) DO UPDATE SET
          embedding_dimension = excluded.embedding_dimension,
          embedding_json = excluded.embedding_json,
          embedded_content_sha256 = excluded.embedded_content_sha256,
          created_at = excluded.created_at
        `,
      );
      for (const [index, chunk] of params.chunks.entries()) {
        const vector = params.vectors[index];
        if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
          throw new Error(`Invalid embedding vector for chunk ${chunk.chunk_id}`);
        }
        statement.run(
          chunk.chunk_id,
          params.embedding_model,
          vector.length,
          JSON.stringify(vector),
          chunk.content_sha256,
          now,
        );
      }
    });
    save();
  }

  markDocumentVersionCompleted(documentVersionId: string): void {
    this.database
      .prepare(
        `UPDATE knowledge_document_versions
         SET status = 'completed', error_message = NULL, completed_at = ?
         WHERE document_version_id = ?`,
      )
      .run(new Date().toISOString(), documentVersionId);
  }

  createIngestionRun(params: {
    document_id?: string;
    knowledge_version: string;
    requested_by?: string;
    started_at?: string;
  }): string {
    const ingestionRunId = randomUUID();
    this.database.prepare(
      `
      INSERT INTO knowledge_ingestion_runs (
        ingestion_run_id, document_id, knowledge_version, status,
        requested_by, summary_json, started_at
      ) VALUES (?, ?, ?, 'processing', ?, '{}', ?)
      `,
    ).run(
      ingestionRunId,
      params.document_id ?? null,
      params.knowledge_version,
      params.requested_by ?? null,
      params.started_at ?? new Date().toISOString(),
    );
    return ingestionRunId;
  }

  completeIngestionRun(params: {
    ingestion_run_id: string;
    status: "completed" | "failed" | "skipped_duplicate";
    summary: Record<string, unknown>;
    error_message?: string;
    completed_at?: string;
  }): void {
    this.database.prepare(
      `
      UPDATE knowledge_ingestion_runs
      SET status = ?, summary_json = ?, error_message = ?, completed_at = ?
      WHERE ingestion_run_id = ?
      `,
    ).run(
      params.status,
      JSON.stringify(params.summary),
      params.error_message ?? null,
      params.completed_at ?? new Date().toISOString(),
      params.ingestion_run_id,
    );
  }

  markDocumentVersionFailed(documentVersionId: string, errorMessage: string): void {
    this.database.prepare(
      `UPDATE knowledge_document_versions
       SET status = 'failed', error_message = ?, completed_at = ?
       WHERE document_version_id = ?`,
    ).run(errorMessage, new Date().toISOString(), documentVersionId);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateTokens(value: string): number {
  return Math.ceil(value.trim().length / 2);
}
