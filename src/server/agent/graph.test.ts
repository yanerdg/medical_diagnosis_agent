import type { SpecialtyStructure } from "@/domain/schemas";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../db";
import { MedicalRepository } from "../repositories";
import { RawInputStore } from "../storage/raw-input-store";
import { runAssessmentGraph } from "./graph";
import {
  closeAssessmentCheckpointer,
  createAssessmentCheckpointer,
} from "./langgraph-checkpointer";
import { MAX_AGENT_LOOP_COUNT } from "./types";

const timestamp = "2026-07-09T00:00:00.000Z";

describe("assessment agent graph", () => {
  let tempDirectory: string;
  let database: SqliteDatabase;
  let repository: MedicalRepository;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-graph-"));
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

  it("completes an assessment run with all whitelisted tools recorded", async () => {
    saveCaseWithStructure(
      "case-complete",
      completeStructure("case-complete", "structure-complete"),
      "患者喉部肿物，病理提示鳞状细胞癌。ECOG 1，血常规、肝肾功能、白蛋白已查。",
    );

    const result = await runAssessmentGraph({
      case_id: "case-complete",
      repository,
      now: () => timestamp,
    });

    expect(result.run.status).toBe("completed");
    expect(result.state.loop_count).toBeLessThanOrEqual(MAX_AGENT_LOOP_COUNT);
    expect(result.report?.report_json.assessment_status).toBe("completed");
    expect(result.report?.report_json.review_required).toBe(true);
    const reportJson = result.report?.report_json;
    const knowledgeEvidenceByCitation = new Map(
      reportJson?.evidence
        .filter((item) => item.source_type === "knowledge_base")
        .map((item) => [item.source_ref, item.evidence_id]),
    );
    const firstSensitivityItem = reportJson?.sensitivity_assessment[0];
    expect(knowledgeEvidenceByCitation.size).toBeGreaterThan(0);
    expect(firstSensitivityItem?.citations.length).toBeGreaterThan(0);
    for (const citationId of firstSensitivityItem?.citations ?? []) {
      const evidenceId = knowledgeEvidenceByCitation.get(citationId);

      expect(evidenceId).toBeDefined();
      expect(firstSensitivityItem?.evidence_ids).toContain(evidenceId);
    }

    const events = repository.listRunEvents(result.run.run_id);
    const completedTools = events
      .filter((event) => event.event_type === "assessment.tool.completed")
      .map((event) => event.payload)
      .map((payload) =>
        typeof payload === "object" && payload !== null && "tool" in payload
          ? payload.tool
          : null,
      );

    expect(completedTools).toEqual(
      expect.arrayContaining([
        "parser",
        "lab_checker",
        "tnm_mapper",
        "rag_search",
        "sensitivity_assessor",
        "tolerance_assessor",
        "contradiction_checker",
        "report_generator",
        "output_schema_validator",
      ]),
    );
    expect(
      events.filter((event) => event.event_type === "assessment.node.completed"),
    ).toHaveLength(4);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
  });

  it("pauses for clinician clarification when pathology is missing", async () => {
    saveCaseWithStructure(
      "case-paused",
      missingPathologyStructure("case-paused", "structure-paused"),
      "影像提示声门区占位，尚未提供病理报告。",
    );

    const result = await runAssessmentGraph({
      case_id: "case-paused",
      repository,
      now: () => timestamp,
    });

    expect(result.run.status).toBe("paused_for_clinician_input");
    expect(result.clarification_request).toMatchObject({
      reason: "病理确认",
    });
    expect(result.clarification_request?.questions[0]).toMatchObject({
      expected_answer_type: "report_upload",
      blocks_conclusion: true,
    });
    expect(repository.listClarificationRequests(result.run.run_id)).toHaveLength(1);
    expect(result.report?.report_json.assessment_status).toBe(
      "paused_for_clinician_input",
    );
    expect(
      result.report?.report_json.sensitivity_assessment.some(
        (item) => item.level === "likely_sensitive",
      ),
    ).toBe(false);
  });

  it("fails before exceeding the configured loop limit", async () => {
    saveCaseWithStructure(
      "case-loop-limit",
      completeStructure("case-loop-limit", "structure-loop-limit"),
      "病理提示鳞状细胞癌。",
    );

    const checkpointPath = join(tempDirectory, "assessment-checkpoints.sqlite");
    const result = await runAssessmentGraph({
      case_id: "case-loop-limit",
      repository,
      max_loop_count: 1,
      checkpoint_path: checkpointPath,
      now: () => timestamp,
    });

    expect(result.run.status).toBe("failed");
    expect(result.state.loop_count).toBe(1);
    expect(
      repository
        .listRunEvents(result.run.run_id)
        .some((event) => event.event_type === "assessment.loop_limit_exceeded"),
    ).toBe(true);

    const checkpoints = [];
    for await (const checkpoint of createAssessmentCheckpointer(checkpointPath).list({
      configurable: { thread_id: result.run.run_id },
    })) {
      checkpoints.push(checkpoint);
    }
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    closeAssessmentCheckpointer(checkpointPath);
  });

  function saveCaseWithStructure(
    caseId: string,
    structure: SpecialtyStructure,
    rawText: string,
  ): void {
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
      raw_text: rawText,
      submitted_at: timestamp,
    });
    repository.saveSpecialtyStructure(structure);
  }
});

function completeStructure(
  caseId: string,
  structureId: string,
): SpecialtyStructure {
  return {
    structure_id: structureId,
    case_id: caseId,
    version: 1,
    cancer_site: "larynx",
    pathology: {
      status: "confirmed",
      pathology_type: "鳞状细胞癌",
      differentiation: "中分化",
      evidence_ids: ["e-pathology"],
    },
    ct: {
      primary_site: "声门区",
      invasion_clues: ["声门区软组织肿物"],
      lymph_node_clues: ["颈部淋巴结未见明确肿大"],
      distant_metastasis_clues: ["未见远处转移"],
      evidence_ids: ["e-ct"],
    },
    biomarkers: {
      "PD-L1": "CPS 10",
      p16: "阴性",
    },
    labs: {
      ecog: 1,
      blood_routine_available: true,
      liver_function_available: true,
      kidney_function_available: true,
      albumin_available: true,
      abnormal_clues: [],
      evidence_ids: ["e-labs"],
    },
    tolerance_factors: [],
    evidence_ids: ["e-pathology", "e-ct", "e-labs"],
    created_at: timestamp,
  };
}

function missingPathologyStructure(
  caseId: string,
  structureId: string,
): SpecialtyStructure {
  return {
    ...completeStructure(caseId, structureId),
    pathology: {
      status: "not_available",
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
    evidence_ids: ["e-ct"],
  };
}
