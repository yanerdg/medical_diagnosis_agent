import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/db";
import { LocalKnowledgeRepository } from "./local-repository";
import {
  loadLocalKnowledgeCitationsByIds,
  searchLocalKnowledgeChunks,
} from "./local-search";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("local hybrid knowledge search", () => {
  it("combines reviewed FTS candidates with local embedding ranks", async () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const repository = new LocalKnowledgeRepository(database);
    const document = repository.saveDocument({
      source_id: "guideline-larynx-2026",
      source_title: "喉癌诊疗指南",
      source_type: "guideline",
      cancer_site_scope: ["larynx"],
      evidence_level: "guideline_consensus",
      review_status: "approved",
      publish_date: "2026-01-01",
      structured_tags: ["分期", "敏感性"],
      original_filename: "guideline.md",
      original_path: "C:/knowledge/guideline.md",
      original_sha256: "a".repeat(64),
    });
    const version = repository.createDocumentVersion({
      document_id: document.document_id,
      knowledge_version: "rag-v1",
      source_sha256: "a".repeat(64),
      parser_name: "markdown",
      parser_version: "v1",
    });
    const chunks = repository.replaceChunks({
      document_version_id: version.document_version_id,
      structured_tags: ["分期", "敏感性"],
      sections: [{ text: "喉癌分期需结合原发灶与淋巴结影像。", heading_path: ["分期"] }],
    });
    repository.saveEmbeddings({
      chunks,
      embedding_model: "Qwen/Qwen3-Embedding-0.6B",
      vectors: [[1, 0]],
    });
    repository.markDocumentVersionCompleted(version.document_version_id);

    const result = await searchLocalKnowledgeChunks(
      { query: "喉癌分期", cancerSite: "larynx", limit: 3 },
      database,
      {
        model: "Qwen/Qwen3-Embedding-0.6B",
        embed: async () => [[1, 0]],
      } as never,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source_id: "guideline-larynx-2026",
      version: "rag-v1",
      review_status: "approved",
      matched_keywords: expect.arrayContaining(["喉癌分期"]),
    });
    expect(result[0].score).toBeGreaterThan(0);

    const reloaded = loadLocalKnowledgeCitationsByIds(
      [result[0].citation_id],
      database,
    );
    expect(reloaded).toMatchObject([
      {
        citation_id: result[0].citation_id,
        source_id: "guideline-larynx-2026",
        review_status: "approved",
      },
    ]);
  });
});
