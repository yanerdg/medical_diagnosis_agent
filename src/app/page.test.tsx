import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeWorkspace, type PatientConversationSummary } from "./home-workspace";
import Home from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Home", () => {
  it("renders the patient conversation workspace", () => {
    render(<Home />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "YenHo",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("your throat cancer diagnosis agent"),
    ).toBeInTheDocument();
    expect(screen.getByText("Case Management")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "v0.1" })).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Patient name regex search" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("View system capability notes")).not.toBeInTheDocument();
    expect(screen.queryByText("/api/health")).not.toBeInTheDocument();
  });

  it("refreshes Patient Memory from the Details top sheet", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => memoryResponse(url.includes("forceRefresh=true")),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<HomeWorkspace conversations={[conversation]} />);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    await screen.findByText(/Model organized/);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/cases/case-1/memory",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh patient memory" }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/cases/case-1/memory?forceRefresh=true",
      );
    });
    await screen.findByText(/Model refreshed/);
  });

  it("keeps case metadata in Details cards outside Clinical Memory", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => memoryResponse(false),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomeWorkspace conversations={[conversation]} />);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    await screen.findByText(/Model organized/);
    expect(screen.getByText("Patient / Case")).toBeInTheDocument();
    expect(screen.getByText("Patient Reference")).toBeInTheDocument();
    expect(screen.getByText("patient-1")).toBeInTheDocument();
    expect(screen.getByText("Case Status")).toBeInTheDocument();
    expect(screen.getAllByText("draft").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Clinical Memory")).toBeInTheDocument();
    const clinicalMemorySection = screen
      .getByText("Clinical Memory")
      .closest("section");
    expect(clinicalMemorySection).not.toBeNull();

    const clinicalMemory = within(clinicalMemorySection as HTMLElement);
    expect(clinicalMemory.queryByText("Case name: Case 1")).not.toBeInTheDocument();
    expect(
      clinicalMemory.queryByText("Patient reference: patient-1"),
    ).not.toBeInTheDocument();
    expect(clinicalMemory.queryByText("Case status: draft")).not.toBeInTheDocument();
  });
});

function memoryResponse(refreshed: boolean) {
  return {
    memory: patientMemory("Refreshed explicit snapshot."),
    mode: "model",
    status: {
      generatedAt: "2026-07-09T00:02:00.000Z",
      isStale: false,
      mode: "model",
      pendingRoughItemCount: 0,
      refreshed,
      sourceFingerprint: "fingerprint-a",
    },
  };
}

function patientMemory(item: string) {
  return {
    categories: [
      {
        id: "history",
        items: [item],
        label: "Illness History and Current Course",
        summary: "Clinician-entered illness history.",
      },
    ],
    generatedAt: "2026-07-09T00:01:00.000Z",
    inputCount: 1,
  };
}

const conversation: PatientConversationSummary = {
  agentRounds: [],
  caseId: "case-1",
  displayName: "Case 1",
  inputCount: 1,
  inputs: [
    {
      inputId: "input-1",
      inputType: "clinician_note",
      rawText: "Patient reports persistent hoarseness.",
      submittedAt: "2026-07-09T00:00:00.000Z",
    },
  ],
  memory: patientMemory("Initial local memory."),
  messages: [],
  patientRef: "patient-1",
  status: "draft",
  updatedAt: "2026-07-09T00:00:00.000Z",
};
