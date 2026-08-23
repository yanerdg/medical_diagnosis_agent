import type { CaseInput } from "@/domain/schemas";
import { describe, expect, it } from "vitest";
import {
  applyClinicianCorrections,
  extractSpecialtyStructure,
} from "./structured-extraction";

const timestamp = "2026-07-09T00:00:00.000Z";

function input(
  input_id: string,
  input_type: CaseInput["input_type"],
  raw_text: string,
) {
  return {
    input: {
      input_id,
      case_id: "case-1",
      input_type,
      raw_text_path: `/tmp/${input_id}.txt`,
      raw_text_hash: `hash-${input_id}`,
      version: 1,
      submitted_at: timestamp,
    },
    raw_text,
  };
}

describe("structured specialty extraction", () => {
  it("builds SpecialtyStructure and EvidenceModel from deterministic text clues", () => {
    const result = extractSpecialtyStructure({
      case_id: "case-1",
      version: 1,
      created_at: timestamp,
      inputs: [
        input("input-1", "clinician_note", "喉部肿物，ECOG 1。"),
        input(
          "input-2",
          "ct_report",
          "喉声门区占位，累及声带。颈部淋巴结肿大。",
        ),
        input(
          "input-3",
          "pathology_biomarker",
          "活检病理提示鳞状细胞癌，低分化。PD-L1 CPS 20。",
        ),
        input("input-4", "lab_report", "血常规、肝功能、肾功能、白蛋白已查。"),
      ],
    });

    expect(result.structure).toMatchObject({
      case_id: "case-1",
      version: 1,
      cancer_site: "larynx",
      pathology: {
        status: "confirmed",
        pathology_type: "鳞状细胞癌",
        differentiation: "低分化",
      },
      labs: {
        ecog: 1,
        blood_routine_available: true,
        liver_function_available: true,
        kidney_function_available: true,
        albumin_available: true,
      },
    });
    expect(result.structure.ct.invasion_clues).toContain("喉声门区占位，累及声带");
    expect(result.structure.evidence_ids.length).toBeGreaterThan(0);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "pathology.status",
          extracted_by: "rule",
        }),
      ]),
    );
  });

  it("stores clinician corrections as a new version with clinician evidence", () => {
    const extracted = extractSpecialtyStructure({
      case_id: "case-1",
      version: 1,
      created_at: timestamp,
      inputs: [
        input("input-1", "clinician_note", "咽喉部肿物。"),
        input("input-2", "ct_report", "喉部占位。"),
      ],
    });

    const corrected = applyClinicianCorrections({
      case_id: "case-1",
      base_structure: extracted.structure,
      version: 2,
      created_at: timestamp,
      clinician_id: "doctor-1",
      corrections: {
        cancer_site: "hypopharynx",
        pathology: {
          status: "suspicious",
          pathology_type: "鳞状细胞癌",
        },
      },
    });

    expect(corrected.structure.version).toBe(2);
    expect(corrected.structure.cancer_site).toBe("hypopharynx");
    expect(corrected.structure.pathology).toMatchObject({
      status: "suspicious",
      pathology_type: "鳞状细胞癌",
    });
    expect(corrected.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_type: "clinician_correction",
          field: "pathology.status",
          extracted_by: "clinician",
          confidence: 1,
        }),
      ]),
    );
    expect(corrected.structure.evidence_ids).toEqual(
      expect.arrayContaining(corrected.evidence.map((item) => item.evidence_id)),
    );
  });
});
