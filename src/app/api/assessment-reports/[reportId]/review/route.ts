import {
  assessmentReportRouteParamsSchema,
  submitReportReviewRequestSchema,
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
  AssessmentWorkflowError,
  submitAssessmentReportReview,
} from "@/server/assessments/assessment-workflow";
import { MedicalRepository } from "@/server/repositories";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    reportId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { reportId } = assessmentReportRouteParamsSchema.parse(
      await context.params,
    );
    const body = submitReportReviewRequestSchema.parse(
      await readJsonBody(request),
    );

    return NextResponse.json(
      await submitAssessmentReportReview({
        repository: new MedicalRepository(),
        reportId,
        body,
      }),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof InvalidJsonError) {
      return badRequest(error.message);
    }

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
