import type { CaseInput } from "@/domain/schemas";
import {
  getAssessmentRunReport,
  startAssessmentRun,
  submitAssessmentReportReview,
} from "@/server/assessments/assessment-workflow";
import {
  listRunClarificationRequests,
  resumeAssessmentRun,
  submitClarificationResponses,
} from "@/server/assessments/clarification-workflow";
import { extractSpecialtyStructure } from "@/server/cases/structured-extraction";
import { openDatabase, type SqliteDatabase } from "@/server/db";
import { MedicalRepository } from "@/server/repositories";
import { RawInputStore } from "@/server/storage/raw-input-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const timestamp = "2026-07-09T00:00:00.000Z";

describe("Task 11 automated end-to-end smoke", () => {
  let tempDirectory: string;
  let database: SqliteDatabase;
  let repository: MedicalRepository;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-e2e-"));
    database = openDatabase(join(tempDirectory, "app.sqlite"));
    repository = new MedicalRepository(
      database,
      new RawInputStore(tempDirectory),
    );
  });

  afterEach(() => {
    database.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("runs case intake, structure preview, clarification pause/resume, report generation, and clinician review", async () => {
    const caseId = "e2e-smoke-case";

    repository.saveCase({
      case_id: caseId,
      display_name: "E2E smoke case",
      status: "draft",
      created_at: timestamp,
      updated_at: timestamp,
    });
    const clinicianNote = repository.createCaseInputFromRawText({
      input_id: "e2e-note",
      case_id: caseId,
      input_type: "clinician_note",
      raw_text: "喉部肿物待评估，ECOG 1。组织学结论尚未返回。",
      submitted_at: timestamp,
    });
    const ctReport = repository.createCaseInputFromRawText({
      input_id: "e2e-ct",
      case_id: caseId,
      input_type: "ct_report",
      raw_text:
        "CT 提示声门区占位，颈部淋巴结未见明确肿大，未见远处转移。",
      submitted_at: timestamp,
    });
    const labReport = repository.createCaseInputFromRawText({
      input_id: "e2e-lab",
      case_id: caseId,
      input_type: "lab_report",
      raw_text: "血常规、肝功能、肾功能、白蛋白已查。",
      submitted_at: timestamp,
    });

    const preview = extractSpecialtyStructure({
      case_id: caseId,
      inputs: [clinicianNote, ctReport, labReport].map((input) =>
        toInputText(repository, input),
      ),
      version: 1,
      created_at: timestamp,
    });

    repository.saveCase({
      case_id: caseId,
      display_name: "E2E smoke case",
      status: "ready_for_assessment",
      created_at: timestamp,
      updated_at: timestamp,
    });
    repository.saveSpecialtyStructure(preview.structure);

    expect(preview.structure.pathology.status).toBe("not_available");
    expect(repository.getLatestSpecialtyStructure(caseId)?.structure_id).toBe(
      preview.structure.structure_id,
    );

    const paused = await startAssessmentRun({
      repository,
      caseId,
      body: {
        structure_id: preview.structure.structure_id,
      },
      now: () => timestamp,
    });

    expect(paused.run.status).toBe("paused_for_clinician_input");
    expect(paused.clarification_request?.reason).toContain("病理确认");

    const clarification = listRunClarificationRequests(
      repository,
      paused.run.run_id,
    );
    const request = clarification.requests[0];
    const question = request.questions[0];

    expect(request.responses).toHaveLength(0);
    expect(question.expected_answer_type).toBe("report_upload");

    const submitted = submitClarificationResponses({
      repository,
      requestId: request.request_id,
      body: {
        clinician_id: "doctor-smoke",
        responses: [
          {
            question_id: question.id,
            answer_text: "病理报告提示：喉鳞状细胞癌，中分化。",
            marked_unknown: false,
          },
        ],
        supplemental_report_text: "补充病理：喉鳞状细胞癌，中分化。",
        supplemental_input_type: "pathology_biomarker",
      },
      now: () => timestamp,
    });

    expect(submitted.supplemental_input?.input_type).toBe("pathology_biomarker");
    expect(submitted.evidence[0]?.extracted_by).toBe("clinician");

    const resumed = await resumeAssessmentRun({
      repository,
      runId: paused.run.run_id,
      body: {
        clinician_id: "doctor-smoke",
      },
      now: () => timestamp,
    });

    expect(resumed.run.run_id).toBe(paused.run.run_id);
    expect(resumed.run.status).toBe("completed");
    expect(resumed.structure.pathology.status).toBe("confirmed");
    expect(resumed.report?.report_json.assessment_status).toBe("completed");
    expect(resumed.report?.report_json.review_required).toBe(true);

    const reportId = resumed.report?.report_id;
    if (!reportId) {
      throw new Error("Expected resumed assessment to save a report.");
    }

    const review = await submitAssessmentReportReview({
      repository,
      reportId,
      body: {
        reviewer_id: "doctor-smoke",
        decision: "adopted",
        comment: "Smoke test review accepted.",
      },
      now: () => timestamp,
    });
    const reportView = await getAssessmentRunReport(
      repository,
      resumed.run.run_id,
    );

    expect(review.review.decision).toBe("adopted");
    expect(reportView.reviews).toHaveLength(1);
    expect(
      repository
        .listRunEvents(resumed.run.run_id)
        .map((event) => event.event_type),
    ).toEqual(
      expect.arrayContaining([
        "assessment.run.started",
        "assessment.run.resume_requested",
        "assessment.report.saved",
        "assessment.report.reviewed",
      ]),
    );
  });
});

function toInputText(
  repository: MedicalRepository,
  input: CaseInput,
): { input: CaseInput; raw_text: string } {
  return {
    input,
    raw_text: repositoryRawText(repository, input),
  };
}

function repositoryRawText(
  repository: MedicalRepository,
  input: CaseInput,
): string {
  const text = repository.readCaseInputRawText(input.input_id);

  if (text === null) {
    throw new Error(`Raw input text not found: ${input.input_id}`);
  }

  return text;
}
