import type { SpecialtyStructure } from "@/domain/schemas";
import { runAssessmentGraph } from "@/server/agent";
import { closeAssessmentCheckpointer } from "@/server/agent/langgraph-checkpointer";
import { openDatabase, type SqliteDatabase } from "@/server/db";
import { MedicalRepository } from "@/server/repositories";
import { RawInputStore } from "@/server/storage/raw-input-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listRunClarificationRequests,
  resumeAssessmentRun,
  submitClarificationResponses,
} from "./clarification-workflow";

const timestamp = "2026-07-09T00:00:00.000Z";

describe("clarification pause/resume workflow", () => {
  let tempDirectory: string;
  let database: SqliteDatabase;
  let repository: MedicalRepository;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-clarification-"));
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

  it("saves clarification answers as evidence and resumes the same run with appended events", async () => {
    savePausedCase("case-resume-with-report");
    const checkpointPath = join(tempDirectory, "interrupted-checkpoints.sqlite");
    const paused = await runAssessmentGraph({
      case_id: "case-resume-with-report",
      repository,
      checkpoint_path: checkpointPath,
      now: () => timestamp,
    });
    const pausedRunId = paused.run.run_id;
    const pausedEvents = repository.listRunEvents(pausedRunId);
    const listed = listRunClarificationRequests(repository, pausedRunId);
    const request = listed.requests[0];
    const question = request?.questions[0];

    expect(paused.run.status).toBe("paused_for_clinician_input");
    expect(request).toBeDefined();
    expect(question).toBeDefined();

    const submitted = submitClarificationResponses({
      repository,
      requestId: request.request_id,
      body: {
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

    expect(submitted.responses).toHaveLength(1);
    expect(submitted.supplemental_input?.case_id).toBe(
      "case-resume-with-report",
    );
    expect(submitted.evidence[0]).toMatchObject({
      source_type: "clarification_response",
      extracted_by: "clinician",
      field: "clarification.pathology.confirmation_missing",
    });
    expect(
      repository.listAuditEvents(
        "clarification_request",
        request.request_id,
      )[0]?.action,
    ).toBe("clarification_response_submitted");

    // Simulate a process restart: the next graph compilation receives a fresh SQLite saver.
    closeAssessmentCheckpointer(checkpointPath);

    const resumed = await resumeAssessmentRun({
      repository,
      runId: pausedRunId,
      body: {},
      checkpoint_path: checkpointPath,
      now: () => timestamp,
    });
    const events = repository.listRunEvents(pausedRunId);

    expect(resumed.run.run_id).toBe(pausedRunId);
    expect(resumed.run.created_at).toBe(paused.run.created_at);
    expect(resumed.run.status).toBe("completed");
    expect(resumed.acknowledged_missing_evidence_codes).toContain(
      "pathology.confirmation_missing",
    );
    expect(resumed.structure.pathology.status).toBe("confirmed");
    expect(resumed.report?.report_json.assessment_status).toBe("completed");
    expect(events.length).toBeGreaterThan(pausedEvents.length);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.map((event) => event.event_type)).toEqual(
      expect.arrayContaining([
        "clarification.response.submitted",
        "assessment.run.resume_requested",
        "assessment.run.resume_completed",
      ]),
    );
    closeAssessmentCheckpointer(checkpointPath);
  });

  it("treats marked unknown as acknowledged and resumes without creating another request", async () => {
    savePausedCase("case-resume-unknown");
    const paused = await runAssessmentGraph({
      case_id: "case-resume-unknown",
      repository,
      now: () => timestamp,
    });
    const request = repository.listClarificationRequests(paused.run.run_id)[0];
    const question = request.questions[0];

    submitClarificationResponses({
      repository,
      requestId: request.request_id,
      body: {
        responses: [
          {
            question_id: question.id,
            marked_unknown: true,
          },
        ],
      },
      now: () => timestamp,
    });

    const resumed = await resumeAssessmentRun({
      repository,
      runId: paused.run.run_id,
      body: {},
      now: () => timestamp,
    });

    expect(resumed.run.run_id).toBe(paused.run.run_id);
    expect(resumed.run.status).toBe("completed");
    expect(resumed.structure.pathology.status).toBe("not_available");
    expect(repository.listClarificationRequests(paused.run.run_id)).toHaveLength(
      1,
    );
    expect(resumed.report?.report_json.pending_clarification).toBeNull();
  });

  it("requires an explicit structured resolution for a conflict question", () => {
    repository.saveCase({
      case_id: "case-conflict-resolution",
      display_name: "conflict resolution",
      status: "ready_for_assessment",
      created_at: timestamp,
      updated_at: timestamp,
    });
    repository.saveAssessmentRun({
      run_id: "run-conflict-resolution",
      case_id: "case-conflict-resolution",
      status: "paused_for_clinician_input",
      created_at: timestamp,
      updated_at: timestamp,
    });
    repository.saveClinicalConflicts([
      {
        conflict_id: "conflict-resolution-1",
        case_id: "case-conflict-resolution",
        category: "fact",
        severity: "blocking",
        field: "pathology.status",
        left_evidence_ids: ["e-left"],
        right_evidence_ids: ["e-right"],
        description: "病理状态冲突。",
        resolution: "unresolved",
        blocks: ["assessment", "draft_report", "final_report"],
        created_at: timestamp,
      },
    ]);
    repository.saveClarificationRequest({
      request_id: "request-conflict-resolution",
      case_id: "case-conflict-resolution",
      run_id: "run-conflict-resolution",
      reason: "证据冲突复核",
      questions: [
        {
          id: "conflict.conflict-resolution-1:1",
          priority: "high",
          question: "请选择采用哪一侧证据。",
          expected_answer_type: "free_text",
          clinical_purpose: "完成冲突裁决。",
          blocks_conclusion: true,
        },
      ],
      created_at: timestamp,
    });

    expect(() =>
      submitClarificationResponses({
        repository,
        requestId: "request-conflict-resolution",
        body: {
          responses: [
            {
              question_id: "conflict.conflict-resolution-1:1",
              answer_text: "采用左侧正式病理报告。",
              marked_unknown: false,
            },
          ],
        },
        now: () => timestamp,
      }),
    ).toThrow("explicit resolution choice");

    const submitted = submitClarificationResponses({
      repository,
      requestId: "request-conflict-resolution",
      body: {
        responses: [
          {
            question_id: "conflict.conflict-resolution-1:1",
            answer_text: "采用左侧正式病理报告。",
            marked_unknown: false,
            conflict_resolution: "confirm_left",
          },
        ],
      },
      now: () => timestamp,
    });

    expect(submitted.responses[0]?.conflict_resolution).toBe("confirm_left");
    expect(repository.listUnresolvedClinicalConflicts("case-conflict-resolution")).toEqual([]);
  });

  function savePausedCase(caseId: string): void {
    repository.saveCase({
      case_id: caseId,
      display_name: caseId,
      status: "ready_for_assessment",
      created_at: timestamp,
      updated_at: timestamp,
    });
    repository.createCaseInputFromRawText({
      input_id: `${caseId}-input`,
      case_id: caseId,
      input_type: "clinician_note",
      raw_text: "影像提示声门区占位，尚未提供病理报告。ECOG 1。",
      submitted_at: timestamp,
    });
    repository.saveSpecialtyStructure(missingPathologyStructure(caseId));
  }
});

function missingPathologyStructure(caseId: string): SpecialtyStructure {
  return {
    structure_id: `${caseId}-structure`,
    case_id: caseId,
    version: 1,
    cancer_site: "larynx",
    pathology: {
      status: "not_available",
      evidence_ids: [],
    },
    ct: {
      primary_site: "声门区",
      invasion_clues: ["声门区软组织肿物"],
      lymph_node_clues: ["颈部淋巴结未见明确肿大"],
      distant_metastasis_clues: ["未见远处转移"],
      evidence_ids: ["e-ct"],
    },
    biomarkers: {},
    labs: {
      ecog: 1,
      blood_routine_available: false,
      liver_function_available: false,
      kidney_function_available: false,
      albumin_available: false,
      abnormal_clues: [],
      evidence_ids: ["e-ecog"],
    },
    tolerance_factors: [],
    evidence_ids: ["e-ct", "e-ecog"],
    created_at: timestamp,
  };
}
