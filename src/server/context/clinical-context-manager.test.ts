import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/db";
import { MedicalRepository } from "@/server/repositories";
import { ClinicalContextManager } from "./clinical-context-manager";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("ClinicalContextManager", () => {
  it("materializes a bounded core fact card and persists a blocking pathology conflict", () => {
    const database = openDatabase(":memory:");
    databases.push(database);
    const repository = new MedicalRepository(database);
    repository.saveCase({
      case_id: "case-context-1",
      display_name: "context test",
      status: "draft",
      created_at: "2026-08-23T00:00:00.000Z",
      updated_at: "2026-08-23T00:00:00.000Z",
    });
    const structure = repository.saveSpecialtyStructure({
      structure_id: "structure-context-1",
      case_id: "case-context-1",
      version: 1,
      cancer_site: "larynx",
      pathology: {
        status: "not_available",
        pathology_type: "鳞状细胞癌",
        evidence_ids: ["e-pathology"],
      },
      ct: {
        primary_site: "声门区",
        invasion_clues: [],
        lymph_node_clues: [],
        distant_metastasis_clues: [],
        evidence_ids: ["e-ct"],
      },
      biomarkers: { "PD-L1": "未提供" },
      labs: {
        blood_routine_available: true,
        liver_function_available: false,
        kidney_function_available: false,
        albumin_available: false,
        abnormal_clues: [],
        evidence_ids: ["e-labs"],
      },
      tolerance_factors: [],
      evidence_ids: ["e-pathology", "e-ct", "e-labs"],
      created_at: "2026-08-23T00:00:00.000Z",
    });

    const context = new ClinicalContextManager(repository).build({
      case_id: structure.case_id,
      run_id: "run-context-1",
      structure,
      profile: "react_planner",
    });

    expect(context.core_fact_card.map((fact) => fact.fact_key)).toEqual(
      expect.arrayContaining(["cancer_site", "pathology.status", "ct.primary_site"]),
    );
    expect(context.unresolved_conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "fact",
          field: "pathology.status",
          severity: "blocking",
        }),
      ]),
    );
    expect(repository.listClinicalFacts(structure.case_id, structure.structure_id).length).toBeGreaterThan(0);
    expect(repository.listUnresolvedClinicalConflicts(structure.case_id)).toHaveLength(1);
  });
});
