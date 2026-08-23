import type { PatientMemory } from "@/lib/clinical-memory";
import type { CaseConversationMessage } from "@/server/repositories/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelCallPolicies } from "../llm/model-paths";
import {
  type DialogModelOutput,
  dialogModelOutputSchema,
  generateHomepageDialogResponse,
  normalizeDialogModelOutput,
  renderClinicianDialogResponse,
} from "./homepage-dialog";

const volcengineMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  isConfigured: vi.fn(),
}));

vi.mock("../llm/volcengine-client", () => ({
  createVolcengineChatClient: () => ({
    complete: volcengineMocks.complete,
    isConfigured: volcengineMocks.isConfigured,
  }),
}));

type ModelMessage = {
  content: string;
  role: "system" | "user";
};

describe("generateHomepageDialogResponse", () => {
  beforeEach(() => {
    volcengineMocks.complete.mockReset();
    volcengineMocks.complete.mockResolvedValue(JSON.stringify(modelOutput()));
    volcengineMocks.isConfigured.mockReset();
    volcengineMocks.isConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requests dialog JSON and renders an auditable clinical summary", async () => {
    const result = await generateHomepageDialogResponse({
      currentClinicianInput: "声音嘶哑持续三个月。",
      memory: patientMemory(),
      recentMessages: recentMessages(),
    });

    expect(result).toContain(
      "Current understanding（已确认事实）：声音嘶哑持续三个月",
    );
    expect(result).toContain(
      "Key uncertainty（关键不确定性）：尚未提供病理和影像分期依据",
    );
    expect(result).toContain(
      "Suggested next step（建议下一步）：补充喉镜、病理和颈胸部增强影像资料。",
    );
    expect(result).toContain("Necessary questions（必要追问）：");
    expect(result).not.toContain(
      "当前信息提示需先补齐病理和增强影像，再判断分期准备度。",
    );
    expect(volcengineMocks.complete).toHaveBeenCalledWith(
      expect.any(Array),
      "dialog",
    );
    expect(modelCallPolicies.dialog.responseFormat).toBe("json_object");

    const modelMessages = volcengineMocks.complete.mock
      .calls[0]?.[0] as ModelMessage[] | undefined;
    const systemMessage = modelMessages?.find(
      (message) => message.role === "system",
    );

    expect(systemMessage?.content).toContain("Output only a JSON object");
    expect(systemMessage?.content).toContain('"clinician_response"');
    expect(systemMessage?.content).toContain("throat cancer specialty");
    expect(systemMessage?.content).toContain("laryngeal");
    expect(systemMessage?.content).toContain("hypopharyngeal");
    expect(systemMessage?.content).toContain("oropharyngeal");
    expect(systemMessage?.content).toContain(
      "Use only the current clinician input, recalled patient memory, and bounded recent conversation",
    );
    expect(systemMessage?.content).toContain(
      "Do not treat any full conversation history, unseen chart, external guideline text, or unstated patient fact as available context",
    );
    expect(systemMessage?.content).toContain("Prompt-only testing mode");
    expect(systemMessage?.content).toContain(
      "use this prompt-embedded checklist only as workflow guidance, not as patient-specific evidence",
    );
    expect(systemMessage?.content).toContain("primary site and laterality");
    expect(systemMessage?.content).toContain("hearing status");
    expect(systemMessage?.content).toContain(
      "Do not invent, infer as certain, or fill in missing pathology, imaging, endoscopy, TNM stage, treatment response, contraindications, or laboratory values",
    );
    expect(systemMessage?.content).toContain(
      "Do not produce a complete staging report",
    );
    expect(systemMessage?.content).toContain("long-term memory update");
  });

  it("defines the required structured dialog fields", () => {
    expect(
      dialogModelOutputSchema.safeParse({
        clinician_response: "请补充病理和影像。",
        evidence_used: ["current input"],
        intent: "clarify",
        new_facts: [],
        next_step: "补充病理。",
        questions: [
          {
            clinical_purpose: "确认诊断依据。",
            priority: "high",
            question: "是否已有活检病理？",
          },
        ],
        risk_flags: [],
        uncertainties: [],
      }).success,
    ).toBe(true);
  });

  it("normalizes array lengths and limits prioritized questions to three", () => {
    const result = normalizeDialogModelOutput(
      JSON.stringify(
        modelOutput({
          evidence_used: [
            "current input",
            "memory",
            "recent conversation",
            "pathology",
            "imaging",
            "extra item",
          ],
          questions: Array.from({ length: 4 }, (_, index) => ({
            clinical_purpose: `purpose-${index}`,
            priority: index === 0 ? "high" : "medium",
            question: `question-${index}`,
          })),
        }),
      ),
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.output.evidence_used).toHaveLength(5);
      expect(result.output.questions).toHaveLength(3);
      expect(result.output.questions.map((question) => question.priority)).toEqual([
        "high",
        "medium",
        "medium",
      ]);
    }
  });

  it("filters questions that miss clinical purpose or priority", () => {
    const result = normalizeDialogModelOutput(
      JSON.stringify({
        ...modelOutput(),
        questions: [
          {
            clinical_purpose: "确认是否已有病理诊断。",
            priority: "high",
            question: "是否已有活检病理？",
          },
          {
            priority: "medium",
            question: "是否已有增强 CT？",
          },
          {
            clinical_purpose: "评估气道风险。",
            question: "是否存在喘鸣或呼吸困难？",
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.output.questions).toEqual([
        {
          clinical_purpose: "确认是否已有病理诊断。",
          priority: "high",
          question: "是否已有活检病理？",
        },
      ]);
    }
  });

  it("returns a safe fallback and preserves clinician input when model output is invalid JSON", async () => {
    volcengineMocks.complete.mockResolvedValue("I cannot produce JSON.");

    const result = await generateHomepageDialogResponse({
      currentClinicianInput: "患者声音嘶哑三个月，想知道下一步。",
      memory: patientMemory(),
      recentMessages: recentMessages(),
    });

    expect(result).toContain("目前证据不足以形成确定的 TNM 分期");
    expect(result).toContain("已保留本次医生输入：患者声音嘶哑三个月，想知道下一步。");
  });

  it("returns a safe fallback for unsupported definitive staging or treatment claims", async () => {
    volcengineMocks.complete.mockResolvedValue(
      JSON.stringify(
        modelOutput({
          clinician_response:
            "患者为 T3N2M0，临床分期 IVA，建议立即同步放化疗。",
          next_step: "直接进入同步放化疗。",
        }),
      ),
    );

    const result = await generateHomepageDialogResponse({
      currentClinicianInput: "患者声音嘶哑三个月，尚未提供病理和影像。",
      memory: patientMemory(),
      recentMessages: recentMessages(),
    });

    expect(result).toContain("目前证据不足以形成确定的 TNM 分期");
    expect(result).toContain(
      "已保留本次医生输入：患者声音嘶哑三个月，尚未提供病理和影像。",
    );
    expect(result).not.toContain("T3N2M0");
    expect(result).not.toContain("同步放化疗");
  });

  it("returns a safe fallback for complete staging or treatment report-shaped output", async () => {
    volcengineMocks.complete.mockResolvedValue(
      JSON.stringify(
        modelOutput({
          clinician_response: [
            "Staging Report:",
            "TNM: cannot be finalized because pathology and imaging are pending.",
            "Treatment Recommendations:",
            "No definitive treatment recommendation can be made yet.",
          ].join("\n"),
          next_step:
            "Complete staging report after collecting pathology and imaging.",
        }),
      ),
    );

    const result = await generateHomepageDialogResponse({
      currentClinicianInput: "患者声音嘶哑三个月，尚未提供病理和影像。",
      memory: patientMemory(),
      recentMessages: recentMessages(),
    });

    expect(result).toContain("目前证据不足以形成确定的 TNM 分期");
    expect(result).toContain(
      "已保留本次医生输入：患者声音嘶哑三个月，尚未提供病理和影像。",
    );
    expect(result).not.toContain("Staging Report:");
    expect(result).not.toContain("Treatment Recommendations:");
  });

  it("allows conditional next-step support without treating it as a formal report", () => {
    const result = normalizeDialogModelOutput(
      JSON.stringify(
        modelOutput({
          clinician_response:
            "当前资料只能支持条件性下一步：请先补充病理、喉镜和颈胸部增强影像，暂不形成完整分期或治疗建议报告。",
          next_step: "补充病理、喉镜和颈胸部增强影像。",
        }),
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("does not print dialog debug logs unless explicitly enabled", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await generateHomepageDialogResponse({
      currentClinicianInput: "声音嘶哑持续三个月。",
      memory: patientMemory(),
      recentMessages: recentMessages(),
    });

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("prints redacted question and answer previews when dialog debug is enabled", async () => {
    vi.stubEnv("YENHO_DIALOG_DEBUG", "1");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    volcengineMocks.complete.mockResolvedValue(
      JSON.stringify(
        modelOutput({
          questions: [
            {
              clinical_purpose:
                "确认 MOCK-BASIC-INFO-001 的 58 岁患者是否已有分期基础证据。",
              priority: "high",
              question:
                "MOCK-BASIC-INFO-001 是否已有 2026-07-15 的喉镜描述和活检病理？",
            },
          ],
        }),
      ),
    );

    await generateHomepageDialogResponse({
      currentClinicianInput: "患者 MOCK-BASIC-INFO-001，58 岁，声音嘶哑。",
      memory: patientMemory(),
      recentMessages: recentMessages(),
    });

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      "[YenHo dialog debug]",
      expect.any(String),
    );

    const loggedPayload = infoSpy.mock.calls[0]?.[1] as string | undefined;

    expect(loggedPayload).toContain('"status": "ok"');
    expect(loggedPayload).toContain('"questions"');
    expect(loggedPayload).toContain("[id]");
    expect(loggedPayload).toContain("[num]");
    expect(loggedPayload).not.toContain("MOCK-BASIC-INFO-001");
    expect(loggedPayload).not.toContain("58");
    expect(loggedPayload).not.toContain("2026-07-15");
  });
});

describe("renderClinicianDialogResponse", () => {
  it("renders explicit warnings for airway, bleeding, severe dysphagia, and rapid worsening risk flags", () => {
    const result = renderClinicianDialogResponse(
      modelOutput({
        risk_flags: [
          "气道受限伴喘鸣",
          "活动性出血",
          "严重吞咽困难",
          "症状快速恶化",
        ],
      }),
    );

    expect(result).toContain("Risk flags（需立即核对/处置）");
    expect(result).toContain("气道受限");
    expect(result).toContain("活动性出血");
    expect(result).toContain("严重吞咽困难");
    expect(result).toContain("快速恶化");
    expect(result).toContain("优先评估气道安全");
    expect(result).toContain("急诊止血/转诊需求");
    expect(result).toContain("脱水、营养和安全进食需求");
    expect(result).toContain("排除急症进展");
  });

  it("keeps confirmed facts separate from missing or uncertain evidence", () => {
    const result = renderClinicianDialogResponse(
      modelOutput({
        new_facts: ["声音嘶哑持续三个月"],
        uncertainties: ["未提供活检病理", "未提供颈胸部增强影像"],
      }),
    );

    expect(result).toContain(
      "Current understanding（已确认事实）：声音嘶哑持续三个月",
    );
    expect(result).toContain(
      "Key uncertainty（关键不确定性）：未提供活检病理；未提供颈胸部增强影像",
    );
    expect(result).not.toContain("已确认事实）：声音嘶哑持续三个月；未提供活检病理");
    expect(result).not.toContain("病理证实");
  });
});

function modelOutput(
  overrides: Partial<DialogModelOutput> = {},
): DialogModelOutput {
  return {
    clinician_response:
      "当前信息提示需先补齐病理和增强影像，再判断分期准备度。",
    evidence_used: ["current_clinician_input"],
    intent: "clarify_staging_readiness",
    new_facts: ["声音嘶哑持续三个月"],
    next_step: "补充喉镜、病理和颈胸部增强影像资料。",
    questions: [
      {
        clinical_purpose: "确认是否已有诊断和分期基础证据。",
        priority: "high",
        question: "是否已有喉镜描述和活检病理？",
      },
    ],
    risk_flags: [],
    uncertainties: ["尚未提供病理和影像分期依据"],
    ...overrides,
  };
}

function patientMemory(): PatientMemory {
  return {
    categories: [
      {
        id: "history",
        items: ["声音嘶哑持续三个月。"],
        label: "Illness History and Current Course",
        summary: "Current symptoms.",
      },
    ],
    generatedAt: "2026-07-09T00:00:00.000Z",
    inputCount: 1,
  };
}

function recentMessages(): CaseConversationMessage[] {
  return [
    {
      case_id: "case-1",
      content: "是否已有病理？",
      created_at: "2026-07-09T00:01:00.000Z",
      message_id: "message-1",
      role: "agent",
    },
  ];
}
