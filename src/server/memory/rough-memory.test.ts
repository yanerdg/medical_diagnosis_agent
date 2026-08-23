import { describe, expect, it } from "vitest";
import {
  classifyPendingRoughMemoryBucket,
  mergePatientMemoryWithPendingRoughMemory,
} from "./rough-memory";

describe("rough memory classification", () => {
  it("deterministically classifies clinician-authored inputs into pending buckets", () => {
    expect(
      classifyPendingRoughMemoryBucket({
        inputType: "ct_report",
        rawText: "Plain report text.",
      }),
    ).toBe("imaging");
    expect(
      classifyPendingRoughMemoryBucket({
        inputType: "lab_report",
        rawText: "Plain report text.",
      }),
    ).toBe("labs");
    expect(
      classifyPendingRoughMemoryBucket({
        inputType: "clinician_note",
        rawText: "New CT notes mention level II lymph nodes.",
      }),
    ).toBe("imaging");
    expect(
      classifyPendingRoughMemoryBucket({
        inputType: "clinician_note",
        rawText: "Patient has persistent hoarseness and throat pain.",
      }),
    ).toBe("history");
  });

  it("renders pending rough items alongside an existing memory snapshot", () => {
    const memory = mergePatientMemoryWithPendingRoughMemory(
      {
        categories: [
          {
            id: "history",
            items: ["Existing compacted history."],
            label: "Illness History and Current Course",
            summary: "Formal memory snapshot.",
          },
        ],
        generatedAt: "2026-07-09T00:00:00.000Z",
        inputCount: 1,
      },
      [
        {
          bucket: "imaging",
          case_id: "case-1",
          content: "CT shows right vocal cord thickening.",
          created_at: "2026-07-09T00:01:00.000Z",
          rough_item_id: "rough-1",
          source_case_input_id: "input-1",
          status: "pending",
        },
      ],
    );

    expect(memory.inputCount).toBe(2);
    expect(memory.categories).toEqual([
      expect.objectContaining({
        id: "history",
        items: ["Existing compacted history."],
      }),
      expect.objectContaining({
        id: "pending-imaging",
        items: ["CT shows right vocal cord thickening."],
      }),
    ]);
  });

    it("treats rough profile details as Basic Information clinical variables", () => {
      expect(
        classifyPendingRoughMemoryBucket({
          inputType: "clinician_note",
          rawText:
            "Baseline profile: 62-year-old male, height 172 cm, weight 61 kg, ECOG 1, former smoker.",
        }),
      ).toBe("profile");

      const memory = mergePatientMemoryWithPendingRoughMemory(
        {
          categories: [],
          generatedAt: "2026-07-09T00:00:00.000Z",
          inputCount: 0,
        },
        [
          {
            bucket: "profile",
            case_id: "case-1",
            content:
              "62-year-old male, height 172 cm, weight 61 kg, ECOG 1, former smoker.",
            created_at: "2026-07-09T00:01:00.000Z",
            rough_item_id: "rough-1",
            source_case_input_id: "input-1",
            status: "pending",
          },
        ],
      );

      expect(memory.categories).toEqual([
        expect.objectContaining({
          id: "profile",
          label: "Basic Information",
          items: [
            "62-year-old male, height 172 cm, weight 61 kg, ECOG 1, former smoker.",
          ],
        }),
      ]);
    });
});
