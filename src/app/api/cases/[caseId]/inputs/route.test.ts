import { closeDatabase } from "@/server/db";
import { MedicalRepository } from "@/server/repositories";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const dialogMocks = vi.hoisted(() => ({
  generateHomepageDialogResponse: vi.fn(),
}));
const volcengineMocks = vi.hoisted(() => ({
  completeJson: vi.fn(),
  isConfigured: vi.fn(),
}));

vi.mock("@/server/dialog/homepage-dialog", () => ({
  generateHomepageDialogResponse: dialogMocks.generateHomepageDialogResponse,
}));
vi.mock("@/server/llm/volcengine-client", () => ({
  createVolcengineChatClient: () => ({
    completeJson: volcengineMocks.completeJson,
    isConfigured: volcengineMocks.isConfigured,
  }),
}));

const timestamp = "2026-07-09T00:00:00.000Z";

function modelMemory(item: string) {
  return JSON.stringify({
    categories: [
      {
        id: "history",
        items: [item],
        label: "Illness History and Current Course",
        summary: "Clinician-entered illness history.",
      },
    ],
  });
}

describe("POST /api/cases/:caseId/inputs", () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-input-route-"));
    vi.stubEnv(
      "MEDICAL_AGENT_DATABASE_PATH",
      join(tempDirectory, "app.sqlite"),
    );
    vi.stubEnv("MEDICAL_AGENT_DATA_DIR", tempDirectory);
    vi.stubEnv("VOLCENGINE_API_KEY", "");
    vi.stubEnv("VOLCENGINE_MODEL", "");
    closeDatabase();

    dialogMocks.generateHomepageDialogResponse.mockReset();
    dialogMocks.generateHomepageDialogResponse.mockResolvedValue(
      "Review pathology and request CT staging.",
    );
    volcengineMocks.completeJson.mockReset();
    volcengineMocks.completeJson.mockResolvedValue(
      modelMemory("Compacted threshold memory."),
    );
    volcengineMocks.isConfigured.mockReset();
    volcengineMocks.isConfigured.mockReturnValue(true);

    new MedicalRepository().saveCase({
      case_id: "case-1",
      created_at: timestamp,
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      updated_at: timestamp,
    });
  });

  afterEach(() => {
    closeDatabase();
    vi.unstubAllEnvs();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("creates clinician and Agent conversation messages for composer submissions", async () => {
    const response = await POST(
      new Request("http://localhost/api/cases/case-1/inputs", {
        body: JSON.stringify({
          input_type: "clinician_note",
          raw_text: "Patient reports persistent hoarseness.",
          run_agent_turn: true,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      {
        params: Promise.resolve({ caseId: "case-1" }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();

    expect(dialogMocks.generateHomepageDialogResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        currentClinicianInput: "Patient reports persistent hoarseness.",
        recentMessages: [],
      }),
    );
    expect(body).toMatchObject({
      agentMessage: {
        content: "Review pathology and request CT staging.",
        role: "agent",
      },
      clinicianMessage: {
        content: "Patient reports persistent hoarseness.",
        role: "clinician",
      },
      input: {
        case_id: "case-1",
        input_type: "clinician_note",
      },
      memoryStatus: {
        pendingRoughItemCount: 1,
        refreshed: false,
      },
    });
    expect(volcengineMocks.completeJson).not.toHaveBeenCalled();

    const messages = new MedicalRepository().listCaseConversationMessages(
      "case-1",
    );
    expect(messages).toMatchObject([
      {
        case_input_id: body.input.input_id,
        content: "Patient reports persistent hoarseness.",
        role: "clinician",
      },
      {
        case_input_id: undefined,
        content: "Review pathology and request CT staging.",
        role: "agent",
      },
    ]);

    const repository = new MedicalRepository();
    const pendingMemoryItems = repository.listPendingRoughMemoryItems("case-1");
    expect(pendingMemoryItems).toEqual([
      expect.objectContaining({
        content: "Patient reports persistent hoarseness.",
        source_case_input_id: body.input.input_id,
      }),
    ]);
    expect(JSON.stringify(pendingMemoryItems)).not.toContain(
      "Review pathology and request CT staging.",
    );
    expect(repository.listAssessmentRuns("case-1")).toEqual([]);
  });

  it("keeps workflow-only clinician questions out of case inputs and patient memory", async () => {
    const repository = new MedicalRepository();
    repository.createPendingRoughMemoryItem({
      bucket: "history",
      case_id: "case-1",
      content:
        "Existing context: 58-year-old male with persistent hoarseness and right vocal cord lesion.",
      created_at: timestamp,
    });

    const response = await POST(
      new Request("http://localhost/api/cases/case-1/inputs", {
        body: JSON.stringify({
          input_type: "clinician_note",
          raw_text: "这个患者还需要什么检验报告么",
          run_agent_turn: true,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      {
        params: Promise.resolve({ caseId: "case-1" }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();

    const dialogCall = dialogMocks.generateHomepageDialogResponse.mock
      .calls[0]?.[0];
    const serializedDialogMemory = JSON.stringify(dialogCall.memory);

    expect(serializedDialogMemory).toContain("persistent hoarseness");
    expect(serializedDialogMemory).toContain("right vocal cord lesion");
    expect(serializedDialogMemory).not.toContain("这个患者还需要什么检验报告么");
    expect(body.input).toBeNull();
    expect(body.clinicianMessage).toMatchObject({
      content: "这个患者还需要什么检验报告么",
      role: "clinician",
    });
    expect(body.clinicianMessage).not.toHaveProperty("caseInputId");

    const pendingItems = repository.listPendingRoughMemoryItems("case-1");
    expect(pendingItems.map((item) => item.content)).toEqual([
      "Existing context: 58-year-old male with persistent hoarseness and right vocal cord lesion.",
    ]);
    expect(repository.listCaseInputs("case-1")).toEqual([]);
  });

  it("creates multiple initial case inputs in one request without running an Agent turn", async () => {
    const response = await POST(
      new Request("http://localhost/api/cases/case-1/inputs", {
        body: JSON.stringify({
          inputs: [
            {
              input_type: "clinician_note",
              raw_text: "Persistent hoarseness for three months.",
            },
            {
              input_type: "ct_report",
              raw_text: "CT shows a right vocal cord lesion.",
            },
          ],
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      {
        params: Promise.resolve({ caseId: "case-1" }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();

    expect(body.inputs).toHaveLength(2);
    expect(body.inputs.map((input: { input_type: string }) => input.input_type)).toEqual([
      "clinician_note",
      "ct_report",
    ]);
    expect(dialogMocks.generateHomepageDialogResponse).not.toHaveBeenCalled();
    expect(volcengineMocks.completeJson).not.toHaveBeenCalled();

    const repository = new MedicalRepository();
    expect(repository.listCaseInputs("case-1")).toHaveLength(2);
    expect(repository.listCaseConversationMessages("case-1")).toHaveLength(0);
    expect(repository.listPendingRoughMemoryItems("case-1")).toHaveLength(2);
  });

  it("compacts pending rough memory when the fifth clinician input is saved", async () => {
    const response = await POST(
      new Request("http://localhost/api/cases/case-1/inputs", {
        body: JSON.stringify({
          inputs: [
            {
              input_type: "clinician_note",
              raw_text: "Persistent hoarseness for three months.",
            },
            {
              input_type: "ct_report",
              raw_text: "CT shows a right vocal cord lesion.",
            },
            {
              input_type: "pathology_biomarker",
              raw_text: "Biopsy confirms squamous cell carcinoma.",
            },
            {
              input_type: "lab_report",
              raw_text: "Albumin and creatinine are available.",
            },
            {
              input_type: "treatment_history",
              raw_text: "No prior radiotherapy or chemotherapy.",
            },
          ],
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
      {
        params: Promise.resolve({ caseId: "case-1" }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();

    expect(body.inputs).toHaveLength(5);
    expect(body.memoryStatus).toMatchObject({
      compactedPendingItemCount: 5,
      pendingRoughItemCount: 0,
      refreshed: true,
    });
    expect(volcengineMocks.completeJson).toHaveBeenCalledTimes(1);

    const repository = new MedicalRepository();
    expect(repository.listPendingRoughMemoryItems("case-1")).toEqual([]);
    expect(repository.getLatestPatientMemorySnapshot("case-1")).toMatchObject({
      memory: {
        categories: [
          expect.objectContaining({
            items: ["Compacted threshold memory."],
          }),
        ],
      },
      mode: "model",
    });
  });
});
