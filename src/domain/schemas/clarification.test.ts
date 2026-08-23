import { describe, expect, it } from "vitest";
import { clarificationRequestSchema } from ".";

function buildQuestion(id: string, priority: "high" | "medium" | "low" = "high") {
  return {
    id,
    priority,
    question: "请补充最近一次血常规、肌酐/eGFR、肝功能和白蛋白。",
    expected_answer_type: "report_upload",
    clinical_purpose: "用于判断化疗和综合治疗耐受性。",
    blocks_conclusion: true,
  };
}

describe("clarificationRequestSchema", () => {
  it("accepts a structured clinician clarification request", () => {
    const result = clarificationRequestSchema.safeParse({
      request_id: "clarification-1",
      reason: "缺少关键耐受性信息。",
      questions: [buildQuestion("question-1")],
    });

    expect(result.success).toBe(true);
  });

  it("limits clarification questions to one through five items", () => {
    expect(
      clarificationRequestSchema.safeParse({
        request_id: "clarification-empty",
        reason: "无问题。",
        questions: [],
      }).success,
    ).toBe(false);

    expect(
      clarificationRequestSchema.safeParse({
        request_id: "clarification-too-many",
        reason: "问题过多。",
        questions: Array.from({ length: 6 }, (_, index) =>
          buildQuestion(`question-${index + 1}`, "medium"),
        ),
      }).success,
    ).toBe(false);
  });

  it("requires priority, answer type, clinical purpose, and blocking flag", () => {
    const missingBlockingFlag = {
      ...buildQuestion("question-1"),
      blocks_conclusion: undefined,
    };

    expect(
      clarificationRequestSchema.safeParse({
        request_id: "clarification-missing-flag",
        reason: "缺少阻断标记。",
        questions: [missingBlockingFlag],
      }).success,
    ).toBe(false);

    expect(
      clarificationRequestSchema.safeParse({
        request_id: "clarification-bad-priority",
        reason: "优先级非法。",
        questions: [
          {
            ...buildQuestion("question-1"),
            priority: "urgent",
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      clarificationRequestSchema.safeParse({
        request_id: "clarification-bad-answer-type",
        reason: "答案类型非法。",
        questions: [
          {
            ...buildQuestion("question-1"),
            expected_answer_type: "image_upload",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
