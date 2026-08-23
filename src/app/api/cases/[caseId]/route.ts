import { caseRouteParamsSchema } from "@/server/api/cases";
import {
  isValidationError,
  notFound,
  serverError,
  validationError,
} from "@/server/api/http";
import { MedicalRepository } from "@/server/repositories";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    caseId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { caseId } = caseRouteParamsSchema.parse(await context.params);
    const repository = new MedicalRepository();
    const caseRecord = repository.getCase(caseId);

    if (!caseRecord) {
      return notFound("Case not found.");
    }

    return NextResponse.json({
      case: caseRecord,
      inputs: repository.listCaseInputs(caseId).map((input) => ({
        ...input,
        raw_text: repository.readCaseInputRawText(input.input_id) ?? "",
      })),
    });
  } catch (error) {
    if (isValidationError(error)) {
      return validationError(error);
    }

    return serverError();
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { caseId } = caseRouteParamsSchema.parse(await context.params);
    const repository = new MedicalRepository();
    const deleted = repository.deleteCase(caseId);

    if (!deleted) {
      return notFound("Case not found.");
    }

    return NextResponse.json({ case_id: caseId, deleted: true });
  } catch (error) {
    if (isValidationError(error)) {
      return validationError(error);
    }

    return serverError();
  }
}
