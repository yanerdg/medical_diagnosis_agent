import type {
  ClinicalMemoryInput,
  ClinicalMemoryRound,
  PatientMemory,
} from "@/lib/clinical-memory";
import { describe, expect, it } from "vitest";
import {
  buildRestrictedMemoryWriteContext,
  recallPatientMemory,
} from "./memory-policy";

describe("buildRestrictedMemoryWriteContext", () => {
  it("uses only case inputs and clinician answers as long-term memory candidates", () => {
    const inputs: ClinicalMemoryInput[] = [
      {
        inputId: "input-1",
        inputType: "clinician_note",
        rawText: "Patient reports persistent hoarseness for three months.",
        submittedAt: "2026-07-09T00:01:00.000Z",
      },
    ];
    const agentRounds: ClinicalMemoryRound[] = [
      {
        answers: [
          {
            answerText: "Biopsy confirms squamous cell carcinoma.",
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
              "Dialog new_facts: T3N2M0 and treatment recommendation should not become memory.",
          },
        ],
        reason:
          "Dialog reasoning summary, clinical summary, and staging/treatment recommendation draft must stay outside memory_write facts.",
        requestId: "request-1",
      },
    ];

    const context = buildRestrictedMemoryWriteContext({ agentRounds, inputs });

    expect(context.candidates).toEqual([
      {
        categoryHint: "clinician_note",
        id: "input:input-1",
        source: "case_input",
        text: "Patient reports persistent hoarseness for three months.",
      },
      {
        categoryHint: "pathology confirmation",
        id: "answer:request-1:q-1",
        source: "clinician_answer",
        text: "Biopsy confirms squamous cell carcinoma.",
      },
    ]);
    expect(JSON.stringify(context.candidates)).not.toContain("Dialog new_facts");
    expect(JSON.stringify(context.candidates)).not.toContain("T3N2M0");
    expect(JSON.stringify(context.candidates)).not.toContain(
      "treatment recommendation",
    );
    expect(JSON.stringify(context.candidates)).not.toContain(
      "Dialog reasoning summary",
    );
    expect(JSON.stringify(context.candidates)).not.toContain(
      "clinical summary",
    );
  });

  it("keeps unanswered Agent questions as gaps instead of factual memory", () => {
    const context = buildRestrictedMemoryWriteContext({
      agentRounds: [
        {
          answers: [],
          createdAt: "2026-07-09T00:02:00.000Z",
          questions: [
            {
              clinicalPurpose: "airway risk clarification",
              id: "q-2",
              question: "是否存在喘鸣、静息呼吸困难或近期窒息发作？",
            },
          ],
          reason: "Clarify risk before any formal assessment.",
          requestId: "request-2",
        },
      ],
      inputs: [],
    });

    expect(context.candidates).toEqual([]);
    expect(context.gaps).toEqual([
      {
        clinicalPurpose: "airway risk clarification",
        id: "gap:request-2:q-2",
        question: "是否存在喘鸣、静息呼吸困难或近期窒息发作？",
      },
    ]);
  });
});

describe("recallPatientMemory", () => {
  it("recalls core patient context for broad report and lab gap questions", () => {
    const memory: PatientMemory = {
      categories: [
        {
          id: "pending-history",
          items: ["还需要什么检验报告么"],
          label: "Pending History",
          summary: "Recent clinician-authored question awaiting compaction.",
        },
        {
          id: "history",
          items: ["58-year-old male with persistent hoarseness for 3 months."],
          label: "Illness History and Current Course",
          summary: "Current symptoms and course.",
        },
        {
          id: "ct",
          items: ["CT shows right vocal cord lesion with anterior commissure involvement."],
          label: "CT Summary",
          summary: "Imaging information for staging.",
        },
        {
          id: "labs",
          items: ["Creatinine and albumin are available."],
          label: "Monitoring Markers and Baseline Labs",
          summary: "Baseline labs.",
        },
      ],
      generatedAt: "2026-07-09T00:00:00.000Z",
      inputCount: 4,
    };

    const recalled = recallPatientMemory(memory, "还需要什么检验报告么");

    expect(recalled.map((category) => category.id)).toEqual([
      "history",
      "pending-history",
      "ct",
      "labs",
    ]);
    expect(JSON.stringify(recalled)).toContain("persistent hoarseness");
    expect(JSON.stringify(recalled)).toContain("right vocal cord lesion");
    expect(JSON.stringify(recalled)).toContain("Creatinine and albumin");
  });
});
