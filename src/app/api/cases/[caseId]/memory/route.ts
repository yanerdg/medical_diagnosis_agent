import { caseRouteParamsSchema } from "@/server/api/cases";
import {
  isValidationError,
  notFound,
  serverError,
  validationError,
} from "@/server/api/http";
import { getOrRefreshPatientMemorySnapshot } from "@/server/memory/patient-memory-snapshots";
import { MedicalRepository } from "@/server/repositories";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{
    caseId: string;
  }>;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { caseId } = caseRouteParamsSchema.parse(await context.params);
    const forceRefresh = shouldForceRefreshMemory(request);
    const repository = new MedicalRepository();
    const caseRecord = repository.getCase(caseId);

    if (!caseRecord) {
      return notFound("Case not found.");
    }

    const result = await getOrRefreshPatientMemorySnapshot({
      caseRecord,
      forceRefresh,
      repository,
    });

    return NextResponse.json({
      memory: result.memory,
      mode: result.mode,
      status: result.status,
    });
  } catch (error) {
    if (isValidationError(error)) {
      return validationError(error);
    }

    return serverError();
  }
}

function shouldForceRefreshMemory(request: Request): boolean {
  const searchParams = new URL(request.url).searchParams;
  const refreshFlag =
    searchParams.get("forceRefresh") ?? searchParams.get("refresh");

  return refreshFlag === "1" || refreshFlag === "true";
}
