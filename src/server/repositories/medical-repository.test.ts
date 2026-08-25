import { DEFAULT_MEDICAL_DISCLAIMER } from "@/domain/schemas";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../db";
import { hashText, RawInputStore } from "../storage/raw-input-store";
import { MedicalRepository } from "./medical-repository";

const timestamp = "2026-07-09T00:00:00.000Z";

describe("MedicalRepository", () => {
  let tempDirectory: string;
  let database: SqliteDatabase;
  let repository: MedicalRepository;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-repo-"));
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

  it("initializes all Task 3 tables", () => {
    const rows = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "cases",
        "case_inputs",
          "case_conversation_messages",
          "patient_memory_snapshots",
        "pending_rough_memory_items",
        "evidence_assertions",
        "deterministic_rule_traces",
        "specialty_structures",
        "assessment_runs",
        "imaging_tool_jobs",
        "clarification_requests",
        "clarification_responses",
        "run_events",
        "assessment_reports",
        "reviews",
        "audit_events",
      ]),
    );
  });

  it("persists the local assessment workflow records", () => {
    repository.saveCase({
      case_id: "case-1",
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      created_at: timestamp,
      updated_at: timestamp,
    });

    const input = repository.createCaseInputFromRawText({
      input_id: "input-1",
      case_id: "case-1",
      input_type: "clinician_note",
      raw_text: "患者主诉咽痛，需要进一步检查。",
      submitted_at: timestamp,
    });

    expect(input.raw_text_hash).toBe(hashText("患者主诉咽痛，需要进一步检查。"));
    expect(repository.readCaseInputRawText("input-1")).toBe(
      "患者主诉咽痛，需要进一步检查。",
    );

    repository.saveSpecialtyStructure({
      structure_id: "structure-1",
      case_id: "case-1",
      version: 1,
      cancer_site: "unknown",
      pathology: {
        status: "not_available",
        evidence_ids: [],
      },
      ct: {
        invasion_clues: [],
        lymph_node_clues: [],
        distant_metastasis_clues: [],
        evidence_ids: [],
      },
      biomarkers: {},
      labs: {
        blood_routine_available: false,
        liver_function_available: false,
        kidney_function_available: false,
        albumin_available: false,
        abnormal_clues: [],
        evidence_ids: [],
      },
      tolerance_factors: [],
      evidence_ids: [],
      created_at: timestamp,
    });

    repository.saveAssessmentRun({
      run_id: "run-1",
      case_id: "case-1",
      status: "created",
      structure_id: "structure-1",
      created_at: timestamp,
      updated_at: timestamp,
    });

    repository.appendRunEvent({
      run_id: "run-1",
      event_type: "node_started",
      payload: { node: "intake_validation" },
    });

    repository.saveClarificationRequest({
      request_id: "request-1",
      case_id: "case-1",
      run_id: "run-1",
      reason: "缺少病理结果",
      questions: [
        {
          id: "q-1",
          priority: "high",
          question: "是否已有病理报告？",
          expected_answer_type: "free_text",
          clinical_purpose: "确认诊断依据",
          blocks_conclusion: true,
        },
      ],
      created_at: timestamp,
    });

    repository.saveClarificationResponse({
      response_id: "response-1",
      request_id: "request-1",
      question_id: "q-1",
      answer_text: "暂无",
      marked_unknown: false,
      supplemental_input_id: "input-1",
      submitted_at: timestamp,
    });

    repository.saveAssessmentReport({
      report_id: "report-1",
      run_id: "run-1",
      case_id: "case-1",
      report_json: {
        case_id: "case-1",
        in_scope: true,
        assessment_status: "completed",
        summary: "当前证据不足，需补充病理。",
        pending_clarification: null,
        diagnostic_evidence: {
          cancer_site: "unknown",
          pathology_status: "not_available",
          pathology_type: "unknown",
          stage_clues: [],
          missing_for_staging: ["pathology"],
        },
        sensitivity_assessment: [
          {
            modality: "radiotherapy",
            level: "uncertain",
            supporting_evidence: [],
            contradicting_evidence: [],
            missing_information: ["pathology"],
            citations: [],
            evidence_ids: [],
          },
        ],
        tolerance_assessment: [
          {
            modality: "radiotherapy",
            level: "unknown",
            risk_factors: [],
            protective_factors: [],
            missing_information: ["ECOG"],
          },
        ],
        red_flags: [],
        recommended_missing_tests: ["pathology"],
        evidence: [],
        overall_confidence: "low",
        knowledge_version: "v0.1",
        model_version: "test",
        review_required: true,
        disclaimer: DEFAULT_MEDICAL_DISCLAIMER,
      },
      report_markdown: "当前证据不足，需补充病理。",
      created_at: timestamp,
    });

    repository.saveReview({
      review_id: "review-1",
      report_id: "report-1",
      reviewer_id: "doctor-1",
      decision: "needs_revision",
      comment: "等待病理结果",
      reviewed_at: timestamp,
    });

    repository.recordAuditEvent({
      audit_event_id: "audit-1",
      entity_type: "case",
      entity_id: "case-1",
      action: "created",
      actor_id: "doctor-1",
      payload: { case_id: "case-1" },
      created_at: timestamp,
    });

    expect(repository.getCase("case-1")?.display_name).toBe("Case 1");
    expect(repository.listCaseInputs("case-1")).toHaveLength(1);
    expect(repository.getLatestSpecialtyStructure("case-1")?.version).toBe(1);
    expect(repository.getAssessmentRun("run-1")?.status).toBe("created");
    expect(repository.listRunEvents("run-1")[0]).toMatchObject({
      sequence: 1,
      event_type: "node_started",
      payload: { node: "intake_validation" },
    });
    expect(repository.getClarificationRequest("request-1")?.questions).toHaveLength(
      1,
    );
    expect(repository.listClarificationResponses("request-1")).toHaveLength(1);
    expect(repository.getAssessmentReportForRun("run-1")?.report_id).toBe(
      "report-1",
    );
    expect(repository.listReviews("report-1")[0]?.decision).toBe(
      "needs_revision",
    );
    expect(repository.listAuditEvents("case", "case-1")[0]?.action).toBe(
      "created",
    );
  });

  it("persists case conversation messages in chronological order with bounded reads", () => {
    repository.saveCase({
      case_id: "case-1",
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      created_at: timestamp,
      updated_at: timestamp,
    });
    const input = repository.createCaseInputFromRawText({
      input_id: "input-1",
      case_id: "case-1",
      input_type: "clinician_note",
      raw_text: "Initial clinician text.",
      submitted_at: "2026-07-09T00:01:00.000Z",
    });

    repository.createCaseConversationMessage({
      message_id: "message-1",
      case_id: "case-1",
      case_input_id: input.input_id,
      content: "Initial clinician text.",
      created_at: "2026-07-09T00:01:00.000Z",
      role: "clinician",
    });
    repository.createCaseConversationMessage({
      message_id: "message-2",
      case_id: "case-1",
      content: "Agent follow-up.",
      created_at: "2026-07-09T00:02:00.000Z",
      role: "agent",
    });
    repository.createCaseConversationMessage({
      message_id: "message-3",
      case_id: "case-1",
      content: "Second clinician update.",
      created_at: "2026-07-09T00:03:00.000Z",
      role: "clinician",
    });

    expect(repository.listCaseConversationMessages("case-1")).toMatchObject([
      {
        case_input_id: "input-1",
        content: "Initial clinician text.",
        message_id: "message-1",
        role: "clinician",
      },
      {
        case_input_id: undefined,
        content: "Agent follow-up.",
        message_id: "message-2",
        role: "agent",
      },
      {
        case_input_id: undefined,
        content: "Second clinician update.",
        message_id: "message-3",
        role: "clinician",
      },
    ]);
    expect(
      repository
        .listCaseConversationMessages("case-1", { limit: 2 })
        .map((message) => message.message_id),
    ).toEqual(["message-2", "message-3"]);
    expect(repository.listCaseConversationMessages("case-missing")).toEqual([]);
  });

  it("persists patient memory snapshots and resolves latest valid snapshots", () => {
    repository.saveCase({
      case_id: "case-1",
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      created_at: timestamp,
      updated_at: timestamp,
    });

    const memory = {
      categories: [
        {
          id: "history",
          items: ["Persistent hoarseness for two months."],
          label: "Illness History and Current Course",
          summary: "Clinician-entered illness history.",
        },
      ],
      generatedAt: "2026-07-09T00:01:00.000Z",
      inputCount: 1,
    };

    repository.savePatientMemorySnapshot({
      snapshot_id: "snapshot-1",
      case_id: "case-1",
      generated_at: "2026-07-09T00:01:00.000Z",
      input_count: 1,
      is_stale: false,
      memory,
      mode: "deterministic",
      source_fingerprint: "fingerprint-a",
    });
    repository.savePatientMemorySnapshot({
      snapshot_id: "snapshot-2",
      case_id: "case-1",
      generated_at: "2026-07-09T00:02:00.000Z",
      input_count: 1,
      is_stale: false,
      memory: {
        ...memory,
        generatedAt: "2026-07-09T00:02:00.000Z",
      },
      mode: "model",
      source_fingerprint: "fingerprint-b",
    });
    repository.savePatientMemorySnapshot({
      snapshot_id: "snapshot-3",
      case_id: "case-1",
      generated_at: "2026-07-09T00:03:00.000Z",
      input_count: 1,
      is_stale: true,
      memory: {
        ...memory,
        generatedAt: "2026-07-09T00:03:00.000Z",
      },
      mode: "fallback",
      source_fingerprint: "fingerprint-c",
    });

    expect(
      repository.getLatestPatientMemorySnapshot("case-1")?.snapshot_id,
    ).toBe("snapshot-3");
    expect(
      repository.getLatestValidPatientMemorySnapshot(
        "case-1",
        "fingerprint-a",
      ),
    ).toBeNull();
    expect(
      repository.getLatestValidPatientMemorySnapshot(
        "case-1",
        "fingerprint-b",
      ),
    ).toMatchObject({
      is_stale: false,
      memory: {
        categories: [
          expect.objectContaining({
            items: ["Persistent hoarseness for two months."],
          }),
        ],
      },
      mode: "model",
      snapshot_id: "snapshot-2",
    });
    expect(
      repository.getLatestValidPatientMemorySnapshot(
        "case-1",
        "fingerprint-c",
      ),
    ).toBeNull();

    expect(repository.markPatientMemorySnapshotsStale("case-1")).toBe(1);
    expect(
      repository.getLatestValidPatientMemorySnapshot(
        "case-1",
        "fingerprint-b",
      ),
    ).toBeNull();
  });

  it("persists pending rough memory items and marks them compacted", () => {
    repository.saveCase({
      case_id: "case-1",
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      created_at: timestamp,
      updated_at: timestamp,
    });
    const input = repository.createCaseInputFromRawText({
      input_id: "input-1",
      case_id: "case-1",
      input_type: "ct_report",
      raw_text: "CT shows right vocal cord thickening.",
      submitted_at: "2026-07-09T00:01:00.000Z",
    });

    repository.createPendingRoughMemoryItem({
      rough_item_id: "rough-1",
      bucket: "imaging",
      case_id: "case-1",
      content: "CT shows right vocal cord thickening.",
      created_at: input.submitted_at,
      source_case_input_id: input.input_id,
    });

    expect(repository.countPendingRoughMemoryItems("case-1")).toBe(1);
    expect(repository.listPendingRoughMemoryItems("case-1")).toMatchObject([
      {
        bucket: "imaging",
        case_id: "case-1",
        content: "CT shows right vocal cord thickening.",
        source_case_input_id: "input-1",
        status: "pending",
      },
    ]);

    expect(
      repository.markPendingRoughMemoryItemsCompacted(
        "case-1",
        "2026-07-09T00:02:00.000Z",
      ),
    ).toBe(1);
    expect(repository.countPendingRoughMemoryItems("case-1")).toBe(0);
    expect(repository.listPendingRoughMemoryItems("case-1")).toEqual([]);
  });
});
