import { appInfo, mvpCapabilities } from "@/lib/app-info";
import { buildPatientMemory } from "@/lib/clinical-memory";
import { getMedicalRepository } from "@/server/repositories";
import { HomeWorkspace, type PatientConversationSummary } from "./home-workspace";
import { VersionCapabilitiesDialog } from "./version-capabilities-dialog";

const capabilityDescriptions = [
  "Capture history, chief concerns, CT reports, biomarker reports, baseline labs, and prior treatment text.",
  "Structured outputs enter a clinician-editable preview; corrections are retained as clinician evidence.",
  "The assessment flow is composed of deterministic gates, allowlisted tools, and a state graph with up to 6 rounds.",
  "When critical evidence is missing, the run enters paused_for_clinician_input and resumes from the same run after clinician input.",
  "The final report must show evidence, missing information, references, disclaimers, and a clinician review entry point.",
] as const;

const capabilityItems = mvpCapabilities.map((capability, index) => ({
  description: capabilityDescriptions[index],
  title: capability,
}));

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function Home() {
  const repository = getMedicalRepository();
  const conversations: PatientConversationSummary[] = repository
    .listCases()
    .map((caseRecord) => {
      const inputs = repository.listCaseInputs(caseRecord.case_id).map((input) => {
        const rawText = repository.readCaseInputRawText(input.input_id) ?? "";

        return {
          inputId: input.input_id,
          inputType: input.input_type,
          rawText,
          submittedAt: input.submitted_at,
        };
      });

      const agentRounds = repository
        .listAssessmentRuns(caseRecord.case_id)
        .flatMap((run) => repository.listClarificationRequests(run.run_id))
        .map((request) => ({
          requestId: request.request_id,
          reason: request.reason,
          createdAt: request.created_at,
          questions: request.questions.map((question) => ({
            id: question.id,
            question: question.question,
            clinicalPurpose: question.clinical_purpose,
          })),
          answers: repository
            .listClarificationResponses(request.request_id)
            .map((response) => ({
              responseId: response.response_id,
              questionId: response.question_id,
              answerText: response.answer_text,
              markedUnknown: response.marked_unknown,
              submittedAt: response.submitted_at,
            })),
        }));
      const memory = buildPatientMemory({
        agentRounds,
        caseRecord,
        inputs,
      });
      const latestMemorySnapshot = repository.getLatestPatientMemorySnapshot(
        caseRecord.case_id,
      );
      const messages = repository
        .listCaseConversationMessages(caseRecord.case_id)
        .map((message) => ({
          caseInputId: message.case_input_id,
          content: message.content,
          createdAt: message.created_at,
          messageId: message.message_id,
          role: message.role,
        }));

      return {
        caseId: caseRecord.case_id,
        displayName: caseRecord.display_name,
        patientRef: caseRecord.patient_ref,
        status: caseRecord.status,
        inputCount: inputs.length,
        inputs,
        agentRounds,
        memory:
          latestMemorySnapshot && !latestMemorySnapshot.is_stale
            ? latestMemorySnapshot.memory
            : memory,
        messages,
        updatedAt: caseRecord.updated_at,
      };
    });
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1680px] flex-col px-5 py-5 sm:px-8 lg:h-screen lg:overflow-hidden lg:px-10 xl:px-12">
      <section className="mb-5 flex min-h-[72px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-[1.75rem] border border-white/70 bg-white/55 px-4 py-3 shadow-card backdrop-blur-xl">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl shadow-glow ring-1 ring-white/60">
          <svg
            aria-hidden="true"
            className="h-11 w-11"
            fill="none"
            viewBox="0 0 44 44"
          >
            <defs>
              <mask id="yenho-logo-cutout">
                <rect fill="white" height="44" rx="14" width="44" />
                <path
                  d="M2 0 17.4 17.1c1.2 1.35 1.9 3.1 1.95 4.9L19.95 44M42 0 26.6 17.1c-1.2 1.35-1.9 3.1-1.95 4.9L24.05 44M12.2 24.6h19.6"
                  fill="none"
                  stroke="black"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="5.4"
                />
              </mask>
              <linearGradient
                gradientUnits="userSpaceOnUse"
                id="yenho-logo-ink"
                x1="6"
                x2="38"
                y1="4"
                y2="42"
              >
                <stop stopColor="#020617" />
                <stop offset="0.58" stopColor="#111827" />
                <stop offset="1" stopColor="#1E293B" />
              </linearGradient>
            </defs>
            <rect
              fill="url(#yenho-logo-ink)"
              height="44"
              mask="url(#yenho-logo-cutout)"
              rx="14"
              width="44"
            />
          </svg>
          <span className="sr-only">YenHo Logo</span>
        </span>
        <div className="flex min-w-fit items-baseline gap-4 overflow-visible">
          <h1
            className="whitespace-nowrap bg-gradient-to-r from-slate-950 via-slate-800 to-primary bg-clip-text py-1 text-4xl font-semibold leading-[0.95] tracking-[-0.045em] text-transparent drop-shadow-sm sm:text-5xl"
            style={{
              fontFamily:
                '"Baskerville", "Libre Baskerville", "Iowan Old Style", "Palatino Linotype", "Songti SC", serif',
            }}
          >
            YenHo
          </h1>
          <p className="-translate-y-1 whitespace-nowrap text-[11px] font-semibold uppercase leading-none tracking-[0.32em] text-slate-500">
            your throat cancer diagnosis agent
          </p>
        </div>

        <div className="ml-auto self-center">
          <VersionCapabilitiesDialog
            items={capabilityItems}
            shortName={appInfo.shortName}
            version="v0.1"
          />
        </div>
      </section>

      <HomeWorkspace conversations={conversations} />
    </main>
  );
}
