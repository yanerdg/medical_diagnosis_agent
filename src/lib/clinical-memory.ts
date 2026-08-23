import type { CaseInputType, CaseRecord } from "@/domain/schemas";

export interface ClinicalMemoryInput {
  inputId: string;
  inputType: CaseInputType;
  rawText: string;
  submittedAt: string;
}

export interface ClinicalMemoryQuestion {
  id: string;
  question: string;
  clinicalPurpose: string;
}

export interface ClinicalMemoryAnswer {
  questionId: string;
  answerText?: string;
  markedUnknown: boolean;
}

export interface ClinicalMemoryRound {
  requestId: string;
  reason: string;
  createdAt: string;
  questions: ClinicalMemoryQuestion[];
  answers: ClinicalMemoryAnswer[];
}

export interface PatientMemoryCategory {
  id: string;
  label: string;
  summary: string;
  items: string[];
}

export interface PatientMemory {
  categories: PatientMemoryCategory[];
  generatedAt: string;
  inputCount: number;
}

export interface BuildPatientMemoryParams {
  caseRecord: Pick<CaseRecord, "display_name" | "patient_ref" | "status" | "updated_at">;
  inputs: ClinicalMemoryInput[];
  agentRounds: ClinicalMemoryRound[];
}

export function buildPatientMemory({
  agentRounds,
  caseRecord,
  inputs,
}: BuildPatientMemoryParams): PatientMemory {
  const categories = new Map<string, PatientMemoryCategory>();

  for (const input of inputs) {
    const definition = categoryDefinitionForInput(input.inputType);
    const extractedItems = extractClinicalItems(input.rawText, input.inputType);

    upsertCategory(categories, {
      ...definition,
      items:
        extractedItems.length > 0
          ? extractedItems
          : [`${definition.label} materials received; further structuring is pending.`],
    });
  }

  const missingItems = buildMissingItems(inputs, agentRounds);
  if (missingItems.length > 0) {
    upsertCategory(categories, {
      id: "missing",
      items: missingItems,
      label: "Missing Information",
      summary:
        "Key evidence gaps that still affect the current diagnosis or treatment decision.",
    });
  }

  return {
    categories: [...categories.values()].sort(
      (left, right) => memoryCategoryOrder(left.id) - memoryCategoryOrder(right.id),
    ),
    generatedAt: caseRecord.updated_at,
    inputCount: inputs.length,
  };
}

function categoryDefinitionForInput(inputType: CaseInputType): Omit<
  PatientMemoryCategory,
  "items"
> {
  const definitions: Record<
    CaseInputType,
    Omit<PatientMemoryCategory, "items">
  > = {
    clinician_note: {
      id: "history",
      label: "Illness History and Current Course",
      summary:
        "Summarizes chief concerns, physical findings, symptom evolution, and clinical priorities.",
    },
    ct_report: {
      id: "ct",
      label: "CT Summary",
      summary:
        "Summarizes imaging information for TNM staging and local invasion assessment.",
    },
    pathology_biomarker: {
      id: "pathology",
      label: "Pathology and Molecular Biomarkers",
      summary:
        "Supports diagnosis confirmation, treatment sensitivity assessment, and therapeutic direction.",
    },
    lab_report: {
      id: "labs",
      label: "Monitoring Markers and Baseline Labs",
      summary:
        "Organizes baseline labs into pre-treatment assessment and on-treatment monitoring markers.",
    },
    treatment_history: {
      id: "treatment",
      label: "Treatment History, Tolerance, and Resistance",
      summary:
        "Supports assessment of retreatment risk, prior tolerance, and potential resistance.",
    },
    demographics: {
      id: "profile",
      label: "Basic Information",
      summary:
          "Patient clinical profile variables such as age, sex, height, weight, smoking or alcohol history, ECOG, nutrition, and baseline status.",
    },
    other: {
      id: "other",
      label: "Other Information Pending Classification",
      summary: "Captures clinical information that has not yet been stably classified.",
    },
  };

  return definitions[inputType];
}

function buildMissingItems(
  inputs: ClinicalMemoryInput[],
  agentRounds: ClinicalMemoryRound[],
): string[] {
  const inputTypes = new Set(inputs.map((input) => input.inputType));
  const missingItems: string[] = [];

  if (!inputTypes.has("ct_report")) {
    missingItems.push(
      "CT or imaging summary is missing; local invasion and TNM staging cannot yet be assessed reliably.",
    );
  }
  if (!inputTypes.has("pathology_biomarker")) {
    missingItems.push(
      "Pathology or biomarker results are missing; treatment sensitivity assessment remains incomplete.",
    );
  }
  if (!inputTypes.has("lab_report")) {
    missingItems.push(
      "Baseline laboratory reports are missing; cisplatin and chemoradiotherapy tolerance require cautious assessment.",
    );
  }

  for (const round of agentRounds) {
    const answerByQuestion = new Map(
      round.answers.map((answer) => [answer.questionId, answer] as const),
    );

    for (const question of round.questions) {
      const answer = answerByQuestion.get(question.id);
      if (!answer || answer.markedUnknown) {
        missingItems.push(`To be confirmed: ${question.question}`);
      }
    }
  }

  return unique(missingItems);
}

function extractClinicalItems(
  rawText: string,
  inputType: CaseInputType,
): string[] {
  if (inputType === "demographics") {
    const item = normalizeClinicalText(rawText, 240);

    return item ? [item] : [];
  }

  return splitClinicalText(rawText).slice(0, 3);
}

function splitClinicalText(rawText: string): string[] {
  return normalizeClinicalText(rawText, rawText.length)
    .split(/(?<=[。！？；;])|(?<=\.)\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => (item.length > 120 ? `${item.slice(0, 118)}...` : item));
}

function normalizeClinicalText(rawText: string, limit: number): string {
  const normalized = rawText.replace(/\s+/g, " ").trim();

  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(limit - 3, 0))}...`
    : normalized;
}

function upsertCategory(
  categories: Map<string, PatientMemoryCategory>,
  nextCategory: PatientMemoryCategory,
) {
  const existingCategory = categories.get(nextCategory.id);

  if (existingCategory) {
    existingCategory.items = unique([
      ...existingCategory.items,
      ...nextCategory.items,
    ]);
  } else {
    categories.set(nextCategory.id, {
      ...nextCategory,
      items: unique(nextCategory.items),
    });
  }
}

function memoryCategoryOrder(categoryId: string): number {
  const order = [
    "profile",
    "history",
    "ct",
    "pathology",
    "labs",
    "treatment",
    "missing",
    "other",
  ];
  const index = order.indexOf(categoryId);

  return index === -1 ? order.length : index;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
