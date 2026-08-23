import { assessmentRunRouteParamsSchema } from "@/server/api/assessments";
import {
  isValidationError,
  serverError,
  validationError,
} from "@/server/api/http";
import {
  ClarificationWorkflowError,
  listRunClarificationRequests,
} from "@/server/assessments/clarification-workflow";
import { MedicalRepository } from "@/server/repositories";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    runId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { runId } = assessmentRunRouteParamsSchema.parse(
      await context.params,
    );
    const result = listRunClarificationRequests(
      new MedicalRepository(),
      runId,
    );

    return NextResponse.json(result);
  } catch (error) {
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
