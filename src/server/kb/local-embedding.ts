import { z } from "zod";

const embeddingResponseSchema = z.object({
  model: z.string().min(1),
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      embedding: z.array(z.number().finite()).min(1),
    }),
  ),
});

export type EmbeddingInputType = "document" | "query";

export class LocalEmbeddingClient {
  readonly endpoint: string;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(options: { endpoint?: string; model?: string; timeoutMs?: number } = {}) {
    this.endpoint = (options.endpoint ?? process.env.LOCAL_EMBEDDING_BASE_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
    this.model = options.model ?? process.env.LOCAL_EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B";
    this.timeoutMs = options.timeoutMs ?? Number(process.env.LOCAL_EMBEDDING_TIMEOUT_MS ?? 30_000);
  }

  async healthcheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/health`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(`${this.endpoint}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({ model: this.model, input: texts, input_type: inputType }),
    });

    if (!response.ok) {
      throw new Error(`Local embedding service failed: ${response.status}`);
    }

    const payload = embeddingResponseSchema.parse(await response.json());
    if (payload.data.length !== texts.length) {
      throw new Error("Local embedding service returned an unexpected vector count");
    }

    return payload.data
      .sort((left, right) => left.index - right.index)
      .map((item) => item.embedding);
  }
}
