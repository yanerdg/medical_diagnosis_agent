import {
  caseRouteParamsSchema,
  structureSpecialtyRequestSchema,
} from "@/server/api/cases";
import {
  badRequest,
  InvalidJsonError,
  isValidationError,
  notFound,
  readJsonBody,
  serverError,
  validationError,
} from "@/server/api/http";
import {
  applyClinicianCorrections,
  extractSpecialtyStructure,
} from "@/server/cases/structured-extraction";
import { MedicalRepository } from "@/server/repositories";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    caseId: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { caseId } = caseRouteParamsSchema.parse(await context.params);
    const body = structureSpecialtyRequestSchema.parse(
      await readJsonBody(request),
    );
    const repository = new MedicalRepository();
    const caseRecord = repository.getCase(caseId);

    if (!caseRecord) {
      return notFound("Case not found.");
    }

    const latestStructure = repository.getLatestSpecialtyStructure(caseId);
    const version = (latestStructure?.version ?? 0) + 1;
    const createdAt = new Date().toISOString();

    if (body.action === "extract") {
      const inputs = repository
        .listCaseInputs(caseId)
        .map((input) => ({
          input,
          raw_text: repository.readCaseInputRawText(input.input_id) ?? "",
        }))
        .filter((input) => input.raw_text.trim().length > 0);

      if (inputs.length === 0) {
        return badRequest("Case has no raw inputs to structure.");
      }

      const result = extractSpecialtyStructure({
        case_id: caseId,
        inputs,
        version,
        created_at: createdAt,
      });

      repository.saveSpecialtyStructure(result.structure);
      repository.recordAuditEvent({
        entity_type: "specialty_structure",
        entity_id: result.structure.structure_id,
        action: "structured_extraction",
        payload: {
          case_id: caseId,
          version,
          evidence: result.evidence,
        },
        created_at: createdAt,
      });
      repository.saveCase({
        ...caseRecord,
        status: "ready_for_assessment",
        updated_at: createdAt,
      });

      return NextResponse.json(result, { status: 201 });
    }

    if (!latestStructure) {
      return badRequest("Run structure extraction before submitting corrections.");
    }

    const result = applyClinicianCorrections({
      case_id: caseId,
      base_structure: latestStructure,
      corrections: body.corrections,
      version,
      clinician_id: body.clinician_id,
      created_at: createdAt,
    });

    if (result.evidence.length === 0) {
      return badRequest("No correction changed the latest structure.");
    }

    repository.saveSpecialtyStructure(result.structure);
    repository.recordAuditEvent({
      entity_type: "specialty_structure",
      entity_id: result.structure.structure_id,
      action: "clinician_correction",
      actor_id: body.clinician_id,
      payload: {
        case_id: caseId,
        version,
        base_structure_id: latestStructure.structure_id,
        evidence: result.evidence,
      },
      created_at: createdAt,
    });
    repository.saveCase({
      ...caseRecord,
      status: "ready_for_assessment",
      updated_at: createdAt,
    });

    return NextResponse.json(result, { status: 201 });
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
