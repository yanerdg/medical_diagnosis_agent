import type { EvidenceModel, JsonValue } from "@/domain/evidence";
import type {
  CaseInput,
  CaseInputType,
  AssessmentRun,
  ClarificationQuestion,
  ClarificationRequestRecord,
  ClarificationResponse,
  SpecialtyStructure,
} from "@/domain/schemas";
import type {
  ResumeAssessmentRunRequest,
  SubmitClarificationResponsesRequest,
} from "@/server/api/assessments";
import {
  extractSpecialtyStructure,
  type StructureExtractionResult,
} from "@/server/cases/structured-extraction";
import {
  resumeAssessmentGraph,
  type RunAssessmentGraphResult,
} from "@/server/agent";
import { createPendingRoughMemoryForCaseInput } from "@/server/memory/rough-memory";
import type { MedicalRepository } from "@/server/repositories";
import { randomUUID } from "node:crypto";

export class ClarificationWorkflowError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface ClarificationRequestWithResponses
  extends ClarificationRequestRecord {
  responses: ClarificationResponse[];
}

export interface RunClarificationRequestsResult {
  run: NonNullable<ReturnType<MedicalRepository["getAssessmentRun"]>>;
  requests: ClarificationRequestWithResponses[];
}

export interface SubmitClarificationResponsesResult {
  request: ClarificationRequestRecord;
  responses: ClarificationResponse[];
  supplemental_input?: CaseInput;
  evidence: EvidenceModel[];
}

export interface ResumeAssessmentRunResult extends RunAssessmentGraphResult {
  structure: SpecialtyStructure;
  evidence: EvidenceModel[];
  acknowledged_missing_evidence_codes: string[];
}

export function listRunClarificationRequests(
  repository: MedicalRepository,
  runId: string,
): RunClarificationRequestsResult {
  const run = repository.getAssessmentRun(runId);

  if (!run) {
    throw new ClarificationWorkflowError(404, "Assessment run not found.");
  }

  return {
    run,
    requests: repository.listClarificationRequests(runId).map((request) => ({
      ...request,
      responses: repository.listClarificationResponses(request.request_id),
    })),
  };
}

export function submitClarificationResponses(params: {
  repository: MedicalRepository;
  requestId: string;
  body: SubmitClarificationResponsesRequest;
  now?: () => string;
}): SubmitClarificationResponsesResult {
  const { repository, requestId, body } = params;
  const submittedAt = (params.now ?? (() => new Date().toISOString()))();
  const request = repository.getClarificationRequest(requestId);

  if (!request) {
    throw new ClarificationWorkflowError(404, "Clarification request not found.");
  }

  const questionById = new Map(
    request.questions.map((question) => [question.id, question]),
  );
  for (const response of body.responses) {
    if (!questionById.has(response.question_id)) {
      throw new ClarificationWorkflowError(
        400,
        `Question does not belong to this clarification request: ${response.question_id}`,
      );
    }
  }

  const supplementalText = buildSupplementalText(request, body, questionById);
  const supplementalInput =
    supplementalText.length > 0
      ? repository.createCaseInputFromRawText({
          case_id: request.case_id,
          input_type:
            body.supplemental_input_type ??
            inferSupplementalInputType(request.questions),
          raw_text: supplementalText,
          submitted_at: submittedAt,
        })
      : undefined;
  if (supplementalInput) {
    createPendingRoughMemoryForCaseInput({
      input: supplementalInput,
      rawText: supplementalText,
      repository,
    });
  }

  const responses = body.responses.map((response) =>
    repository.saveClarificationResponse({
      response_id: randomUUID(),
      request_id: request.request_id,
      question_id: response.question_id,
      answer_text: response.answer_text,
      marked_unknown: response.marked_unknown,
      supplemental_input_id: supplementalInput?.input_id,
      submitted_at: submittedAt,
    }),
  );
  const evidence = responses.map((response) =>
    responseToEvidence({
      request,
      response,
      question: questionById.get(response.question_id),
      createdAt: submittedAt,
    }),
  );

  repository.recordAuditEvent({
    entity_type: "clarification_request",
    entity_id: request.request_id,
    action: "clarification_response_submitted",
    actor_id: body.clinician_id,
    payload: {
      request_id: request.request_id,
      run_id: request.run_id,
      response_ids: responses.map((response) => response.response_id),
      supplemental_input_id: supplementalInput?.input_id ?? null,
      evidence,
    },
    created_at: submittedAt,
  });
  repository.appendRunEvent({
    run_id: request.run_id,
    event_type: "clarification.response.submitted",
    payload: {
      request_id: request.request_id,
      response_count: responses.length,
      marked_unknown_count: responses.filter((response) => response.marked_unknown)
        .length,
      supplemental_input_id: supplementalInput?.input_id ?? null,
    },
    created_at: submittedAt,
  });

  return {
    request,
    responses,
    supplemental_input: supplementalInput,
    evidence,
  };
}

export async function resumeAssessmentRun(params: {
  repository: MedicalRepository;
  runId: string;
  body: ResumeAssessmentRunRequest;
  now?: () => string;
}): Promise<ResumeAssessmentRunResult> {
  const { repository, runId, body } = params;
  const now = params.now ?? (() => new Date().toISOString());
  const resumedAt = now();
  const run = repository.getAssessmentRun(runId);

  if (!run) {
    throw new ClarificationWorkflowError(404, "Assessment run not found.");
  }

  if (run.status !== "paused_for_clinician_input") {
    throw new ClarificationWorkflowError(
      409,
      "Only paused assessment runs can be resumed.",
    );
  }

  const requests = repository.listClarificationRequests(runId);
  const acknowledgedMissingEvidenceCodes =
    collectAcknowledgedMissingEvidenceCodes(repository, requests);

  if (acknowledgedMissingEvidenceCodes.length === 0) {
    throw new ClarificationWorkflowError(
      400,
      "Submit at least one clarification response before resuming.",
    );
  }

  const extraction = loadStructureForResume(
    repository,
    run,
    requests,
    resumedAt,
  );

  repository.appendRunEvent({
    run_id: runId,
    event_type: "assessment.run.resume_requested",
    payload: {
      case_id: run.case_id,
      previous_structure_id: run.structure_id ?? null,
      next_structure_id: extraction.structure.structure_id,
      acknowledged_missing_evidence_codes: acknowledgedMissingEvidenceCodes,
      clinician_id: body.clinician_id ?? null,
    },
    created_at: resumedAt,
  });

  const result = await resumeAssessmentGraph({
    case_id: run.case_id,
    run_id: run.run_id,
    structure_id: extraction.structure.structure_id,
    acknowledged_missing_evidence_codes: acknowledgedMissingEvidenceCodes,
    repository,
    now,
  });

  repository.appendRunEvent({
    run_id: runId,
    event_type: "assessment.run.resume_completed",
    payload: {
      status: result.run.status,
      structure_id: extraction.structure.structure_id,
      report_id: result.report?.report_id ?? null,
    },
    created_at: now(),
  });

  return {
    ...result,
    structure: extraction.structure,
    evidence: extraction.evidence,
    acknowledged_missing_evidence_codes: acknowledgedMissingEvidenceCodes,
  };
}

function loadStructureForResume(
  repository: MedicalRepository,
  run: AssessmentRun,
  requests: ClarificationRequestRecord[],
  createdAt: string,
): StructureExtractionResult {
  if (!hasSupplementalInput(repository, requests)) {
    const structure = run.structure_id
      ? repository.getSpecialtyStructure(run.structure_id)
      : repository.getLatestSpecialtyStructure(run.case_id);

    if (!structure) {
      throw new ClarificationWorkflowError(
        400,
        "Assessment run has no structure to resume.",
      );
    }

    return {
      structure,
      evidence: [],
    };
  }

  return rebuildStructureForResume(repository, run.case_id, createdAt);
}

function rebuildStructureForResume(
  repository: MedicalRepository,
  caseId: string,
  createdAt: string,
): StructureExtractionResult {
  const inputs = repository
    .listCaseInputs(caseId)
    .map((input) => ({
      input,
      raw_text: repository.readCaseInputRawText(input.input_id) ?? "",
    }))
    .filter((input) => input.raw_text.trim().length > 0);

  if (inputs.length === 0) {
    throw new ClarificationWorkflowError(
      400,
      "Case has no raw inputs to resume assessment.",
    );
  }

  const latestStructure = repository.getLatestSpecialtyStructure(caseId);
  const result = extractSpecialtyStructure({
    case_id: caseId,
    inputs,
    version: (latestStructure?.version ?? 0) + 1,
    created_at: createdAt,
  });

  repository.saveSpecialtyStructure(result.structure);
  repository.recordAuditEvent({
    entity_type: "specialty_structure",
    entity_id: result.structure.structure_id,
    action: "resume_restructure",
    payload: {
      case_id: caseId,
      version: result.structure.version,
      base_structure_id: latestStructure?.structure_id ?? null,
      evidence: result.evidence,
    },
    created_at: createdAt,
  });

  return result;
}

function hasSupplementalInput(
  repository: MedicalRepository,
  requests: ClarificationRequestRecord[],
): boolean {
  return requests.some((request) =>
    repository
      .listClarificationResponses(request.request_id)
      .some((response) => response.supplemental_input_id !== undefined),
  );
}

function collectAcknowledgedMissingEvidenceCodes(
  repository: MedicalRepository,
  requests: ClarificationRequestRecord[],
): string[] {
  const codes = new Set<string>();

  for (const request of requests) {
    const questionById = new Map(
      request.questions.map((question) => [question.id, question]),
    );
    for (const response of repository.listClarificationResponses(
      request.request_id,
    )) {
      const question = questionById.get(response.question_id);
      if (question?.blocks_conclusion) {
        codes.add(missingEvidenceCodeFromQuestionId(question.id));
      }
    }
  }

  return [...codes].sort();
}

function buildSupplementalText(
  request: ClarificationRequestRecord,
  body: SubmitClarificationResponsesRequest,
  questionById: Map<string, ClarificationQuestion>,
): string {
  const answerLines = body.responses
    .filter((response) => !response.marked_unknown && response.answer_text)
    .map((response) => {
      const question = questionById.get(response.question_id);
      return [
        question ? `问题：${question.question}` : `问题ID：${response.question_id}`,
        `回答：${response.answer_text}`,
      ].join("\n");
    });
  const sections = [
    ...answerLines,
    body.supplemental_report_text
      ? `补充报告文本：\n${body.supplemental_report_text}`
      : "",
  ].filter((section) => section.trim().length > 0);

  return sections.length > 0
    ? [`追问请求：${request.reason}`, ...sections].join("\n\n")
    : "";
}

function inferSupplementalInputType(
  questions: ClarificationQuestion[],
): CaseInputType {
  return questions.some(
    (question) => question.expected_answer_type === "report_upload",
  )
    ? "pathology_biomarker"
    : "other";
}

function responseToEvidence(params: {
  request: ClarificationRequestRecord;
  response: ClarificationResponse;
  question?: ClarificationQuestion;
  createdAt: string;
}): EvidenceModel {
  const { request, response, question, createdAt } = params;
  const value: JsonValue = response.marked_unknown
    ? "unknown"
    : (response.answer_text ?? "");
  const quote = response.marked_unknown
    ? `医生标记未知：${question?.question ?? response.question_id}`
    : (response.answer_text ?? "");

  return {
    evidence_id: randomUUID(),
    case_id: request.case_id,
    source_type: "clarification_response",
    source_ref: response.response_id,
    field: `clarification.${missingEvidenceCodeFromQuestionId(response.question_id)}`,
    value,
    quote,
    confidence: response.marked_unknown ? 0.7 : 1,
    extracted_by: "clinician",
    created_at: createdAt,
  };
}

function missingEvidenceCodeFromQuestionId(questionId: string): string {
  return questionId.split(":")[0] ?? questionId;
}
