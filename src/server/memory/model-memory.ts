import {
  buildPatientMemory,
  type BuildPatientMemoryParams,
  type PatientMemory,
  type PatientMemoryCategory,
} from "@/lib/clinical-memory";
import { createVolcengineChatClient } from "@/server/llm/volcengine-client";
import { buildRestrictedMemoryWriteContext } from "./memory-policy";
import { z } from "zod";

const patientMemoryCategorySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    summary: z.string().min(1),
    items: z.array(z.string().min(1)).min(1).max(5),
  })
  .strict();

const patientMemoryModelOutputSchema = z
  .object({
    categories: z.array(patientMemoryCategorySchema).min(1).max(8),
  })
  .strict();

export interface BuildPatientMemoryWithModelResult {
  memory: PatientMemory;
  mode: "model" | "deterministic" | "fallback";
}

export async function buildPatientMemoryWithModel(
  params: BuildPatientMemoryParams,
): Promise<BuildPatientMemoryWithModelResult> {
  const fallbackMemory = buildPatientMemory(params);
  const client = createVolcengineChatClient();

  if (!client.isConfigured()) {
    return { memory: fallbackMemory, mode: "deterministic" };
  }

  try {
    const rawOutput = await client.completeJson([
      {
        role: "system",
        content: PATIENT_MEMORY_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildPatientMemoryUserPrompt(params),
      },
    ]);
    const parsed = patientMemoryModelOutputSchema.parse(
      JSON.parse(extractJsonObject(rawOutput)),
    );

    return {
      memory: {
          categories: normalizeCategories(parsed.categories, params.caseRecord),
        generatedAt: new Date().toISOString(),
        inputCount: params.inputs.length,
      },
      mode: "model",
    };
  } catch {
    return { memory: fallbackMemory, mode: "fallback" };
  }
}

const PATIENT_MEMORY_SYSTEM_PROMPT = `
You are the clinical memory organizer for a throat cancer diagnosis agent.

Task: organize the restricted write candidates into readable patient clinical memory.

Strict requirements:
1. Output only a JSON object. Do not output Markdown or explanations.
2. Summarize clinically; do not copy raw text verbatim unless a value or diagnosis must remain exact.
3. Do not write process fields such as source labels, clinician supplement labels, or initial-material labels.
4. Do not invent key laboratory values. If the source lacks a value, write "not clearly documented".
5. Each category must be a stable clinical topic, not a chronological log.
6. Items must be real organized case facts, not placeholders.
7. Only memory_write_context.candidates may become patient memory.
8. memory_write_context.gaps may only be used for the missing category; gaps are not factual memory.
9. Do not turn Agent questions, reasoning, or full conversation history into long-term memory.
10. Items must not repeat the category name and must not start with template prefixes such as "Course point:", "Imaging point:", or "Pathology point:".
11. Do not write system metadata into clinical memory. Never include case name, patient reference, case status, case id, updated time, or workflow state as category items.
12. The profile / Basic Information category is only for patient clinical variables: age, sex, height, weight, smoking or alcohol history, ECOG performance status, nutrition, and baseline functional status.

JSON format:
{
  "categories": [
    {
      "id": "history",
      "label": "Illness History and Current Course",
      "summary": "One sentence explaining why this topic matters for the current case",
      "items": ["Specific, readable clinical facts based on the case text"]
    }
  ]
}

Recommended category ids:
profile, history, ct, pathology, labs, treatment, drug_options, missing
`.trim();

function buildPatientMemoryUserPrompt({
  agentRounds,
  caseRecord,
  inputs,
}: BuildPatientMemoryParams): string {
  const memoryWriteContext = buildRestrictedMemoryWriteContext({
    agentRounds,
    inputs,
  });

  return JSON.stringify(
    {
      case: {
        display_name: caseRecord.display_name,
        patient_ref: caseRecord.patient_ref,
        status: caseRecord.status,
        updated_at: caseRecord.updated_at,
      },
      memory_write_context: memoryWriteContext,
    },
    null,
    2,
  );
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found.");
  }

  return value.slice(start, end + 1);
}

function normalizeCategories(
  categories: PatientMemoryCategory[],
  caseRecord: BuildPatientMemoryParams["caseRecord"],
): PatientMemoryCategory[] {
  return categories
    .map((category) => ({
      ...normalizeCategoryMetadata(category),
      items: unique(
        category.items.filter(
          (item) => !isSystemMetadataMemoryItem(item, caseRecord),
        ),
      ).slice(0, 5),
    }))
    .filter((category) => category.items.length > 0);
}

function normalizeCategoryMetadata(
  category: PatientMemoryCategory,
): PatientMemoryCategory {
  if (category.id !== "profile") {
    return category;
  }

  return {
    ...category,
    label: "Basic Information",
    summary:
      "Patient clinical profile variables such as age, sex, height, weight, smoking or alcohol history, ECOG, nutrition, and baseline status.",
  };
}

function isSystemMetadataMemoryItem(
  item: string,
  caseRecord: BuildPatientMemoryParams["caseRecord"],
): boolean {
  const normalized = item.trim().toLowerCase();
  const systemMetadataLabelPattern =
    /^(case name|case display name|case id|case reference|patient reference|patient\/case|case status|status|last updated|updated at|workflow state)\s*:/i;

  if (systemMetadataLabelPattern.test(item.trim())) {
    return true;
  }

  const displayName = caseRecord.display_name.trim().toLowerCase();
  const patientReference = caseRecord.patient_ref?.trim().toLowerCase();
  const caseStatus = caseRecord.status.trim().toLowerCase();

  return (
    normalized === displayName ||
    normalized === patientReference ||
    normalized === caseStatus
  );
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
