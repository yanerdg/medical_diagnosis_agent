import {
  clarificationRequestRouteParamsSchema,
  submitClarificationResponsesRequestSchema,
} from "@/server/api/assessments";
import {
  badRequest,
  InvalidJsonError,
  isValidationError,
  readJsonBody,
  serverError,
  validationError,
} from "@/server/api/http";
import {
  ClarificationWorkflowError,
  submitClarificationResponses,
} from "@/server/assessments/clarification-workflow";
import { compactPendingPatientMemoryIfThresholdMet } from "@/server/memory/patient-memory-snapshots";
import { MedicalRepository } from "@/server/repositories";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    requestId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { requestId } = clarificationRequestRouteParamsSchema.parse(
      await context.params,
    );
    const body = submitClarificationResponsesRequestSchema.parse(
      await readJsonBody(request),
    );
    const repository = new MedicalRepository();
    const result = submitClarificationResponses({
      repository,
      requestId,
      body,
    });
    const caseRecord = repository.getCase(result.request.case_id);
    const memoryResult =
      result.supplemental_input && caseRecord
        ? await compactPendingPatientMemoryIfThresholdMet({
            caseRecord,
            repository,
          })
        : undefined;

    return NextResponse.json(
      {
        ...result,
        memoryStatus: memoryResult?.status,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return badRequest(error.message);
    }

    if (isValidationError(error)) {
      return validationError(error);
    }

    if (error instanceof ClarificationWorkflowError) {
      return workflowErrorResponse(error);
    }

    return serverError();
  }
}

function workflowErrorResponse(error: ClarificationWorkflowError): NextResponse {
  return NextResponse.json(
    {
      error:
        error.status === 404
          ? "not_found"
          : error.status === 409
            ? "conflict"
            : "bad_request",
      message: error.message,
    },
    { status: error.status },
  );
}
