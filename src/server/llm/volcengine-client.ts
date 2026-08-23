import { modelCallPolicies, type ModelCallPath } from "./model-paths";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export interface VolcengineChatClient {
  isConfigured(): boolean;
  complete(messages: ChatMessage[], path: ModelCallPath): Promise<string>;
  completeJson(messages: ChatMessage[]): Promise<string>;
}

export function createVolcengineChatClient(): VolcengineChatClient {
  const apiKey = process.env.VOLCENGINE_API_KEY;
  const model = process.env.VOLCENGINE_MODEL;
  const endpoint =
    process.env.VOLCENGINE_BASE_URL ??
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions";

  return {
    isConfigured: () => Boolean(apiKey && model),
    async complete(messages, path) {
      if (!apiKey || !model) {
        throw new Error("Volcengine model is not configured.");
      }

      const policy = modelCallPolicies[path];
      const response = await fetch(endpoint, {
        body: JSON.stringify({
          messages,
          model,
          ...(policy.responseFormat === "json_object"
            ? { response_format: { type: "json_object" } }
            : {}),
          temperature: policy.temperature,
        }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Volcengine request failed: ${response.status}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("Volcengine response does not contain content.");
      }

      return content;
    },
    completeJson(messages) {
      return this.complete(messages, "memory_write");
    },
  };
}
