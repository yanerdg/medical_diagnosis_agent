import type { CaseRecord } from "@/domain/schemas";
import type {
  BuildPatientMemoryParams,
  ClinicalMemoryInput,
  ClinicalMemoryRound,
  PatientMemory,
} from "@/lib/clinical-memory";
import type { PatientMemorySnapshotMode } from "@/server/repositories/types";
import { createHash } from "node:crypto";
import { buildPatientMemoryWithModel } from "./model-memory";
import { buildRestrictedMemoryWriteContext } from "./memory-policy";
import {
  buildEmptyPatientMemory,
  mergePatientMemoryWithPendingRoughMemory,
} from "./rough-memory";
import type { MedicalRepository } from "../repositories";

export const PENDING_MEMORY_COMPACTION_THRESHOLD = 5;

export interface PatientMemorySnapshotStatus {
  mode: PatientMemorySnapshotMode;
  sourceFingerprint: string;
  generatedAt: string;
  isStale: boolean;
  refreshed: boolean;
  pendingRoughItemCount: number;
  compactedPendingItemCount?: number;
}

export interface PatientMemorySnapshotResult {
  memory: PatientMemory;
  mode: PatientMemorySnapshotMode;
  status: PatientMemorySnapshotStatus;
}

export async function getOrRefreshPatientMemorySnapshot({
  caseRecord,
  forceRefresh = false,
  repository,
}: {
  caseRecord: CaseRecord;
  forceRefresh?: boolean;
  repository: MedicalRepository;
}): Promise<PatientMemorySnapshotResult> {
  if (forceRefresh) {
    return compactPendingPatientMemory({
      caseRecord,
      repository,
    });
  }

  return getPatientMemorySnapshotForRead({
    caseRecord,
    repository,
  });
}

export function getPatientMemorySnapshotForRead({
  caseRecord,
  repository,
}: {
  caseRecord: CaseRecord;
  repository: MedicalRepository;
}): PatientMemorySnapshotResult {
  const sources = loadClinicalMemorySources(repository, caseRecord);
  const sourceFingerprint = computePatientMemorySourceFingerprint(sources);
  const snapshot = repository.getLatestPatientMemorySnapshot(caseRecord.case_id);
  const pendingItems = repository.listPendingRoughMemoryItems(
    caseRecord.case_id,
  );
  const snapshotMemory =
    snapshot?.memory ??
    buildEmptyPatientMemory({
      generatedAt: caseRecord.updated_at,
    });
  const memory = mergePatientMemoryWithPendingRoughMemory(
    snapshotMemory,
    pendingItems,
  );
  const mode = snapshot?.mode ?? "deterministic";

  return {
    memory,
    mode,
    status: {
      generatedAt: snapshot?.generated_at ?? caseRecord.updated_at,
      isStale: snapshot?.is_stale ?? false,
      mode,
      pendingRoughItemCount: pendingItems.length,
      refreshed: false,
      sourceFingerprint,
    },
  };
}

export async function compactPendingPatientMemoryIfThresholdMet({
  caseRecord,
  repository,
  threshold = PENDING_MEMORY_COMPACTION_THRESHOLD,
}: {
  caseRecord: CaseRecord;
  repository: MedicalRepository;
  threshold?: number;
}): Promise<PatientMemorySnapshotResult> {
  const pendingItemCount = repository.countPendingRoughMemoryItems(
    caseRecord.case_id,
  );

  if (pendingItemCount < threshold) {
    return getPatientMemorySnapshotForRead({
      caseRecord,
      repository,
    });
  }

  return compactPendingPatientMemory({
    caseRecord,
    repository,
  });
}

export async function compactPendingPatientMemory({
  caseRecord,
  repository,
}: {
  caseRecord: CaseRecord;
  repository: MedicalRepository;
}): Promise<PatientMemorySnapshotResult> {
  const pendingItemCount = repository.countPendingRoughMemoryItems(
    caseRecord.case_id,
  );
  const sources = loadClinicalMemorySources(repository, caseRecord);
  const sourceFingerprint = computePatientMemorySourceFingerprint(sources);

  const generated = await buildPatientMemoryWithModel(sources);
  const snapshot = repository.savePatientMemorySnapshot({
    case_id: caseRecord.case_id,
    generated_at: generated.memory.generatedAt,
    input_count: generated.memory.inputCount,
    is_stale: false,
    memory: generated.memory,
    mode: generated.mode,
    source_fingerprint: sourceFingerprint,
  });
  const compactedPendingItemCount =
    repository.markPendingRoughMemoryItemsCompacted(
      caseRecord.case_id,
      snapshot.generated_at,
    );

  return {
    memory: snapshot.memory,
    mode: snapshot.mode,
    status: {
      compactedPendingItemCount,
      generatedAt: snapshot.generated_at,
      isStale: snapshot.is_stale,
      mode: snapshot.mode,
      pendingRoughItemCount: Math.max(
        pendingItemCount - compactedPendingItemCount,
        0,
      ),
      refreshed: true,
      sourceFingerprint,
    },
  };
}

export function loadClinicalMemorySources(
  repository: MedicalRepository,
  caseRecord: CaseRecord,
): BuildPatientMemoryParams {
  const inputs: ClinicalMemoryInput[] = repository
    .listCaseInputs(caseRecord.case_id)
    .map((input) => ({
      inputId: input.input_id,
      inputType: input.input_type,
      rawText: repository.readCaseInputRawText(input.input_id) ?? "",
      submittedAt: input.submitted_at,
    }));
  const agentRounds: ClinicalMemoryRound[] = repository
    .listAssessmentRuns(caseRecord.case_id)
    .flatMap((run) => repository.listClarificationRequests(run.run_id))
    .map((request) => ({
      requestId: request.request_id,
      reason: request.reason,
      createdAt: request.created_at,
      questions: request.questions.map((question) => ({
        clinicalPurpose: question.clinical_purpose,
        id: question.id,
        question: question.question,
      })),
      answers: repository
        .listClarificationResponses(request.request_id)
        .map((response) => ({
          answerText: response.answer_text,
          markedUnknown: response.marked_unknown,
          questionId: response.question_id,
        })),
    }));

  return {
    agentRounds,
    caseRecord,
    inputs,
  };
}

export function computePatientMemorySourceFingerprint(
  sources: Pick<BuildPatientMemoryParams, "agentRounds" | "inputs">,
): string {
  const memoryWriteContext = buildRestrictedMemoryWriteContext(sources);
  const stableCandidates = memoryWriteContext.candidates
    .map((candidate) => ({
      categoryHint: candidate.categoryHint,
      id: candidate.id,
      source: candidate.source,
      text: candidate.text,
    }))
    .sort((left, right) =>
      [left.source, left.id, left.categoryHint, left.text]
        .join("\u0000")
        .localeCompare(
          [right.source, right.id, right.categoryHint, right.text].join("\u0000"),
        ),
    );

  return createHash("sha256")
    .update(JSON.stringify({ candidates: stableCandidates }))
    .digest("hex");
}
