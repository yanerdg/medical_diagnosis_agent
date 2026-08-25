import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "../db";
import { MedicalRepository } from "../repositories";
import { RawInputStore } from "../storage/raw-input-store";
import { evidenceModelToAssertion, persistEvidenceModels } from "./evidence-assertions";

describe("evidence assertions", () => {
  let database: SqliteDatabase;
  let directory: string;
  let repository: MedicalRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "medical-agent-evidence-"));
    database = openDatabase(join(directory, "app.sqlite"));
    repository = new MedicalRepository(database, new RawInputStore(directory));
    repository.saveCase({
      case_id: "case-1",
      display_name: "Case 1",
      status: "draft",
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:00:00.000Z",
    });
    repository.createCaseInputFromRawText({
      input_id: "input-1",
      case_id: "case-1",
      input_type: "pathology_biomarker",
      raw_text: "病理提示鳞状细胞癌。",
      submitted_at: "2026-08-25T00:00:00.000Z",
    });
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("normalizes and persists extracted evidence using the same evidence identifier", () => {
    const evidence = {
      evidence_id: "evidence-1",
      case_id: "case-1",
      source_type: "pathology_biomarker" as const,
      source_ref: "input-1",
      field: "pathology.pathology_type",
      value: "鳞状细胞癌",
      quote: "病理提示鳞状细胞癌。",
      confidence: 0.9,
      extracted_by: "rule" as const,
      created_at: "2026-08-25T00:00:00.000Z",
    };

    expect(evidenceModelToAssertion(evidence)).toMatchObject({
      assertion_id: "evidence-1",
      domain: "pathology",
      source_type: "signed_report",
      source_input_id: "input-1",
    });
    persistEvidenceModels({ repository, evidence: [evidence] });
    persistEvidenceModels({ repository, evidence: [evidence] });

    expect(repository.listEvidenceAssertions("case-1")).toEqual([
      expect.objectContaining({
        assertion_id: "evidence-1",
        assertion_key: "pathology.pathology_type",
        value: "鳞状细胞癌",
        excerpt: "病理提示鳞状细胞癌。",
      }),
    ]);
  });
});
