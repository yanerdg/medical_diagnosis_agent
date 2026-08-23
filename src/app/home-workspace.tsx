"use client";

import type { CaseInput, CaseRecord } from "@/domain/schemas";
import type {
  ClinicalMemoryInput,
  PatientMemory,
  PatientMemoryCategory,
} from "@/lib/clinical-memory";
import { buildPatientMemory } from "@/lib/clinical-memory";
import { initialCaseInputFields } from "@/lib/case-inputs";
import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

type ConversationInputSummary = ClinicalMemoryInput;

interface ConversationMessageSummary {
  messageId: string;
  role: "clinician" | "agent";
  content: string;
  caseInputId?: string;
  createdAt: string;
}

interface AgentQuestionSummary {
  id: string;
  question: string;
  clinicalPurpose: string;
}

interface AgentAnswerSummary {
  responseId: string;
  questionId: string;
  answerText?: string;
  markedUnknown: boolean;
  submittedAt: string;
}

interface AgentRoundSummary {
  requestId: string;
  reason: string;
  createdAt: string;
  questions: AgentQuestionSummary[];
  answers: AgentAnswerSummary[];
}

export interface PatientConversationSummary {
  caseId: string;
  displayName: string;
  patientRef?: string;
  status: CaseRecord["status"];
  inputCount: number;
  inputs: ConversationInputSummary[];
  agentRounds: AgentRoundSummary[];
  messages: ConversationMessageSummary[];
  memory: PatientMemory;
  updatedAt: string;
}

interface HomeWorkspaceProps {
  conversations: PatientConversationSummary[];
}

interface CreateCaseResponse {
  case: CaseRecord;
}

interface CreateCaseInputsResponse {
  inputs: CaseInput[];
}

interface ConversationTurnResponse {
  agentError?: string;
  agentMessage: ConversationMessageSummary | null;
  clinicianMessage: ConversationMessageSummary;
  input: CaseInput | null;
  memoryStatus: PatientMemoryStatus;
}

interface PatientMemoryResponse {
  memory: PatientMemory;
  mode: "model" | "deterministic" | "fallback";
  status: PatientMemoryStatus;
}

interface PatientMemoryStatus {
  mode: "model" | "deterministic" | "fallback";
  sourceFingerprint: string;
  generatedAt: string;
  isStale: boolean;
  refreshed: boolean;
  pendingRoughItemCount: number;
  compactedPendingItemCount?: number;
}

export function HomeWorkspace({ conversations }: HomeWorkspaceProps) {
  const router = useRouter();
  const [conversationList, setConversationList] = useState(conversations);
  const [activeCaseId, setActiveCaseId] = useState<string | null>(
    conversations[0]?.caseId ?? null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAppending, setIsAppending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appendErrorMessage, setAppendErrorMessage] = useState<string | null>(
    null,
  );
  const [agentErrorMessage, setAgentErrorMessage] = useState<string | null>(null);
  const [searchPattern, setSearchPattern] = useState("");
  const [pendingDeleteCaseId, setPendingDeleteCaseId] = useState<string | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const searchResult = filterConversationsByName(conversationList, searchPattern);
  const activeConversation =
    conversationList.find((conversation) => conversation.caseId === activeCaseId) ??
    null;
  const pendingDeleteConversation =
    conversationList.find(
      (conversation) => conversation.caseId === pendingDeleteCaseId,
    ) ?? null;

  async function handleConfirmDelete() {
    if (!pendingDeleteCaseId) {
      return;
    }

    setIsDeleting(true);

    try {
      const response = await fetch(
        `/api/cases/${encodeURIComponent(pendingDeleteCaseId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { message?: string }
          | null;
        throw new Error(payload?.message ?? "Delete failed.");
      }

      const remaining = conversationList.filter(
        (conversation) => conversation.caseId !== pendingDeleteCaseId,
      );
      setConversationList(remaining);
      if (activeCaseId === pendingDeleteCaseId) {
        setActiveCaseId(remaining[0]?.caseId ?? null);
      }
      setPendingDeleteCaseId(null);
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "An error occurred while deleting the case.",
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);
    const displayName = getFormValue(formData, "display_name").trim();
    const patientRef = getFormValue(formData, "patient_ref").trim();
    const inputDrafts = initialCaseInputFields
      .map((field) => ({
        inputType: field.input_type,
        rawText: getFormValue(formData, field.input_type).trim(),
      }))
      .filter((input) => input.rawText.length > 0);

    if (!displayName) {
      setErrorMessage("Please enter a patient or case name first.");
      return;
    }

    if (inputDrafts.length === 0) {
      setErrorMessage("Please provide at least one category of initial case material.");
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const createdCase = await postJson<CreateCaseResponse>("/api/cases", {
        display_name: displayName,
        ...(patientRef ? { patient_ref: patientRef } : {}),
      });

      const now = new Date().toISOString();
      const response = await postJson<CreateCaseInputsResponse>(
        `/api/cases/${encodeURIComponent(createdCase.case.case_id)}/inputs`,
        {
          inputs: inputDrafts.map((draft) => ({
            input_type: draft.inputType,
            raw_text: draft.rawText,
          })),
        },
      );
      const rawTextByInputType = new Map<string, string>(
        inputDrafts.map((draft) => [draft.inputType, draft.rawText]),
      );
      const savedInputs: ConversationInputSummary[] = response.inputs.map(
        (input) => ({
          inputId: input.input_id,
          inputType: input.input_type,
          rawText: rawTextByInputType.get(input.input_type) ?? "",
          submittedAt: input.submitted_at,
        }),
      );

      const nextConversation: PatientConversationSummary = {
        caseId: createdCase.case.case_id,
        displayName: createdCase.case.display_name,
        patientRef: createdCase.case.patient_ref,
        status: createdCase.case.status,
        inputCount: savedInputs.length,
        inputs: savedInputs,
        agentRounds: [],
        messages: [],
        memory: buildPatientMemory({
          agentRounds: [],
          caseRecord: {
            display_name: createdCase.case.display_name,
            patient_ref: createdCase.case.patient_ref,
            status: createdCase.case.status,
            updated_at: now,
          },
          inputs: savedInputs,
        }),
        updatedAt: now,
      };

      setConversationList((current) => [nextConversation, ...current]);
      setActiveCaseId(nextConversation.caseId);
      form.reset();
      setIsSubmitting(false);
      router.refresh();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Failed to create the case conversation. Please try again later.",
      );
      setIsSubmitting(false);
    }
  }

  async function handleAppendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activeConversation) {
      return;
    }

    const form = event.currentTarget;
    const formData = new FormData(form);
    const message = getFormValue(formData, "followup_message").trim();

    if (!message) {
      setAppendErrorMessage("Please enter the case information to add.");
      return;
    }

    setIsAppending(true);
    setAppendErrorMessage(null);
    setAgentErrorMessage(null);

    try {
      const response = await postJson<ConversationTurnResponse>(
        `/api/cases/${encodeURIComponent(activeConversation.caseId)}/inputs`,
        {
          input_type: "clinician_note",
          raw_text: message,
          run_agent_turn: true,
        },
      );

      setConversationList((current) =>
        current.map((conversation) => {
          if (conversation.caseId !== activeConversation.caseId) {
            return conversation;
          }

          const nextInputs: ConversationInputSummary[] = response.input
            ? [
                {
                  inputId: response.input.input_id,
                  inputType: "clinician_note",
                  rawText: message,
                  submittedAt: response.input.submitted_at,
                },
                ...conversation.inputs,
              ]
            : conversation.inputs;
          const nextMessages = [
            ...conversation.messages,
            response.clinicianMessage,
            ...(response.agentMessage ? [response.agentMessage] : []),
          ];
          const updatedAt =
            response.input?.submitted_at ?? response.clinicianMessage.createdAt;

          return {
            ...conversation,
            inputCount: response.input
              ? conversation.inputCount + 1
              : conversation.inputCount,
            inputs: nextInputs,
            memory: response.input
              ? buildPatientMemory({
                  agentRounds: conversation.agentRounds,
                  caseRecord: {
                    display_name: conversation.displayName,
                    patient_ref: conversation.patientRef,
                    status: conversation.status,
                    updated_at: updatedAt,
                  },
                  inputs: nextInputs,
                })
              : conversation.memory,
            messages: nextMessages,
            updatedAt,
          };
        }),
      );
      if (response.agentError) {
        setAgentErrorMessage(response.agentError);
      }
      form.reset();
      setIsAppending(false);
      router.refresh();
    } catch (error) {
      setAgentErrorMessage(null);
      setAppendErrorMessage(
        error instanceof Error ? error.message : "Failed to save the additional information. Please try again later.",
      );
      setIsAppending(false);
    }
  }

  return (
    <section className="grid flex-1 gap-5 lg:min-h-0 lg:grid-cols-[420px_minmax(0,1fr)] xl:grid-cols-[460px_minmax(0,1fr)] 2xl:grid-cols-[500px_minmax(0,1fr)]">
      <aside className="flex min-h-[560px] flex-col rounded-[2rem] border border-white/70 bg-white/72 p-5 shadow-card backdrop-blur-xl lg:min-h-0">
        <div className="flex h-8 items-center gap-3">
          <h2 className="shrink-0 text-xl font-bold leading-8 text-foreground">
            Case Management
          </h2>
          <button
            className="glass-ink-button flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold text-white transition"
            onClick={() => setActiveCaseId(null)}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.4"
              viewBox="0 0 24 24"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            New
          </button>
          <label className="sr-only" htmlFor="patient-name-search">
            Patient name regex search
          </label>
          <div className="relative ml-auto min-w-0 flex-1 max-w-52">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="h-8 w-full rounded-full border border-white/80 bg-white/75 pl-8 pr-3 text-xs text-foreground outline-none shadow-inner transition placeholder:text-muted focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/15"
              id="patient-name-search"
              onChange={(event) => setSearchPattern(event.target.value)}
              placeholder="Search"
              value={searchPattern}
            />
          </div>
        </div>
        {searchResult.error ? (
          <p className="mt-2 text-xs leading-5 text-red-600">
            Invalid regular expression: {searchResult.error}
          </p>
        ) : null}

        <div className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {searchResult.items.length > 0 ? (
            searchResult.items.map((conversation) => {
              const isActive = conversation.caseId === activeConversation?.caseId;

              return (
              <div
                className={[
                  "glass-card group relative w-full cursor-pointer rounded-2xl p-4 text-left transition hover:border-primary/35 hover:bg-white/65",
                  isActive
                    ? "glass-card-active"
                    : "",
                ].join(" ")}
                key={conversation.caseId}
                onClick={() => setActiveCaseId(conversation.caseId)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveCaseId(conversation.caseId);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {conversation.displayName}
                    </h3>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      {conversation.patientRef
                        ? `Patient reference: ${conversation.patientRef}`
                        : "No patient reference"}
                    </p>
                  </div>
                  <span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-primary ring-1 ring-sky-100">
                    {conversation.status}
                  </span>
                </div>
                <div className="mt-3 flex items-end justify-between gap-3">
                  <p className="text-xs text-muted">
                    {conversation.inputCount} texts · Updated{" "}
                    {formatDateTime(conversation.updatedAt)}
                  </p>
                  <button
                    aria-label={`Delete ${conversation.displayName}`}
                    className="flex shrink-0 items-center gap-1 rounded-full border border-transparent px-2 py-1 text-[11px] font-medium text-muted opacity-0 transition hover:border-red-200 hover:bg-red-50/70 hover:text-red-600 hover:backdrop-blur focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      setPendingDeleteCaseId(conversation.caseId);
                    }}
                    type="button"
                  >
                    <svg
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                    </svg>
                    Delete
                  </button>
                </div>
              </div>
              );
            })
          ) : (
            <div className="glass-card rounded-2xl border-dashed p-5 text-sm leading-6 text-muted">
                  {conversationList.length === 0
                ? "No case conversations yet. Enter patient information and initial clinical text on the right to create a new assessment conversation."
                : "No patient names match. Adjust the regular expression and try again."}
            </div>
          )}
        </div>
      </aside>

      <div className="min-h-[560px] rounded-[2rem] border border-white/70 bg-white/72 p-5 shadow-card backdrop-blur-xl lg:min-h-0 lg:overflow-hidden sm:p-6">
        <div className="flex h-full min-h-0 flex-col">
          {activeConversation ? (
            <PatientConversationPanel
              conversation={activeConversation}
              agentErrorMessage={agentErrorMessage}
              appendErrorMessage={appendErrorMessage}
              isAppending={isAppending}
              onAppendMessage={handleAppendMessage}
            />
          ) : (
            <NewConversationForm
              errorMessage={errorMessage}
              isSubmitting={isSubmitting}
              onSubmit={handleSubmit}
            />
          )}
        </div>
      </div>

      {pendingDeleteConversation ? (
        <DeleteCaseDialog
          conversation={pendingDeleteConversation}
          isDeleting={isDeleting}
          onCancel={() => setPendingDeleteCaseId(null)}
          onConfirm={handleConfirmDelete}
        />
      ) : null}
    </section>
  );
}

function NewConversationForm({
  errorMessage,
  isSubmitting,
  onSubmit,
}: {
  errorMessage: string | null;
  isSubmitting: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <form
        className="flex min-h-0 flex-1 flex-col gap-4"
        onSubmit={onSubmit}
      >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-semibold text-foreground">
                  Patient / Case Name
                </span>
                <input
                  className="mt-2 w-full rounded-2xl border border-white/80 bg-white/80 px-4 py-3 text-sm text-foreground shadow-inner outline-none transition focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/15"
                  name="display_name"
                  placeholder="e.g. Suspected throat cancer case 001"
                  required
                />
              </label>

              <label className="block">
                <span className="text-sm font-semibold text-foreground">
                  Patient Reference
                </span>
                <input
                  className="mt-2 w-full rounded-2xl border border-white/80 bg-white/80 px-4 py-3 text-sm text-foreground shadow-inner outline-none transition focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/15"
                  name="patient_ref"
                  placeholder="Optional: de-identified ID or visit number"
                />
              </label>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <p className="text-sm font-semibold text-foreground">
                Initial Case Materials
              </p>
              <div className="mt-2 grid gap-3 xl:grid-cols-2">
                {initialCaseInputFields.map((field) => (
                  <label
                    className="block rounded-2xl border border-white/80 bg-white/72 p-3 shadow-sm transition focus-within:border-primary/50 focus-within:bg-white"
                    key={field.input_type}
                  >
                    <span className="text-sm font-semibold text-foreground">
                      {field.label}
                    </span>
                    <textarea
                      className="mt-2 min-h-28 w-full resize-y rounded-xl border border-transparent bg-slate-50/80 px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-primary/40 focus:bg-white focus:ring-2 focus:ring-primary/10"
                      name={field.input_type}
                      placeholder={field.placeholder}
                    />
                  </label>
                ))}
              </div>
            </div>

            {errorMessage ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {errorMessage}
              </div>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs leading-5 text-muted">
                Provide only the available materials. At least one category is required to create this patient&apos;s conversation.
              </p>
              <button
                className="glass-ink-button rounded-full px-6 py-3 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Saving..." : "Confirm"}
              </button>
            </div>
      </form>
    </>
  );
}

function FollowupComposer({
  appendErrorMessage,
  isAppending,
  onAppendMessage,
}: {
  appendErrorMessage: string | null;
  isAppending: boolean;
  onAppendMessage: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="mt-1 shrink-0 pt-3">
      <form onSubmit={onAppendMessage}>
        <div className="flex items-center gap-2 rounded-full border border-white/80 bg-white/70 px-4 py-2 shadow-sm transition focus-within:border-primary/40 focus-within:bg-white/85 focus-within:ring-2 focus-within:ring-primary/15">
          <label className="sr-only" htmlFor="followup-message">
            Continue adding case information
          </label>
          <input
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted"
            id="followup-message"
            name="followup_message"
            placeholder="Add case information, or answer the Agent follow-up questions..."
          />
          <button
            aria-label="Send"
            className="glass-ink-button flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isAppending}
            type="submit"
          >
            <svg
              aria-hidden="true"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
            </svg>
          </button>
        </div>
      </form>
      {appendErrorMessage ? (
        <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {appendErrorMessage}
        </div>
      ) : null}
    </div>
  );
}

function PatientConversationPanel({
  agentErrorMessage,
  appendErrorMessage,
  conversation,
  isAppending,
  onAppendMessage,
}: {
  agentErrorMessage: string | null;
  appendErrorMessage: string | null;
  conversation: PatientConversationSummary;
  isAppending: boolean;
  onAppendMessage: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const timeline = buildConversationTimeline(conversation);

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-4 pb-4">
        <div className="min-w-0">
          <h2 className="truncate text-2xl font-bold tracking-tight text-foreground">
            {conversation.displayName}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {conversation.patientRef
              ? `Patient reference: ${conversation.patientRef}`
              : "No patient reference"}
            <span className="mx-2">·</span>
            {conversation.inputCount} case materials
          </p>
        </div>
        <button
          className="glass-control shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold text-foreground transition hover:text-primary"
          onClick={() => setIsMemoryOpen(true)}
          type="button"
        >
          Details
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <div className="floating-scrollbar -mr-2.5 h-full space-y-4 overflow-y-auto py-5 pl-0 pr-7 sm:-mr-3 sm:pr-8">
          {timeline.length > 0 ? (
            timeline.map((item) => (
              <ConversationMessageBubble key={item.key} message={item.message} />
            ))
          ) : (
            <div className="flex h-full min-h-[240px] items-center justify-center rounded-3xl border border-dashed border-white/70 bg-white/32 px-6 text-center text-sm leading-6 text-muted">
                Case materials have been organized under &quot;Details&quot; in the upper right. Once the Agent starts analysis, follow-up questions, answers, and assessment notes will appear here.
            </div>
          )}
          {isAppending ? <AgentLoadingBubble /> : null}
          {!isAppending && agentErrorMessage ? (
            <AgentFailureBubble message={agentErrorMessage} />
          ) : null}
        </div>
      </div>

      <FollowupComposer
        appendErrorMessage={appendErrorMessage}
        isAppending={isAppending}
        onAppendMessage={onAppendMessage}
      />

      {isMemoryOpen ? (
        <PatientMemoryDialog
          conversation={conversation}
          onClose={() => setIsMemoryOpen(false)}
        />
      ) : null}
    </>
  );
}

type TimelineItem = {
  key: string;
  at: number;
  message: ConversationMessageSummary;
};

interface AgentCurrentAssessment {
  updatedAt?: string;
  currentJudgment?: string;
  missingQuestions: AgentQuestionSummary[];
  answeredItems: Array<{
    question: AgentQuestionSummary;
    answer: AgentAnswerSummary;
  }>;
}

function buildConversationTimeline(
  conversation: PatientConversationSummary,
): TimelineItem[] {
  return conversation.messages
    .map((message) => ({
      key: `message-${message.messageId}`,
      at: new Date(message.createdAt).getTime(),
      message,
    }))
    .sort((left, right) => left.at - right.at);
}

function buildAgentCurrentAssessment(
  rounds: AgentRoundSummary[],
): AgentCurrentAssessment | null {
  const sortedRounds = [...rounds].sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
  const latestRound = sortedRounds.at(-1);

  if (!latestRound) {
    return null;
  }

  const answeredItems: AgentCurrentAssessment["answeredItems"] = [];
  const missingQuestions: AgentQuestionSummary[] = [];

  for (const round of sortedRounds) {
    const answerByQuestion = new Map(
      round.answers.map((answer) => [answer.questionId, answer] as const),
    );

    for (const question of round.questions) {
      const answer = answerByQuestion.get(question.id);

      if (answer && !answer.markedUnknown) {
        answeredItems.push({ question, answer });
      } else {
        missingQuestions.push(question);
      }
    }
  }

  return {
    answeredItems,
    currentJudgment: latestRound.reason,
    missingQuestions,
    updatedAt: latestRound.createdAt,
  };
}

function ConversationMessageBubble({
  message,
}: {
  message: ConversationMessageSummary;
}) {
  if (message.role === "clinician") {
    return (
      <div className="flex justify-end">
        <div className="max-w-3xl rounded-2xl border border-white/45 bg-gradient-to-br from-primary/90 to-blue-500/80 px-4 py-3 text-sm leading-6 text-white shadow-card backdrop-blur-xl">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-blue-100">
            <span>Clinician</span>
            <span>{formatDateTime(message.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-3xl rounded-2xl border border-white/75 bg-white/70 px-4 py-3 text-sm leading-6 text-foreground shadow-sm">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-primary">
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold ring-1 ring-primary/10">
            AI
          </span>
          <span className="font-semibold">Agent Response</span>
          <span className="text-muted">{formatDateTime(message.createdAt)}</span>
        </div>
        <p className="whitespace-pre-wrap text-muted">{message.content}</p>
      </div>
    </div>
  );
}

function AgentLoadingBubble() {
  return (
    <div className="flex justify-start">
      <div className="max-w-3xl rounded-2xl border border-white/75 bg-white/60 px-4 py-3 text-sm leading-6 text-muted shadow-sm">
        Agent is reviewing the updated patient memory and recent conversation...
      </div>
    </div>
  );
}

function AgentFailureBubble({ message }: { message: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-3xl rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700 shadow-sm">
        {message}
      </div>
    </div>
  );
}

function PatientMemoryDialog({
  conversation,
  onClose,
}: {
  conversation: PatientConversationSummary;
  onClose: () => void;
}) {
  const [modelMemory, setModelMemory] = useState<PatientMemory | null>(null);
  const [memoryMode, setMemoryMode] = useState<PatientMemoryResponse["mode"]>(
    "deterministic",
  );
  const [memoryStatus, setMemoryStatus] = useState<PatientMemoryStatus | null>(
    null,
  );
  const [isLoadingMemory, setIsLoadingMemory] = useState(true);
  const [isRefreshingMemory, setIsRefreshingMemory] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const activeMemory = modelMemory ?? conversation.memory;
  const memoryCategories = activeMemory.categories;
  const agentAssessment = buildAgentCurrentAssessment(conversation.agentRounds);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const loadPatientMemory = useCallback(
    async ({
      forceRefresh,
      shouldApply = () => true,
    }: {
      forceRefresh: boolean;
      shouldApply?: () => boolean;
    }) => {
      if (forceRefresh) {
        setIsRefreshingMemory(true);
      } else {
        setIsLoadingMemory(true);
      }

      try {
        const response = await fetch(
          `/api/cases/${encodeURIComponent(conversation.caseId)}/memory${
            forceRefresh ? "?forceRefresh=true" : ""
          }`,
        );

        if (!response.ok) {
          throw new Error("Memory request failed.");
        }

        const payload = (await response.json()) as PatientMemoryResponse;

        if (shouldApply()) {
          setModelMemory(payload.memory);
          setMemoryMode(payload.mode);
          setMemoryStatus(payload.status);
        }
      } catch {
        if (shouldApply()) {
          if (!forceRefresh) {
            setModelMemory(null);
          }
          setMemoryMode("fallback");
          setMemoryStatus(null);
        }
      } finally {
        if (shouldApply()) {
          if (forceRefresh) {
            setIsRefreshingMemory(false);
          } else {
            setIsLoadingMemory(false);
          }
        }
      }
    },
    [conversation.caseId],
  );

  useEffect(() => {
    let isActive = true;

    void loadPatientMemory({
      forceRefresh: false,
      shouldApply: () => isActive,
    });

    return () => {
      isActive = false;
    };
  }, [loadPatientMemory]);

  function handleRefreshMemory() {
    void loadPatientMemory({ forceRefresh: true });
  }

  const dialog = (
    <div
      aria-labelledby="patient-memory-title"
      aria-modal="true"
      className="top-sheet-backdrop fixed inset-0 z-[999] flex items-start justify-center overflow-y-auto px-4 pt-20"
      onClick={onClose}
      role="dialog"
    >
      <div
        className="top-sheet-surface mb-10 flex max-h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-[2rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-primary/80">
              Patient Memory
            </p>
            <h2
              className="mt-1 text-xl font-bold text-foreground"
              id="patient-memory-title"
            >
              {conversation.displayName}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {conversation.patientRef
                ? `Patient reference: ${conversation.patientRef}`
                : "No patient reference"}
              <span className="mx-2">·</span>
              Updated {formatDateTime(conversation.updatedAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              aria-label="Refresh patient memory"
              className="glass-control rounded-full px-3 py-1.5 text-xs font-semibold text-foreground transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isLoadingMemory || isRefreshingMemory}
              onClick={handleRefreshMemory}
              type="button"
            >
              {isRefreshingMemory ? "Refreshing..." : "Refresh"}
            </button>
            <button
              aria-label="Close patient memory details"
              className="glass-control rounded-full px-3 py-1.5 text-xs font-semibold text-foreground transition hover:text-primary"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
          </div>
        </div>

        <div className="top-sheet-body floating-scrollbar mr-3 min-h-0 flex-1 space-y-5 overflow-y-auto py-5 pl-6 pr-9">
          <section className="top-sheet-section rounded-3xl p-5">
            <h3 className="text-sm font-bold text-foreground">Basic Information</h3>
            <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <MemoryStat label="Patient / Case" value={conversation.displayName} />
              <MemoryStat
                label="Patient Reference"
                value={conversation.patientRef ?? "Not provided"}
              />
              <MemoryStat label="Case Status" value={conversation.status} />
              <MemoryStat
                label="Last Updated"
                value={formatDateTime(conversation.updatedAt)}
              />
            </div>
          </section>

          <section className="top-sheet-section rounded-3xl p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-foreground">Clinical Memory</h3>
              <span className="text-xs text-muted">
                {memoryStatusLabel(
                  memoryMode,
                  isLoadingMemory,
                  isRefreshingMemory,
                  memoryStatus,
                )} · Based on{" "}
                {activeMemory.inputCount} materials
              </span>
            </div>
            {memoryCategories.length > 0 ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {memoryCategories.map((category) => (
                  <MemoryInputCategory
                    category={category}
                    key={category.label}
                  />
                ))}
              </div>
            ) : (
              <p className="top-sheet-tile rounded-2xl px-4 py-3 text-sm text-muted">
                No readable case materials yet.
              </p>
            )}
          </section>

          <section className="top-sheet-section rounded-3xl p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-foreground">
                Current Agent Assessment
              </h3>
              {agentAssessment?.updatedAt ? (
                <span className="text-xs text-muted">
                  Updated {formatDateTime(agentAssessment.updatedAt)}
                </span>
              ) : null}
            </div>
            {agentAssessment ? (
              <AgentCurrentAssessmentCard assessment={agentAssessment} />
            ) : (
              <p className="top-sheet-tile rounded-2xl px-4 py-3 text-sm text-muted">
                The Agent has not formed a current assessment yet. Once sufficient material is available, this section will show the current judgment, missing information, and reasons for uncertainty.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );

  return isMounted ? createPortal(dialog, document.body) : null;
}

function MemoryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="top-sheet-tile rounded-2xl px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 font-semibold text-foreground">{value}</p>
    </div>
  );
}

function memoryStatusLabel(
  mode: PatientMemoryResponse["mode"],
  isLoading: boolean,
  isRefreshing: boolean,
  status: PatientMemoryStatus | null,
): string {
  if (isLoading) {
    return "Loading memory";
  }

  if (isRefreshing) {
    return "Refreshing memory";
  }

  if ((status?.pendingRoughItemCount ?? 0) > 0) {
    return "Pending rough memory";
  }

  if (status?.isStale) {
    return "Memory stale";
  }

  if (mode === "model") {
    return status?.refreshed ? "Model refreshed" : "Model organized";
  }

  if (mode === "fallback") {
    return "Deterministic fallback";
  }

  return status?.refreshed
    ? "Deterministic refresh"
    : "Deterministic organization";
}

function MemoryInputCategory({
  category,
}: {
  category: PatientMemoryCategory;
}) {
  return (
    <section className="top-sheet-tile rounded-2xl p-4">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary ring-1 ring-primary/10">
          M
        </span>
        <h3 className="text-sm font-bold text-foreground">{category.label}</h3>
        <span className="text-xs text-muted">Organized</span>
      </div>
      <p className="text-sm leading-6 text-muted">{category.summary}</p>
      <ul className="mt-3 space-y-2">
        {category.items.map((item) => (
          <li
            className="rounded-2xl bg-white/38 px-3 py-2 text-sm leading-6 text-foreground"
            key={item}
          >
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentCurrentAssessmentCard({
  assessment,
}: {
  assessment: AgentCurrentAssessment;
}) {
  return (
    <article className="top-sheet-tile rounded-2xl p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-primary">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold">
          AI
        </span>
        <span className="font-semibold">Current</span>
      </div>
      <p className="rounded-2xl bg-white/38 px-4 py-3 text-sm leading-6 text-foreground">
        {assessment.currentJudgment ??
          "Current materials are not yet sufficient to form a clear diagnostic recommendation."}
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section>
          <h4 className="text-xs font-bold text-foreground">
            Missing Information / Uncertain
          </h4>
          {assessment.missingQuestions.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {assessment.missingQuestions.map((question) => (
                <li
                  className="rounded-2xl bg-white/38 px-3 py-2 text-sm leading-6 text-muted"
                  key={question.id}
                >
                  <span className="font-medium text-foreground">
                    {question.question}
                  </span>
                  <span className="block text-xs leading-5 text-muted">
                    Purpose: {question.clinicalPurpose}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-2xl bg-white/38 px-3 py-2 text-sm text-muted">
              No blocking missing information.
            </p>
          )}
        </section>

        <section>
          <h4 className="text-xs font-bold text-foreground">Submitted Evidence</h4>
          {assessment.answeredItems.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {assessment.answeredItems.map(({ answer, question }) => (
                <li
                  className="rounded-2xl bg-white/38 px-3 py-2 text-sm leading-6 text-muted"
                  key={answer.responseId}
                >
                  <span className="font-medium text-foreground">
                    {question.question}
                  </span>
                  <span className="block text-muted">
                    {answer.answerText}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-2xl bg-white/38 px-3 py-2 text-sm text-muted">
              No submitted evidence yet.
            </p>
          )}
        </section>
      </div>
    </article>
  );
}

function DeleteCaseDialog({
  conversation,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  conversation: PatientConversationSummary;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      aria-labelledby="delete-case-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/38 p-4 backdrop-blur-sm"
      onClick={onCancel}
      role="dialog"
    >
      <div
        className="w-full max-w-sm rounded-3xl border border-border bg-white p-6 shadow-card"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          className="text-lg font-bold text-foreground"
          id="delete-case-title"
        >
          Delete Case
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          Confirm deletion of case
          <span className="font-semibold text-foreground">
            &quot;{conversation.displayName}&quot;
          </span>
            ? This case&apos;s {conversation.inputCount} materials and all assessment records will be permanently deleted and cannot be recovered.
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            className="glass-control rounded-full px-4 py-2 text-sm font-semibold text-foreground transition hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isDeleting}
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-full bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isDeleting}
            onClick={onConfirm}
            type="button"
          >
            {isDeleting ? "Deleting..." : "Confirm Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function getFormValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function filterConversationsByName(
  conversations: PatientConversationSummary[],
  pattern: string,
): { error: string | null; items: PatientConversationSummary[] } {
  const trimmedPattern = pattern.trim();

  if (!trimmedPattern) {
    return { error: null, items: conversations };
  }

  try {
    const matcher = new RegExp(trimmedPattern, "i");
    return {
      error: null,
      items: conversations.filter((conversation) =>
        matcher.test(conversation.displayName),
      ),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unable to parse",
      items: conversations,
    };
  }
}

async function postJson<TResponse>(
  url: string,
  body: Record<string, unknown>,
): Promise<TResponse> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as
    | { message?: string }
    | null;

  if (!response.ok) {
    throw new Error(payload?.message ?? "Request failed.");
  }

  return payload as TResponse;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
