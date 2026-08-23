export type ModelCallPath = "dialog" | "memory_write";

export interface ModelCallPolicy {
  path: ModelCallPath;
  temperature: number;
  responseFormat: "json_object" | "text";
}

export const modelCallPolicies: Record<ModelCallPath, ModelCallPolicy> = {
  dialog: {
    path: "dialog",
    responseFormat: "json_object",
    temperature: 0.3,
  },
  memory_write: {
    path: "memory_write",
    responseFormat: "json_object",
    temperature: 0.1,
  },
};
