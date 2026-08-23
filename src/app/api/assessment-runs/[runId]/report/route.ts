import { assessmentRunRouteParamsSchema } from "@/server/api/assessments";
import {
  isValidationError,
  serverError,
  validationError,
} from "@/server/api/http";
import {
  AssessmentWorkflowError,
  getAssessmentRunReport,
} from "@/server/assessments/assessment-workflow";
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

    return NextResponse.json(
      await getAssessmentRunReport(new MedicalRepository(), runId),
    );
  } catch (error) {
    if (isValidationError(error)) {
      return validationError(error);
    }

    if (error instanceof AssessmentWorkflowError) {
      return workflowErrorResponse(error);
    }

    return serverError();
  }
}

function workflowErrorResponse(error: AssessmentWorkflowError): NextResponse {
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
