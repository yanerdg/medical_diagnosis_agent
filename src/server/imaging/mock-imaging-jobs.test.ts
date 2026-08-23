import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../db";
import { MedicalRepository } from "../repositories/medical-repository";
import { RawInputStore } from "../storage/raw-input-store";
import { collectMockImagingJob, submitMockImagingJob } from "./mock-imaging-jobs";

describe("mock imaging jobs", () => {
  let database: SqliteDatabase;
  let directory: string;
  let repository: MedicalRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "medical-agent-imaging-"));
    database = openDatabase(join(directory, "app.sqlite"));
    repository = new MedicalRepository(database, new RawInputStore(directory));
    repository.saveCase({
      case_id: "case-1",
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "ready_for_assessment",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    repository.saveAssessmentRun({
      run_id: "run-1",
      case_id: "case-1",
      status: "running",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    repository.createCaseInputFromRawText({
      input_id: "input-1",
      case_id: "case-1",
      input_type: "ct_report",
      raw_text: "CT report input reference",
      submitted_at: "2026-08-23T00:00:00.000Z",
    });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("submits and collects each input once using a durable idempotency key", () => {
    const submitted = submitMockImagingJob({
      repository,
      run_id: "run-1",
      input_id: "input-1",
      kind: "ct",
      now: "2026-08-23T00:01:00.000Z",
    });
    const duplicate = submitMockImagingJob({
      repository,
      run_id: "run-1",
      input_id: "input-1",
      kind: "ct",
      now: "2026-08-23T00:02:00.000Z",
    });

    expect(duplicate).toEqual(submitted);
    expect(repository.listImagingToolJobsForRun("run-1")).toHaveLength(1);

    database.close();
    database = openDatabase(join(directory, "app.sqlite"));
    repository = new MedicalRepository(database, new RawInputStore(directory));
    expect(repository.getImagingToolJob(submitted.job_id)).toEqual(submitted);

    const completed = collectMockImagingJob({
      repository,
      job_id: submitted.job_id,
      now: "2026-08-23T00:03:00.000Z",
    });
    const collectedAgain = collectMockImagingJob({
      repository,
      job_id: submitted.job_id,
      now: "2026-08-23T00:04:00.000Z",
    });

    expect(completed).toMatchObject({
      status: "completed",
      result_evidence_ids: [`imaging-job:${submitted.job_id}:mock-result`],
    });
    expect(collectedAgain).toEqual(completed);
    expect(
      submitMockImagingJob({
        repository,
        run_id: "run-1",
        input_id: "input-1",
        kind: "ct",
      }),
    ).toEqual(completed);
    expect(repository.listAuditEvents("imaging_tool_job", submitted.job_id)).toMatchObject([
      { action: "imaging_job_queued" },
      { action: "imaging_job_completed" },
    ]);
  });
});
