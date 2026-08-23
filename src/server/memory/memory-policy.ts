import type {
  ClinicalMemoryInput,
  ClinicalMemoryRound,
  PatientMemory,
  PatientMemoryCategory,
} from "@/lib/clinical-memory";

export type MemoryCandidateSource = "case_input" | "clinician_answer";

export interface MemoryWriteCandidate {
  id: string;
  source: MemoryCandidateSource;
  categoryHint: string;
  text: string;
}

export interface MemoryGapCandidate {
  id: string;
  question: string;
  clinicalPurpose: string;
}

export interface RestrictedMemoryWriteContext {
  candidates: MemoryWriteCandidate[];
  gaps: MemoryGapCandidate[];
}

export function buildRestrictedMemoryWriteContext({
  agentRounds,
  inputs,
}: {
  agentRounds: ClinicalMemoryRound[];
  inputs: ClinicalMemoryInput[];
}): RestrictedMemoryWriteContext {
  const candidates: MemoryWriteCandidate[] = inputs
    .filter((input) => input.rawText.trim().length > 0)
    .map((input) => ({
      categoryHint: input.inputType,
      id: `input:${input.inputId}`,
      source: "case_input",
      text: input.rawText.trim(),
    }));
  const gaps: MemoryGapCandidate[] = [];

  for (const round of agentRounds) {
    const answerByQuestion = new Map(
      round.answers.map((answer) => [answer.questionId, answer] as const),
    );

    for (const question of round.questions) {
      const answer = answerByQuestion.get(question.id);

      if (answer?.answerText && !answer.markedUnknown) {
        candidates.push({
          categoryHint: question.clinicalPurpose,
          id: `answer:${round.requestId}:${question.id}`,
          source: "clinician_answer",
          text: answer.answerText.trim(),
        });
      } else {
        gaps.push({
          clinicalPurpose: question.clinicalPurpose,
          id: `gap:${round.requestId}:${question.id}`,
          question: question.question,
        });
      }
    }
  }

  return {
    candidates,
    gaps,
  };
}

export function recallPatientMemory(
  memory: PatientMemory,
  query: string,
): PatientMemoryCategory[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return memory.categories.slice(0, 4);
  }

  if (isBroadClinicalWorkupQuery(normalizedQuery)) {
    return recallCoreClinicalContext(memory);
  }

  const matchedCategories = memory.categories.filter((category) => {
    const haystack = [
      category.label,
      category.summary,
      ...category.items,
    ]
      .join("\n")
      .toLowerCase();

    return normalizedQuery
      .split(/\s+/)
      .some((token) => token.length > 0 && haystack.includes(token));
  });

  return matchedCategories.length > 0
    ? matchedCategories
    : memory.categories.slice(0, 3);
}

function isBroadClinicalWorkupQuery(normalizedQuery: string): boolean {
  return /还需要|需要什么|要什么|补充什么|哪些检查|什么检查|哪些报告|什么报告|检验|检查|化验|报告|资料|workup|evaluation|test|tests|report|reports|lab|labs/.test(
    normalizedQuery,
  );
}

function recallCoreClinicalContext(
  memory: PatientMemory,
): PatientMemoryCategory[] {
  const preferredCategoryIds = [
    "profile",
    "history",
    "pending-history",
    "ct",
    "pending-imaging",
    "pathology",
    "pending-pathology",
    "labs",
    "pending-labs",
    "treatment",
    "pending-treatment",
    "missing",
    "other",
    "pending-other",
  ];
  const categoryById = new Map(
    memory.categories.map((category) => [category.id, category]),
  );
  const preferredCategories = preferredCategoryIds
    .map((categoryId) => categoryById.get(categoryId))
    .filter((category): category is PatientMemoryCategory => Boolean(category));

  return preferredCategories.length > 0
    ? preferredCategories.slice(0, 8)
    : memory.categories.slice(0, 4);
}
