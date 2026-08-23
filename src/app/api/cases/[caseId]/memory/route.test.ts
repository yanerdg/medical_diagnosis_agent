import { closeDatabase } from "@/server/db";
import { createPendingRoughMemoryForCaseInput } from "@/server/memory/rough-memory";
import { MedicalRepository } from "@/server/repositories";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

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

describe("GET /api/cases/:caseId/memory", () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "medical-agent-memory-route-"));
    vi.stubEnv(
      "MEDICAL_AGENT_DATABASE_PATH",
      join(tempDirectory, "app.sqlite"),
    );
    vi.stubEnv("MEDICAL_AGENT_DATA_DIR", tempDirectory);
    closeDatabase();

    volcengineMocks.completeJson.mockReset();
    volcengineMocks.completeJson.mockResolvedValue(
      modelMemory("Explicitly refreshed memory."),
    );
    volcengineMocks.isConfigured.mockReset();
    volcengineMocks.isConfigured.mockReturnValue(true);

    const repository = new MedicalRepository();
    repository.saveCase({
      case_id: "case-1",
      created_at: timestamp,
      display_name: "Case 1",
      patient_ref: "patient-1",
      status: "draft",
      updated_at: timestamp,
    });
    const input = repository.createCaseInputFromRawText({
      case_id: "case-1",
      input_id: "input-1",
      input_type: "clinician_note",
      raw_text: "Patient reports persistent hoarseness.",
      submitted_at: timestamp,
    });
    createPendingRoughMemoryForCaseInput({
      input,
      rawText: "Patient reports persistent hoarseness.",
      repository,
    });
    repository.savePatientMemorySnapshot({
      case_id: "case-1",
      generated_at: timestamp,
      input_count: 1,
      is_stale: false,
      memory: {
        categories: [
          {
            id: "history",
            items: ["Existing compacted history."],
            label: "Illness History and Current Course",
            summary: "Existing formal memory snapshot.",
          },
        ],
        generatedAt: timestamp,
        inputCount: 1,
      },
      mode: "deterministic",
      source_fingerprint: "snapshot-fingerprint",
    });
  });

  afterEach(() => {
    closeDatabase();
    vi.unstubAllEnvs();
    rmSync(tempDirectory, { recursive: true, force: true });
  });

  it("reads latest snapshot plus pending rough memory without auto-refreshing", async () => {
    const context = {
      params: Promise.resolve({ caseId: "case-1" }),
    };

    const response = await GET(
      new Request("http://localhost/api/cases/case-1/memory"),
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      memory: {
        categories: [
          expect.objectContaining({
            items: ["Existing compacted history."],
          }),
          expect.objectContaining({
            id: "pending-history",
            items: ["Patient reports persistent hoarseness."],
          }),
        ],
      },
      mode: "deterministic",
      status: {
        pendingRoughItemCount: 1,
        refreshed: false,
      },
    });
    expect(volcengineMocks.completeJson).not.toHaveBeenCalled();

    const repository = new MedicalRepository();
    expect(repository.listPendingRoughMemoryItems("case-1")).toHaveLength(1);
  });

  it("manual refresh compacts pending rough memory without changing case inputs", async () => {
    const context = {
      params: Promise.resolve({ caseId: "case-1" }),
    };
    const refreshedResponse = await GET(
      new Request(
        "http://localhost/api/cases/case-1/memory?forceRefresh=true",
      ),
      context,
    );
    const refreshedBody = await refreshedResponse.json();

    expect(refreshedResponse.status).toBe(200);
    expect(refreshedBody).toMatchObject({
      memory: {
        categories: [
          expect.objectContaining({
            items: ["Explicitly refreshed memory."],
          }),
        ],
      },
      mode: "model",
      status: {
        compactedPendingItemCount: 1,
        pendingRoughItemCount: 0,
        refreshed: true,
      },
    });
    expect(volcengineMocks.completeJson).toHaveBeenCalledTimes(1);

    const repository = new MedicalRepository();
    expect(repository.listPendingRoughMemoryItems("case-1")).toEqual([]);
    expect(repository.listCaseInputs("case-1").map((input) => input.input_id)).toEqual([
      "input-1",
    ]);
    expect(
      repository.getLatestValidPatientMemorySnapshot(
        "case-1",
        refreshedBody.status.sourceFingerprint,
      ),
    ).toMatchObject({
      is_stale: false,
      memory: {
        categories: [
          expect.objectContaining({
            items: ["Explicitly refreshed memory."],
          }),
        ],
      },
      mode: "model",
    });
  });
});
