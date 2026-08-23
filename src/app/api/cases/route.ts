import { caseSchema } from "@/domain/schemas";
import { createCaseRequestSchema } from "@/server/api/cases";
import {
  badRequest,
  InvalidJsonError,
  isValidationError,
  readJsonBody,
  serverError,
  validationError,
} from "@/server/api/http";
import { MedicalRepository } from "@/server/repositories";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = createCaseRequestSchema.parse(await readJsonBody(request));
    const now = new Date().toISOString();
    const repository = new MedicalRepository();
    const caseRecord = caseSchema.parse({
      case_id: randomUUID(),
      display_name: body.display_name.trim(),
      patient_ref: body.patient_ref,
      status: "draft",
      created_at: now,
      updated_at: now,
    });

    return NextResponse.json(
      {
        case: repository.saveCase(caseRecord),
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

    return serverError();
  }
}
