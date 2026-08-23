import type { CaseInput, CaseInputType } from "@/domain/schemas";
import type { PatientMemory, PatientMemoryCategory } from "@/lib/clinical-memory";
import type { MedicalRepository } from "@/server/repositories";
import type {
  PendingRoughMemoryBucket,
  PendingRoughMemoryItem,
} from "@/server/repositories/types";

const ROUGH_CONTENT_LIMIT = 500;

const bucketDefinitions: Record<
  PendingRoughMemoryBucket,
  Omit<PatientMemoryCategory, "items">
> = {
  history: {
    id: "pending-history",
    label: "Pending History",
    summary:
      "Clinician-authored history or symptom details awaiting formal memory compaction.",
  },
  imaging: {
    id: "pending-imaging",
    label: "Pending Imaging",
    summary:
      "Clinician-authored imaging details awaiting formal memory compaction.",
  },
  labs: {
    id: "pending-labs",
    label: "Pending Labs",
    summary:
      "Clinician-authored laboratory or monitoring details awaiting formal memory compaction.",
  },
  other: {
    id: "pending-other",
    label: "Pending Other Information",
    summary:
      "Clinician-authored details awaiting stable clinical classification during compaction.",
  },
  pathology: {
    id: "pending-pathology",
    label: "Pending Pathology and Biomarkers",
    summary:
      "Clinician-authored pathology or biomarker details awaiting formal memory compaction.",
  },
  profile: {
    id: "profile",
    label: "Basic Information",
    summary:
      "Pending patient clinical profile variables such as age, sex, height, weight, smoking or alcohol history, ECOG, nutrition, and baseline status.",
  },
  treatment: {
    id: "pending-treatment",
    label: "Pending Treatment",
    summary:
      "Clinician-authored treatment history or tolerance details awaiting formal memory compaction.",
  },
};

const directInputTypeBuckets: Record<CaseInputType, PendingRoughMemoryBucket> = {
  clinician_note: "history",
  ct_report: "imaging",
  demographics: "profile",
  lab_report: "labs",
  other: "other",
  pathology_biomarker: "pathology",
  treatment_history: "treatment",
};

const keywordBuckets: Array<{
  bucket: PendingRoughMemoryBucket;
  patterns: RegExp[];
}> = [
  {
    bucket: "imaging",
    patterns: [/\b(ct|mri|pet|ultrasound|imaging|node|invasion)\b/i],
  },
  {
    bucket: "pathology",
    patterns: [
      /\b(pathology|biopsy|squamous|carcinoma|p16|hpv|ebv|ihc)\b/i,
    ],
  },
  {
    bucket: "labs",
    patterns: [
      /\b(hgb|hb|wbc|anc|platelet|plt|creatinine|albumin|alt|ast|lab)\b/i,
    ],
  },
  {
    bucket: "treatment",
    patterns: [
      /\b(cisplatin|chemo|chemotherapy|radiotherapy|immunotherapy|surgery|treatment)\b/i,
    ],
  },
  {
    bucket: "profile",
    patterns: [
      /\b(age|sex|gender|male|female|height|weight|smoking|alcohol|ecog|nutrition|baseline|performance status)\b/i,
    ],
  },
];

export function classifyPendingRoughMemoryBucket({
  inputType,
  rawText,
}: {
  inputType: CaseInputType;
  rawText: string;
}): PendingRoughMemoryBucket {
  if (inputType !== "clinician_note" && inputType !== "other") {
    return directInputTypeBuckets[inputType];
  }

  for (const candidate of keywordBuckets) {
    if (candidate.patterns.some((pattern) => pattern.test(rawText))) {
      return candidate.bucket;
    }
  }

  return directInputTypeBuckets[inputType];
}

export function createPendingRoughMemoryForCaseInput({
  input,
  rawText,
  repository,
}: {
  input: CaseInput;
  rawText: string;
  repository: MedicalRepository;
}): PendingRoughMemoryItem {
  return repository.createPendingRoughMemoryItem({
    bucket: classifyPendingRoughMemoryBucket({
      inputType: input.input_type,
      rawText,
    }),
    case_id: input.case_id,
    content: normalizeRoughContent(rawText),
    created_at: input.submitted_at,
    source_case_input_id: input.input_id,
  });
}

export function mergePatientMemoryWithPendingRoughMemory(
  memory: PatientMemory,
  pendingItems: PendingRoughMemoryItem[],
): PatientMemory {
  if (pendingItems.length === 0) {
    return memory;
  }

  const categories = new Map(
    memory.categories.map((category) => [
      category.id,
      {
        ...category,
        items: [...category.items],
      },
    ]),
  );

  for (const item of pendingItems) {
    const definition = bucketDefinitions[item.bucket];
    const existing = categories.get(definition.id);

    if (existing) {
      existing.items = unique([...existing.items, item.content]);
    } else {
      categories.set(definition.id, {
        ...definition,
        items: [item.content],
      });
    }
  }

  return {
    ...memory,
    categories: [...categories.values()],
    inputCount: memory.inputCount + pendingItems.length,
  };
}

export function buildEmptyPatientMemory({
  generatedAt,
}: {
  generatedAt: string;
}): PatientMemory {
  return {
    categories: [],
    generatedAt,
    inputCount: 0,
  };
}

function normalizeRoughContent(rawText: string): string {
  const normalized = rawText.replace(/\s+/g, " ").trim();

  return normalized.length > ROUGH_CONTENT_LIMIT
    ? `${normalized.slice(0, ROUGH_CONTENT_LIMIT - 3)}...`
    : normalized;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}
