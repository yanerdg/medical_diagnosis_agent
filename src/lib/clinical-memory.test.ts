import { describe, expect, it } from "vitest";
import { buildPatientMemory, type BuildPatientMemoryParams } from "./clinical-memory";

describe("buildPatientMemory", () => {
  it("does not write case metadata into clinical memory categories", () => {
    const memory = buildPatientMemory(
      paramsWithInputs([
        {
          inputId: "input-1",
          inputType: "clinician_note",
          rawText: "Patient reports persistent hoarseness and throat pain.",
          submittedAt: "2026-07-09T00:01:00.000Z",
        },
      ]),
    );

    expect(memory.categories.map((category) => category.id)).not.toContain(
      "profile",
    );
    expect(JSON.stringify(memory.categories)).not.toContain("Case name");
    expect(JSON.stringify(memory.categories)).not.toContain("Patient reference");
    expect(JSON.stringify(memory.categories)).not.toContain("Case status");
    expect(JSON.stringify(memory.categories)).not.toContain("Case Alpha");
    expect(JSON.stringify(memory.categories)).not.toContain("patient-ref-42");
  });

  it("uses Basic Information only for patient clinical profile variables", () => {
    const memory = buildPatientMemory(
      paramsWithInputs([
        {
          inputId: "input-1",
          inputType: "demographics",
          rawText:
            "62-year-old male; height 172 cm; weight 61 kg; ECOG 1; former smoker; poor baseline nutrition.",
          submittedAt: "2026-07-09T00:01:00.000Z",
        },
      ]),
    );

    const profile = memory.categories.find((category) => category.id === "profile");

    expect(profile).toEqual(
      expect.objectContaining({
        label: "Basic Information",
        items: [
          "62-year-old male; height 172 cm; weight 61 kg; ECOG 1; former smoker; poor baseline nutrition.",
        ],
      }),
    );
    expect(profile?.summary).toContain("age");
    expect(profile?.summary).toContain("ECOG");
    expect(JSON.stringify(profile)).not.toContain("Case Alpha");
    expect(JSON.stringify(profile)).not.toContain("patient-ref-42");
    expect(JSON.stringify(profile)).not.toContain("draft");
  });
});

function paramsWithInputs(
  inputs: BuildPatientMemoryParams["inputs"],
): BuildPatientMemoryParams {
  return {
    agentRounds: [],
    caseRecord: {
      display_name: "Case Alpha",
      patient_ref: "patient-ref-42",
      status: "draft",
      updated_at: "2026-07-09T00:02:00.000Z",
    },
    inputs,
  };
}
