import path from "node:path";
import { LocalEmbeddingClient } from "./local-embedding";
import { chunkKnowledgeSections, parseKnowledgeDocument } from "./ingestion";
import { LocalKnowledgeRepository } from "./local-repository";
import { knowledgeDocumentMetadataSchema, type KnowledgeDocumentMetadata } from "./local-types";

export type IngestKnowledgeDocumentParams = {
  file_path: string;
  metadata: KnowledgeDocumentMetadata;
  knowledge_version: string;
  requested_by?: string;
};

export type KnowledgeIngestionResult = {
  ingestion_run_id: string;
  document_id: string;
  document_version_id?: string;
  status: "completed" | "failed" | "skipped_duplicate";
  chunk_count: number;
  embedding_model?: string;
  error_message?: string;
};

export async function ingestKnowledgeDocument(
  params: IngestKnowledgeDocumentParams,
  options: {
    repository?: LocalKnowledgeRepository;
    embeddingClient?: LocalEmbeddingClient;
  } = {},
): Promise<KnowledgeIngestionResult> {
  const repository = options.repository ?? new LocalKnowledgeRepository();
  const embeddingClient = options.embeddingClient ?? new LocalEmbeddingClient();
  const metadata = knowledgeDocumentMetadataSchema.parse(params.metadata);
  const parsed = await parseKnowledgeDocument(params.file_path);
  const document = repository.saveDocument({
    ...metadata,
    original_filename: path.basename(params.file_path),
    original_path: params.file_path,
    original_sha256: parsed.source_sha256,
  });
  const ingestionRunId = repository.createIngestionRun({
    document_id: document.document_id,
    knowledge_version: params.knowledge_version,
    requested_by: params.requested_by,
  });
  let documentVersionId: string | undefined;

  try {
    const version = repository.createDocumentVersion({
      document_id: document.document_id,
      knowledge_version: params.knowledge_version,
      source_sha256: parsed.source_sha256,
      parser_name: parsed.file_type,
      parser_version: "v1",
    });
    documentVersionId = version.document_version_id;
    if (version.is_duplicate) {
      repository.completeIngestionRun({
        ingestion_run_id: ingestionRunId,
        status: "skipped_duplicate",
        summary: { document_version_id: version.document_version_id },
      });
      return {
        ingestion_run_id: ingestionRunId,
        document_id: document.document_id,
        document_version_id: version.document_version_id,
        status: "skipped_duplicate",
        chunk_count: 0,
      };
    }

    const chunks = repository.replaceChunks({
      document_version_id: version.document_version_id,
      sections: chunkKnowledgeSections(parsed.sections),
      structured_tags: metadata.structured_tags,
    });
    const vectors = await embedInBatches(embeddingClient, chunks.map((chunk) => chunk.text));
    repository.saveEmbeddings({
      chunks,
      embedding_model: embeddingClient.model,
      vectors,
    });
    repository.markDocumentVersionCompleted(version.document_version_id);
    repository.completeIngestionRun({
      ingestion_run_id: ingestionRunId,
      status: "completed",
      summary: { chunk_count: chunks.length, embedding_model: embeddingClient.model },
    });
    return {
      ingestion_run_id: ingestionRunId,
      document_id: document.document_id,
      document_version_id: version.document_version_id,
      status: "completed",
      chunk_count: chunks.length,
      embedding_model: embeddingClient.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown knowledge ingestion failure";
    if (documentVersionId) {
      repository.markDocumentVersionFailed(documentVersionId, message);
    }
    repository.completeIngestionRun({
      ingestion_run_id: ingestionRunId,
      status: "failed",
      summary: {},
      error_message: message,
    });
    return {
      ingestion_run_id: ingestionRunId,
      document_id: document.document_id,
      status: "failed",
      chunk_count: 0,
      error_message: message,
    };
  }
}

async function embedInBatches(client: LocalEmbeddingClient, texts: string[]): Promise<number[][]> {
  const batchSize = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE ?? 16);
  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    vectors.push(...(await client.embed(texts.slice(offset, offset + batchSize), "document")));
  }
  return vectors;
}
