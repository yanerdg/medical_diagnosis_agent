import { describe, expect, it } from "vitest";
import { evidenceModelSchema } from ".";

const validEvidence = {
  evidence_id: "evidence-1",
  case_id: "case-1",
  source_type: "ct_report",
  source_ref: "input-ct-1",
  field: "diagnostic_evidence.stage_clues",
  value: {
    site: "larynx",
    clues: ["声门区占位"],
  },
  quote: "CT 提示声门区占位。",
  confidence: 0.86,
  extracted_by: "agent",
  created_at: "2026-07-09T08:00:00.000Z",
};

describe("evidenceModelSchema", () => {
  it("accepts an auditable extracted clinical fact", () => {
    expect(evidenceModelSchema.safeParse(validEvidence).success).toBe(true);
  });

  it("requires quote, source, extractor, and bounded confidence", () => {
    expect(
      evidenceModelSchema.safeParse({
        ...validEvidence,
        quote: "",
      }).success,
    ).toBe(false);

    expect(
      evidenceModelSchema.safeParse({
        ...validEvidence,
        source_type: "web_search",
      }).success,
    ).toBe(false);

    expect(
      evidenceModelSchema.safeParse({
        ...validEvidence,
        extracted_by: "unreviewed_ai",
      }).success,
    ).toBe(false);

    expect(
      evidenceModelSchema.safeParse({
        ...validEvidence,
        confidence: 1.1,
      }).success,
    ).toBe(false);
  });
});
