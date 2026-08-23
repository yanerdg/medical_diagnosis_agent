import { randomUUID } from "node:crypto";
import type { ImagingToolJob, ImagingToolKind } from "@/domain/schemas";
import type { MedicalRepository } from "@/server/repositories/medical-repository";

const defaultModelVersions: Record<ImagingToolKind, string> = {
  ct: "mock-ct-v1",
  wsi: "mock-wsi-v1",
};

export interface SubmitMockImagingJobParams {
  repository: MedicalRepository;
  run_id: string;
  input_id: string;
  kind: ImagingToolKind;
  model_version?: string;
  now?: string;
}

export function submitMockImagingJob(
  params: SubmitMockImagingJobParams,
): ImagingToolJob {
  const run = params.repository.getAssessmentRun(params.run_id);
  const input = params.repository.getCaseInput(params.input_id);

  if (!run) {
    throw new Error(`Assessment run ${params.run_id} does not exist.`);
  }
  if (!input) {
    throw new Error(`Case input ${params.input_id} does not exist.`);
  }
  if (run.case_id !== input.case_id) {
    throw new Error("Imaging input must belong to the assessment run case.");
  }

  const modelVersion = params.model_version ?? defaultModelVersions[params.kind];
  const idempotencyKey = [
    params.run_id,
    input.raw_text_hash,
    modelVersion,
    params.kind,
  ].join(":");
  const existing = params.repository.getImagingToolJobByIdempotencyKey(idempotencyKey);
  if (existing) {
    return existing;
  }

  const job = params.repository.saveImagingToolJob({
    job_id: randomUUID(),
    kind: params.kind,
    case_id: run.case_id,
    run_id: run.run_id,
    input_id: input.input_id,
    input_hash: input.raw_text_hash,
    idempotency_key: idempotencyKey,
    status: "queued",
    model_version: modelVersion,
    result_evidence_ids: [],
    created_at: params.now,
    updated_at: params.now,
  });
  params.repository.recordAuditEvent({
    entity_type: "imaging_tool_job",
    entity_id: job.job_id,
    action: "imaging_job_queued",
    payload: {
      idempotency_key: job.idempotency_key,
      input_id: job.input_id,
      kind: job.kind,
      model_version: job.model_version,
      run_id: job.run_id,
    },
    created_at: params.now,
  });

  return job;
}

export function collectMockImagingJob(params: {
  repository: MedicalRepository;
  job_id: string;
  now?: string;
}): ImagingToolJob {
  const current = params.repository.getImagingToolJob(params.job_id);
  if (!current) {
    throw new Error(`Imaging tool job ${params.job_id} does not exist.`);
  }
  if (current.status !== "queued" && current.status !== "running") {
    return current;
  }

  const completed = params.repository.saveImagingToolJob({
    ...current,
    status: "completed",
    result_evidence_ids: [`imaging-job:${current.job_id}:mock-result`],
    error_message: undefined,
    updated_at: params.now,
  });
  params.repository.recordAuditEvent({
    entity_type: "imaging_tool_job",
    entity_id: completed.job_id,
    action: "imaging_job_completed",
    payload: {
      kind: completed.kind,
      model_version: completed.model_version,
      result_evidence_ids: completed.result_evidence_ids,
      run_id: completed.run_id,
    },
    created_at: params.now,
  });

  return completed;
}
