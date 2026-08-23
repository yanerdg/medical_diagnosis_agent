import {
  caseRouteParamsSchema,
  createCaseInputsRequestSchema,
} from "@/server/api/cases";
import type { CreateCaseInputRequest } from "@/server/api/cases";
import {
  badRequest,
  InvalidJsonError,
  isValidationError,
  notFound,
  readJsonBody,
  serverError,
  validationError,
} from "@/server/api/http";
import { generateHomepageDialogResponse } from "@/server/dialog/homepage-dialog";
import {
  compactPendingPatientMemoryIfThresholdMet,
  getPatientMemorySnapshotForRead,
} from "@/server/memory/patient-memory-snapshots";
import { createPendingRoughMemoryForCaseInput } from "@/server/memory/rough-memory";
import { MedicalRepository } from "@/server/repositories";
import type { CaseConversationMessage } from "@/server/repositories/types";
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
    const body = createCaseInputsRequestSchema.parse(await readJsonBody(request));
    const repository = new MedicalRepository();
    const caseRecord = repository.getCase(caseId);

    if (!caseRecord) {
      return notFound("Case not found.");
    }

    const submittedAt = new Date().toISOString();
    if ("inputs" in body) {
      const inputs = body.inputs.map((inputDraft) => {
        const input = repository.createCaseInputFromRawText({
          case_id: caseId,
          input_type: inputDraft.input_type,
          raw_text: inputDraft.raw_text,
          submitted_at: submittedAt,
        });
        createPendingRoughMemoryForCaseInput({
          input,
          rawText: inputDraft.raw_text,
          repository,
        });

        return input;
      });
      const nextCaseRecord = repository.saveCase({
        ...caseRecord,
        updated_at: submittedAt,
      });
      const memoryResult = await compactPendingPatientMemoryIfThresholdMet({
        caseRecord: nextCaseRecord,
        repository,
      });

      return NextResponse.json(
        { inputs, memoryStatus: memoryResult.status },
        { status: 201 },
      );
    }

    const shouldPersistAsClinicalMemory =
      !body.run_agent_turn || shouldPersistClinicianTurnAsClinicalMemory(body);
    const dialogMemoryBeforeTurn = body.run_agent_turn
      ? getPatientMemorySnapshotForRead({
          caseRecord,
          repository,
        }).memory
      : null;
    const input = shouldPersistAsClinicalMemory
      ? repository.createCaseInputFromRawText({
          case_id: caseId,
          input_type: body.input_type,
          raw_text: body.raw_text,
          submitted_at: submittedAt,
        })
      : null;

    if (input) {
      createPendingRoughMemoryForCaseInput({
        input,
        rawText: body.raw_text,
        repository,
      });
    }

    const nextCaseRecord = {
      ...caseRecord,
      updated_at: submittedAt,
    };

    repository.saveCase(nextCaseRecord);
    const memoryResult = await compactPendingPatientMemoryIfThresholdMet({
      caseRecord: nextCaseRecord,
      repository,
    });

    if (!body.run_agent_turn) {
      return NextResponse.json(
        { input, memoryStatus: memoryResult.status },
        { status: 201 },
      );
    }

    const clinicianMessage = repository.createCaseConversationMessage({
      case_id: caseId,
      case_input_id: input?.input_id,
      content: body.raw_text.trim(),
      created_at: submittedAt,
      role: "clinician",
    });
    const recentMessages = repository
      .listCaseConversationMessages(caseId, { limit: 9 })
      .filter(
        (message) => message.message_id !== clinicianMessage.message_id,
      )
      .slice(-8);

    try {
      const agentContent = await generateHomepageDialogResponse({
        currentClinicianInput: body.raw_text.trim(),
        memory: dialogMemoryBeforeTurn ?? memoryResult.memory,
        recentMessages,
      });
      const agentMessage = repository.createCaseConversationMessage({
        case_id: caseId,
        content: agentContent.trim(),
        role: "agent",
      });

      return NextResponse.json(
        {
          agentMessage: toConversationMessageResponse(agentMessage),
          clinicianMessage: toConversationMessageResponse(clinicianMessage),
          input,
          memoryStatus: memoryResult.status,
        },
        { status: 201 },
      );
    } catch {
      return NextResponse.json(
        {
          agentError: "Agent response generation failed.",
          agentMessage: null,
          clinicianMessage: toConversationMessageResponse(clinicianMessage),
          input,
          memoryStatus: memoryResult.status,
        },
        { status: 201 },
      );
    }
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

function shouldPersistClinicianTurnAsClinicalMemory(
  body: CreateCaseInputRequest,
): boolean {
  if (body.input_type !== "clinician_note") {
    return true;
  }

  const text = body.raw_text.trim();

  if (hasClinicalFactSignal(text)) {
    return true;
  }

  if (isWorkflowQuestionOnly(text)) {
    return false;
  }

  return true;
}

function hasClinicalFactSignal(text: string): boolean {
  return /男性|女性|男|女|岁|year-old|yo|声嘶|声音嘶哑|咽痛|吞咽|呼吸困难|喘鸣|咯血|出血|体重|身高|吸烟|饮酒|ecog|ps\b|ct|mri|pet|喉镜|内镜|影像|活检|病理|鳞癌|癌|肿瘤|肿物|淋巴结|转移|侵犯|白蛋白|肌酐|血红蛋白|hgb|hb|wbc|plt|creatinine|albumin|顺铂|放疗|化疗|手术|治疗史|既往|合并症|禁忌证/i.test(
    text,
  );
}

function isWorkflowQuestionOnly(text: string): boolean {
  return /[？?]$|吗$|么$|还需要|需要什么|要什么|补充什么|哪些检查|什么检查|哪些报告|什么报告|检验报告|化验报告|怎么做|下一步|能不能|是否需要|请问/i.test(
    text,
  );
}

function toConversationMessageResponse(message: CaseConversationMessage) {
  return {
    caseInputId: message.case_input_id,
    content: message.content,
    createdAt: message.created_at,
    messageId: message.message_id,
    role: message.role,
  };
}
