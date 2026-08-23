import type { BuildPatientMemoryParams } from "@/lib/clinical-memory";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPatientMemoryWithModel } from "./model-memory";

const volcengineMocks = vi.hoisted(() => ({
  completeJson: vi.fn(),
  isConfigured: vi.fn(),
}));

vi.mock("@/server/llm/volcengine-client", () => ({
  createVolcengineChatClient: () => ({
    completeJson: volcengineMocks.completeJson,
    isConfigured: volcengineMocks.isConfigured,
  }),
}));

const validModelMemory = {
  categories: [
    {
      id: "pathology",
      items: ["Squamous cell carcinoma confirmed by pathology."],
      label: "Pathology and Molecular Biomarkers",
      summary: "Pathology confirmation is available.",
    },
  ],
};

type ModelMessage = {
  content: string;
  role: "system" | "user";
};

describe("buildPatientMemoryWithModel", () => {
  beforeEach(() => {
    volcengineMocks.completeJson.mockReset();
    volcengineMocks.completeJson.mockResolvedValue(JSON.stringify(validModelMemory));
    volcengineMocks.isConfigured.mockReset();
    volcengineMocks.isConfigured.mockReturnValue(true);
  });

  it("sends only restricted memory-write candidates without Agent responses or full conversation history", async () => {
    const params: BuildPatientMemoryParams = {
      agentRounds: [
        {
          answers: [
            {
              answerText: "Squamous cell carcinoma confirmed by pathology.",
              markedUnknown: false,
              questionId: "q-1",
            },
          ],
          createdAt: "2026-07-09T00:02:00.000Z",
          questions: [
            {
              clinicalPurpose: "pathology confirmation",
              id: "q-1",
              question:
                "Agent follow-up question that must not become memory fact.",
            },
          ],
          reason: "Agent reasoning that should not be persisted as memory.",
          requestId: "request-1",
        },
      ],
      caseRecord: {
        display_name: "Case 1",
        patient_ref: "patient-1",
        status: "draft",
        updated_at: "2026-07-09T00:03:00.000Z",
      },
      inputs: [
        {
          inputId: "input-1",
          inputType: "clinician_note",
          rawText: "Patient has persistent hoarseness and throat pain.",
          submittedAt: "2026-07-09T00:01:00.000Z",
        },
      ],
    };

    await buildPatientMemoryWithModel(params);

    const modelMessages = volcengineMocks.completeJson.mock
      .calls[0]?.[0] as ModelMessage[] | undefined;
    expect(modelMessages).toHaveLength(2);

    const userMessage = modelMessages?.find((message) => message.role === "user");
    expect(userMessage).toBeDefined();

    const payload = JSON.parse(userMessage?.content ?? "{}") as {
      case: unknown;
      full_conversation?: unknown;
      memory_write_context: {
        candidates: Array<{ source: string; text: string }>;
        gaps: unknown[];
      };
      messages?: unknown;
      recent_conversation?: unknown;
    };

    expect(Object.keys(payload).sort()).toEqual([
      "case",
      "memory_write_context",
    ]);
    expect(payload.full_conversation).toBeUndefined();
    expect(payload.messages).toBeUndefined();
    expect(payload.recent_conversation).toBeUndefined();
    expect(payload.memory_write_context.candidates).toEqual([
      expect.objectContaining({
        source: "case_input",
        text: "Patient has persistent hoarseness and throat pain.",
      }),
      expect.objectContaining({
        source: "clinician_answer",
        text: "Squamous cell carcinoma confirmed by pathology.",
      }),
    ]);

    const serializedContext = JSON.stringify(payload.memory_write_context);
    expect(serializedContext).not.toContain(
      "Agent follow-up question that must not become memory fact.",
    );
    expect(serializedContext).not.toContain(
      "Agent reasoning that should not be persisted as memory.",
    );
  });

  it("instructs the model to exclude case metadata from clinical memory", async () => {
    await buildPatientMemoryWithModel(params());

    const modelMessages = volcengineMocks.completeJson.mock
      .calls[0]?.[0] as ModelMessage[] | undefined;
    const systemMessage = modelMessages?.find(
      (message) => message.role === "system",
    );

    expect(systemMessage?.content).toContain(
      "Do not write system metadata into clinical memory",
    );
    expect(systemMessage?.content).toContain(
      "The profile / Basic Information category is only for patient clinical variables",
    );
    expect(systemMessage?.content).toContain("age, sex, height, weight");
    expect(systemMessage?.content).toContain("case name");
    expect(systemMessage?.content).toContain("patient reference");
    expect(systemMessage?.content).toContain("case status");
  });

  it("filters model-generated system metadata from Patient Memory categories", async () => {
    volcengineMocks.completeJson.mockResolvedValue(
      JSON.stringify({
        categories: [
          {
            id: "profile",
            items: [
              "Case name: Case 1",
              "Patient reference: patient-1",
              "Case status: draft",
              "62-year-old male, ECOG 1, former smoker.",
            ],
            label: "Basic Information",
            summary: "Patient profile variables.",
          },
        ],
      }),
    );

    const result = await buildPatientMemoryWithModel(params());

    expect(result.mode).toBe("model");
    expect(result.memory.categories).toEqual([
      expect.objectContaining({
        id: "profile",
        items: ["62-year-old male, ECOG 1, former smoker."],
      }),
    ]);
    expect(JSON.stringify(result.memory.categories)).not.toContain("Case name");
    expect(JSON.stringify(result.memory.categories)).not.toContain(
      "Patient reference",
    );
    expect(JSON.stringify(result.memory.categories)).not.toContain("Case status");
    expect(JSON.stringify(result.memory.categories)).not.toContain("patient-1");
  });
});

function params(): BuildPatientMemoryParams {
  return {
    agentRounds: [],
    caseRecord: {
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      updated_at: "2026-07-09T00:03:00.000Z",
    },
    inputs: [
      {
        inputId: "input-1",
        inputType: "demographics",
        rawText: "62-year-old male, ECOG 1, former smoker.",
        submittedAt: "2026-07-09T00:01:00.000Z",
      },
    ],
  };
}
