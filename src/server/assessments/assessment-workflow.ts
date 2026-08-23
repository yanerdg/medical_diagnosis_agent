import type {
  AssessmentReportRecord,
  AssessmentRun,
  Review,
} from "@/domain/schemas";
import type {
  CreateAssessmentRunRequest,
  SubmitReportReviewRequest,
} from "@/server/api/assessments";
import { runAssessmentGraph, type RunAssessmentGraphResult } from "@/server/agent";
import { loadKnowledgeBase } from "@/server/kb/loader";
import { loadLocalKnowledgeCitationsByIds } from "@/server/kb/local-search";
import type { KnowledgeCitation } from "@/server/kb/search";
import type { MedicalRepository, RunEvent } from "@/server/repositories";
import { randomUUID } from "node:crypto";

export class AssessmentWorkflowError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface AssessmentReportView {
  report: AssessmentReportRecord;
  citations: KnowledgeCitation[];
  reviews: Review[];
}

export async function startAssessmentRun(params: {
  repository: MedicalRepository;
  caseId: string;
  body: CreateAssessmentRunRequest;
  now?: () => string;
}): Promise<RunAssessmentGraphResult> {
  const { repository, caseId, body } = params;
  const caseRecord = repository.getCase(caseId);

  if (!caseRecord) {
    throw new AssessmentWorkflowError(404, "Case not found.");
  }

  const structure = body.structure_id
    ? repository.getSpecialtyStructure(body.structure_id)
    : repository.getLatestSpecialtyStructure(caseId);

  if (!structure) {
    throw new AssessmentWorkflowError(
      400,
      "Run structure extraction before starting assessment.",
    );
  }

  if (structure.case_id !== caseId) {
    throw new AssessmentWorkflowError(
      409,
      "Structure does not belong to this case.",
    );
  }

  return runAssessmentGraph({
    case_id: caseId,
    structure_id: structure.structure_id,
    repository,
    now: params.now,
  });
}

export function getAssessmentRunResult(
  repository: MedicalRepository,
  runId: string,
): { run: AssessmentRun; report?: AssessmentReportRecord } {
  const run = repository.getAssessmentRun(runId);

  if (!run) {
    throw new AssessmentWorkflowError(404, "Assessment run not found.");
  }

  return {
    run,
    report: repository.getAssessmentReportForRun(runId) ?? undefined,
  };
}

export function listAssessmentRunEvents(
  repository: MedicalRepository,
  runId: string,
): { run: AssessmentRun; events: RunEvent[] } {
  const run = repository.getAssessmentRun(runId);

  if (!run) {
    throw new AssessmentWorkflowError(404, "Assessment run not found.");
  }

  return {
    run,
    events: repository.listRunEvents(runId),
  };
}

export async function getAssessmentRunReport(
  repository: MedicalRepository,
  runId: string,
): Promise<AssessmentReportView> {
  const run = repository.getAssessmentRun(runId);

  if (!run) {
    throw new AssessmentWorkflowError(404, "Assessment run not found.");
  }

  const report = repository.getAssessmentReportForRun(runId);

  if (!report) {
    throw new AssessmentWorkflowError(404, "Assessment report not found.");
  }

  return buildAssessmentReportView(repository, report);
}

export async function submitAssessmentReportReview(params: {
  repository: MedicalRepository;
  reportId: string;
  body: SubmitReportReviewRequest;
  now?: () => string;
}): Promise<{ report: AssessmentReportRecord; review: Review; reviews: Review[] }> {
  const { repository, reportId, body } = params;
  const report = repository.getAssessmentReport(reportId);

  if (!report) {
    throw new AssessmentWorkflowError(404, "Assessment report not found.");
  }

  const reviewedAt = (params.now ?? (() => new Date().toISOString()))();
  const review = repository.saveReview({
    review_id: randomUUID(),
    report_id: reportId,
    reviewer_id: body.reviewer_id,
    decision: body.decision,
    comment: body.comment,
    reviewed_at: reviewedAt,
  });

  repository.recordAuditEvent({
    entity_type: "assessment_report",
    entity_id: reportId,
    action: "clinician_review_submitted",
    actor_id: body.reviewer_id,
    payload: {
      report_id: reportId,
      run_id: report.run_id,
      review_id: review.review_id,
      decision: review.decision,
      comment: review.comment ?? null,
    },
    created_at: reviewedAt,
  });
  repository.appendRunEvent({
    run_id: report.run_id,
    event_type: "assessment.report.reviewed",
    payload: {
      report_id: reportId,
      review_id: review.review_id,
      decision: review.decision,
      reviewer_id: review.reviewer_id,
    },
    created_at: reviewedAt,
  });

  return {
    report,
    review,
    reviews: repository.listReviews(reportId),
  };
}

export async function buildAssessmentReportView(
  repository: MedicalRepository,
  report: AssessmentReportRecord,
): Promise<AssessmentReportView> {
  return {
    report,
    citations: await loadReportCitations(report),
    reviews: repository.listReviews(report.report_id),
  };
}

async function loadReportCitations(
  report: AssessmentReportRecord,
): Promise<KnowledgeCitation[]> {
  const citationIds = new Set(
    report.report_json.sensitivity_assessment.flatMap((item) => item.citations),
  );

  if (citationIds.size === 0) {
    return [];
  }

  // Imported RAG citations are persisted in SQLite.  Resolve them first so a
  // report remains inspectable even when the legacy file-backed KB is absent.
  let localCitations: KnowledgeCitation[] = [];
  try {
    localCitations = loadLocalKnowledgeCitationsByIds(citationIds);
  } catch {
    localCitations = [];
  }
  const unresolvedIds = new Set(citationIds);
  for (const citation of localCitations) unresolvedIds.delete(citation.citation_id);

  if (unresolvedIds.size === 0) {
    return orderCitations(citationIds, localCitations);
  }

  const knowledgeBase = await loadKnowledgeBase({
    version: report.report_json.knowledge_version,
  });
  const fileCitations = knowledgeBase.chunks
    .filter((chunk) => unresolvedIds.has(chunk.id))
    .map((chunk) => ({
      id: chunk.id,
      chunk_id: chunk.chunk_id,
      cancer_site_scope: chunk.cancer_site_scope,
      evidence_level: chunk.evidence_level,
      text_chunk: chunk.text_chunk,
      structured_tags: chunk.structured_tags,
      version: chunk.version,
      source_id: chunk.source_id,
      source_title: chunk.source_title,
      source_type: chunk.source_type,
      publish_date: chunk.publish_date,
      review_status: chunk.review_status,
      citation_id: chunk.id,
      score: 0,
      matched_keywords: [],
    }));
  return orderCitations(citationIds, [...localCitations, ...fileCitations]);
}

function orderCitations(
  citationIds: Set<string>,
  citations: KnowledgeCitation[],
): KnowledgeCitation[] {
  const byId = new Map(citations.map((citation) => [citation.citation_id, citation]));
  return [...citationIds]
    .map((citationId) => byId.get(citationId))
    .filter((citation): citation is KnowledgeCitation => citation !== undefined);
}
