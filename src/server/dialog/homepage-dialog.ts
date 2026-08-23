import type { PatientMemory } from "@/lib/clinical-memory";
import { recallPatientMemory } from "@/server/memory/memory-policy";
import type { CaseConversationMessage } from "@/server/repositories/types";
import { z } from "zod";
import { createVolcengineChatClient } from "../llm/volcengine-client";

const RECENT_CONVERSATION_LIMIT = 8;
const MAX_DIALOG_ARRAY_ITEMS = 5;
const MAX_DIALOG_QUESTIONS = 3;
const MAX_DIALOG_DEBUG_TEXT_CHARS = 180;
const MAX_FALLBACK_INPUT_CHARS = 500;
const DIALOG_DEBUG_ENV_FLAG = "YENHO_DIALOG_DEBUG";

export const DialogQuestionSchema = z
  .object({
    clinical_purpose: z.string().trim().min(1),
    priority: z.enum(["high", "medium", "low"]),
    question: z.string().trim().min(1),
  })
  .strict();

export const DialogModelOutputSchema = z
  .object({
    clinician_response: z.string().trim().min(1),
    evidence_used: z.array(z.string().trim().min(1)).max(MAX_DIALOG_ARRAY_ITEMS),
    intent: z.string().trim().min(1),
    new_facts: z.array(z.string().trim().min(1)).max(MAX_DIALOG_ARRAY_ITEMS),
    next_step: z.string().trim().min(1),
    questions: z.array(DialogQuestionSchema).max(MAX_DIALOG_QUESTIONS),
    risk_flags: z.array(z.string().trim().min(1)).max(MAX_DIALOG_ARRAY_ITEMS),
    uncertainties: z.array(z.string().trim().min(1)).max(MAX_DIALOG_ARRAY_ITEMS),
  })
  .strict();

export const dialogModelOutputSchema = DialogModelOutputSchema;

export type DialogModelOutput = z.infer<typeof DialogModelOutputSchema>;

const RawDialogModelOutputSchema = z
  .object({
    clinician_response: z.string().trim().min(1),
    evidence_used: z.array(z.string()),
    intent: z.string().trim().min(1),
    new_facts: z.array(z.string()),
    next_step: z.string().trim().min(1),
    questions: z.array(z.unknown()),
    risk_flags: z.array(z.string()),
    uncertainties: z.array(z.string()),
  })
  .strict();

type DialogNormalizationResult =
  | {
      ok: true;
      output: DialogModelOutput;
    }
  | {
      ok: false;
      reason:
        | "forbidden_report_shape"
        | "invalid_json"
        | "invalid_schema"
        | "unsupported_high_risk_claim";
    };

type DialogNormalizationFailureReason = Extract<
  DialogNormalizationResult,
  { ok: false }
>["reason"];

export async function generateHomepageDialogResponse({
  currentClinicianInput,
  memory,
  recentMessages,
}: {
  currentClinicianInput: string;
  memory: PatientMemory;
  recentMessages: CaseConversationMessage[];
}): Promise<string> {
  const client = createVolcengineChatClient();

  if (!client.isConfigured()) {
    throw new Error("Dialog model is not configured.");
  }

  const recalledMemory = recallPatientMemory(memory, currentClinicianInput);
  const boundedRecentMessages = recentMessages
    .slice(-RECENT_CONVERSATION_LIMIT)
    .map((message) => ({
      content: message.content,
      createdAt: message.created_at,
      role: message.role,
    }));

  const rawOutput = await client.complete(
    [
      {
        role: "system",
        content: DIALOG_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            current_clinician_input: currentClinicianInput,
            recalled_patient_memory: recalledMemory,
            recent_conversation: boundedRecentMessages,
          },
          null,
          2,
        ),
      },
    ],
    "dialog",
  );
  const normalized = normalizeDialogModelOutput(rawOutput, {
    supportingEvidence: [
      currentClinicianInput,
      ...recalledMemory.flatMap((category) => [
        category.summary,
        ...category.items,
      ]),
      ...boundedRecentMessages.map((message) => message.content),
    ],
  });

  if (!normalized.ok) {
    const fallbackResponse = buildSafeDialogFallback(currentClinicianInput);

    logDialogDebug({
      fallbackResponse,
      reason: normalized.reason,
      status: "fallback",
    });

    return fallbackResponse;
  }

  const response = renderClinicianDialogResponse(normalized.output);

  logDialogDebug({
    output: normalized.output,
    response,
    status: "ok",
  });

  return response;
}

const DIALOG_SYSTEM_PROMPT = `
You are YenHo, a throat cancer specialty diagnosis and care-support agent for clinicians.
Support clinician-facing dialog for suspected or confirmed laryngeal, hypopharyngeal, oropharyngeal, and related throat cancers.

Your job in this homepage dialog is to help the clinician:
1. Clarify the working diagnosis and differential when the available evidence is incomplete.
2. Assess staging readiness: identify whether the current record has enough endoscopy, imaging, pathology, nodal, metastatic, and functional-status evidence to support later formal TNM staging.
3. Identify treatment suitability evidence that is present or missing, such as airway risk, swallowing and nutrition status, performance status, organ function, prior treatment, comorbidities, contraindications, and patient goals.
4. Recommend the next most useful data collection step or a small set of high-value clarification questions.

Context boundary:
- Use only the current clinician input, recalled patient memory, and bounded recent conversation provided in the user message.
- Do not treat any full conversation history, unseen chart, external guideline text, or unstated patient fact as available context.
- Distinguish confirmed facts from uncertainty and missing evidence.

Prompt-only testing mode:
- Until the throat cancer knowledge base is available, use this prompt-embedded checklist only as workflow guidance, not as patient-specific evidence.
- For suspected throat cancer, first orient around primary site and laterality, airway safety, swallowing/nutrition status, endoscopy findings, contrast CT/MRI/PET findings, pathology, nodal and metastatic status, ECOG, organ function, hearing status, comorbidities, prior treatment, and patient goals.
- Treat guideline-level treatment selection as out of scope for homepage dialog unless the required staging and fitness evidence is explicitly provided.

Safety rules:
- Do not invent, infer as certain, or fill in missing pathology, imaging, endoscopy, TNM stage, treatment response, contraindications, or laboratory values.
- Do not produce a complete staging report, definitive treatment recommendation report, or long-term memory update from this dialog.
- If evidence is insufficient, say what is missing and ask for the most clinically useful missing information.
- Do not reveal full chain-of-thought. Provide only a concise clinical reasoning summary that cites the evidence used, uncertainty, and recommended next step.

Output requirements:
- Output only a JSON object. Do not output Markdown or explanations outside JSON.
- The JSON object must include exactly these fields:
  - "intent": string describing the clinician's immediate dialog intent.
  - "new_facts": array of strings containing only newly stated clinical facts from current_clinician_input.
  - "evidence_used": array of strings naming the current input, recalled memory, or recent conversation evidence used.
  - "uncertainties": array of strings for missing or uncertain evidence.
  - "risk_flags": array of strings for urgent risks explicitly present or reasonably suspected from provided context; use an empty array if none.
  - "next_step": string with the single most useful next action.
  - "questions": array of no more than 3 prioritized question objects. Each question object must contain:
    - "question": concise follow-up question string.
    - "clinical_purpose": why this question matters clinically.
    - "priority": one of "high", "medium", or "low".
  - "clinician_response": string containing the final concise clinician-facing Agent message to persist in the conversation.

Arrays other than "questions" must contain no more than 5 strings. Do not include more than 3 questions.
The clinician_response should be clinically structured and focused on the next diagnostic or evidence-gathering step.
`.trim();

export function normalizeDialogModelOutput(
  rawOutput: string,
  options: { supportingEvidence?: string[] } = {},
): DialogNormalizationResult {
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(extractJsonObject(rawOutput));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const rawResult = RawDialogModelOutputSchema.safeParse(parsedJson);

  if (!rawResult.success) {
    return { ok: false, reason: "invalid_schema" };
  }

  const raw = rawResult.data;
  const normalizedCandidate = {
    clinician_response: raw.clinician_response.trim(),
    evidence_used: normalizeStringArray(raw.evidence_used),
    intent: raw.intent.trim(),
    new_facts: normalizeStringArray(raw.new_facts),
    next_step: raw.next_step.trim(),
    questions: raw.questions
      .map((question) => DialogQuestionSchema.safeParse(question))
      .filter((result) => result.success)
      .map((result) => result.data)
      .slice(0, MAX_DIALOG_QUESTIONS),
    risk_flags: normalizeStringArray(raw.risk_flags),
    uncertainties: normalizeStringArray(raw.uncertainties),
  };

  const normalizedResult = DialogModelOutputSchema.safeParse(normalizedCandidate);

  if (!normalizedResult.success) {
    return { ok: false, reason: "invalid_schema" };
  }

  if (
    hasUnsupportedHighRiskClaim(normalizedResult.data, options.supportingEvidence)
  ) {
    return { ok: false, reason: "unsupported_high_risk_claim" };
  }

  if (hasForbiddenReportShape(normalizedResult.data)) {
    return { ok: false, reason: "forbidden_report_shape" };
  }

  return { ok: true, output: normalizedResult.data };
}

export function renderClinicianDialogResponse(
  output: DialogModelOutput,
): string {
  const sections = [
    renderCurrentUnderstanding(output),
    renderRiskFlags(output.risk_flags),
    renderKeyUncertainty(output.uncertainties),
    renderSuggestedNextStep(output.next_step),
    renderNecessaryQuestions(output.questions),
  ];

  return sections.filter(Boolean).join("\n\n");
}

function renderCurrentUnderstanding(output: DialogModelOutput): string {
  const confirmedFacts =
    output.new_facts.length > 0
      ? output.new_facts.join("；")
      : "本次结构化结果未确认新的病例事实。";
  const evidence =
    output.evidence_used.length > 0
      ? `\n依据：${output.evidence_used.join("；")}`
      : "";

  return `Current understanding（已确认事实）：${confirmedFacts}${evidence}`;
}

function renderRiskFlags(riskFlags: string[]): string {
  if (riskFlags.length === 0) {
    return "";
  }

  const warnings = getRiskFlagWarnings(riskFlags);
  const lines = [
    `Risk flags（需立即核对/处置）：${riskFlags.join("；")}`,
    ...warnings,
  ];

  return lines.join("\n");
}

function renderKeyUncertainty(uncertainties: string[]): string {
  const summary =
    uncertainties.length > 0
      ? uncertainties.join("；")
      : "结构化结果未列出关键不确定性；仍需以原始资料核对。";

  return `Key uncertainty（关键不确定性）：${summary}`;
}

function renderSuggestedNextStep(nextStep: string): string {
  return `Suggested next step（建议下一步）：${nextStep}`;
}

function renderNecessaryQuestions(
  questions: DialogModelOutput["questions"],
): string {
  if (questions.length === 0) {
    return "Necessary questions（必要追问）：暂无新的必要追问。";
  }

  const renderedQuestions = questions.map((question, index) => {
    return `${index + 1}. [${renderQuestionPriority(question.priority)}] ${
      question.question
    }（目的：${question.clinical_purpose}）`;
  });

  return [
    "Necessary questions（必要追问）：",
    ...renderedQuestions,
  ].join("\n");
}

function renderQuestionPriority(
  priority: DialogModelOutput["questions"][number]["priority"],
): string {
  const priorityLabels = {
    high: "高",
    low: "低",
    medium: "中",
  } satisfies Record<
    DialogModelOutput["questions"][number]["priority"],
    string
  >;

  return priorityLabels[priority];
}

function logDialogDebug(
  event:
    | {
        fallbackResponse: string;
        reason: DialogNormalizationFailureReason;
        status: "fallback";
      }
    | {
        output: DialogModelOutput;
        response: string;
        status: "ok";
      },
): void {
  if (!shouldLogDialogDebug()) {
    return;
  }

  if (event.status === "fallback") {
    console.info(
      "[YenHo dialog debug]",
      JSON.stringify(
        {
          answer_preview: sanitizeDialogDebugText(event.fallbackResponse),
          reason: event.reason,
          status: event.status,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.info(
    "[YenHo dialog debug]",
    JSON.stringify(
      {
        answer_preview: sanitizeDialogDebugText(event.response),
        intent: sanitizeDialogDebugText(event.output.intent),
        questions: event.output.questions.map((question) => ({
          clinical_purpose: sanitizeDialogDebugText(question.clinical_purpose),
          priority: question.priority,
          question: sanitizeDialogDebugText(question.question),
        })),
        status: event.status,
        uncertainties: event.output.uncertainties.map(sanitizeDialogDebugText),
      },
      null,
      2,
    ),
  );
}

function shouldLogDialogDebug(): boolean {
  const flag = process.env[DIALOG_DEBUG_ENV_FLAG]?.toLowerCase();

  return (
    process.env.NODE_ENV !== "production" && (flag === "1" || flag === "true")
  );
}

function sanitizeDialogDebugText(value: string): string {
  const redacted = value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:\+?\d[\d -]{7,}\d)\b/g, "[phone]")
    .replace(/\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?\b/g, "[date]")
    .replace(/\b[A-Z]{2,}[-_]?[A-Z0-9-]{4,}\b/g, "[id]")
    .replace(/\d+(?:\.\d+)?/g, "[num]")
    .replace(/\s+/g, " ")
    .trim();

  if (redacted.length <= MAX_DIALOG_DEBUG_TEXT_CHARS) {
    return redacted;
  }

  return `${redacted.slice(0, MAX_DIALOG_DEBUG_TEXT_CHARS)}...`;
}

function getRiskFlagWarnings(riskFlags: string[]): string[] {
  const normalizedRiskText = normalizeEvidenceText(riskFlags.join(" "));
  const warnings: string[] = [];

  if (
    /气道|呼吸困难|喘鸣|窒息|喉阻塞|airway|dyspnea|stridor|obstruction/.test(
      normalizedRiskText,
    )
  ) {
    warnings.push(
      "提示：若气道受限、喘鸣或呼吸困难当前存在或正在加重，应优先评估气道安全并按急症路径处理。",
    );
  }

  if (
    /出血|咯血|呕血|大出血|bleed|hemorrhage|haemorrhage|hemoptysis/.test(
      normalizedRiskText,
    )
  ) {
    warnings.push(
      "提示：若存在活动性出血或咯血，应立即核对出血量、生命体征和急诊止血/转诊需求。",
    );
  }

  if (
    /严重吞咽|吞咽困难|不能吞咽|进食困难|误吸|dysphagia|aspiration/.test(
      normalizedRiskText,
    )
  ) {
    warnings.push(
      "提示：若存在严重吞咽困难、不能进食或误吸风险，应优先评估脱水、营养和安全进食需求。",
    );
  }

  if (
    /快速|迅速|急剧|恶化|进展|加重|rapid|worsen|deteriorat|progression/.test(
      normalizedRiskText,
    )
  ) {
    warnings.push(
      "提示：若症状快速恶化，应缩短复评间隔，并优先补充内镜/影像以排除急症进展。",
    );
  }

  return warnings;
}

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found.");
  }

  return value.slice(start, end + 1);
}

function normalizeStringArray(items: string[]): string[] {
  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_DIALOG_ARRAY_ITEMS);
}

function buildSafeDialogFallback(currentClinicianInput: string): string {
  const preservedInput = truncateForFallback(currentClinicianInput);

  return [
    "目前证据不足以形成确定的 TNM 分期、总体分期、治疗结论、检查结果或禁忌证判断。",
    "建议先补充并核对关键资料：内镜描述、病理结果、颈胸部增强影像、淋巴结/远处转移评估，以及 ECOG、营养/吞咽和气道风险。",
    preservedInput ? `已保留本次医生输入：${preservedInput}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function truncateForFallback(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  if (normalized.length <= MAX_FALLBACK_INPUT_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_FALLBACK_INPUT_CHARS)}...`;
}

function hasUnsupportedHighRiskClaim(
  output: DialogModelOutput,
  supportingEvidence: string[] = [],
): boolean {
  const evidenceText = normalizeEvidenceText(supportingEvidence.join(" "));
  const checkedText = [
    output.clinician_response,
    output.next_step,
    ...output.new_facts,
  ].join("\n");

  return splitClinicalSentences(checkedText).some((sentence) =>
    hasUnsupportedHighRiskSentence(sentence, evidenceText),
  );
}

function hasForbiddenReportShape(output: DialogModelOutput): boolean {
  const checkedText = [output.clinician_response, output.next_step].join("\n");

  const explicitReportPattern =
    /(?:complete\s+|formal\s+)?(?:staging|tnm)\s+report|(?:complete\s+|formal\s+)?treatment\s+recommendation\s+report|(?:完整|正式).{0,8}(?:分期|治疗建议|治疗推荐).{0,4}报告/i;

  if (
    splitClinicalSentences(checkedText).some(
      (sentence) =>
        !isUncertaintyOrEvidenceGapSentence(sentence) &&
        explicitReportPattern.test(sentence),
    )
  ) {
    return true;
  }

  const reportHeadingPatterns = [
    /^\s*(?:#{1,6}\s*)?(?:assessment report|final report|评估报告|报告结论)\s*[:：]/im,
    /^\s*(?:#{1,6}\s*)?(?:staging|tnm staging|tnm|分期|tnm分期)\s*[:：]/im,
    /^\s*(?:#{1,6}\s*)?(?:treatment recommendations?|treatment plan|治疗建议|治疗推荐|治疗方案)\s*[:：]/im,
    /^\s*(?:#{1,6}\s*)?(?:sensitivity assessment|tolerance assessment|敏感性评估|耐受性评估)\s*[:：]/im,
    /^\s*(?:#{1,6}\s*)?(?:citations?|references?|引用|参考依据)\s*[:：]/im,
  ];
  const headingCount = reportHeadingPatterns.filter((pattern) =>
    pattern.test(checkedText),
  ).length;

  return headingCount >= 2;
}

function hasUnsupportedHighRiskSentence(
  sentence: string,
  evidenceText: string,
): boolean {
  if (isUncertaintyOrEvidenceGapSentence(sentence)) {
    return false;
  }

  const normalizedSentence = normalizeEvidenceText(sentence);
  const tnmMatch = normalizedSentence.match(/\b[ycpr]?t[0-4x][a-c]?n[0-3x][a-c]?m[01x][a-c]?\b/);
  const stageMatch = normalizedSentence.match(
    /(?:stage|临床分期|病理分期|总体分期|分期)(?:0|iv[abc]?|i{1,3}|[一二三四]期|早期|晚期)/i,
  );

  if (tnmMatch && !evidenceText.includes(tnmMatch[0])) {
    return true;
  }

  if (stageMatch && !evidenceText.includes(stageMatch[0])) {
    return true;
  }

  if (hasUnsupportedTreatmentConclusion(sentence)) {
    return true;
  }

  if (hasUnsupportedExamResult(sentence, evidenceText)) {
    return true;
  }

  return hasUnsupportedContraindicationConclusion(sentence, evidenceText);
}

function isUncertaintyOrEvidenceGapSentence(sentence: string): boolean {
  return /证据不足|尚未|未提供|未明确|不能|无法|不足以|待补充|需补充|需要补充|请补充|缺少|无法确定|不宜确定|暂不/.test(
    sentence,
  );
}

function hasUnsupportedTreatmentConclusion(sentence: string): boolean {
  if (
    !/(建议|推荐|首选|应当|应该|直接|立即|可行)\S{0,16}(手术|放疗|化疗|同步放化疗|免疫治疗|靶向治疗|诱导化疗|顺铂|喉切除|切除)/.test(
      sentence,
    )
  ) {
    return false;
  }

  return !/(建议|推荐)\S{0,8}(补充|核对|完善|评估|收集|提供)\S{0,16}(治疗|手术|放疗|化疗|同步放化疗|免疫治疗|靶向治疗|诱导化疗|顺铂|喉切除|切除)/.test(
    sentence,
  );
}

function hasUnsupportedExamResult(
  sentence: string,
  evidenceText: string,
): boolean {
  if (
    !/(病理|活检|ct|mri|pet|喉镜|内镜|影像)\S{0,20}(提示|显示|证实|确诊|符合|发现)\S{0,24}(鳞癌|转移|侵犯|占位|阳性|阴性|狭窄|肿瘤|声门|淋巴结|远处)/i.test(
      sentence,
    )
  ) {
    return false;
  }

  const hasSupportedModality = hasSharedClinicalToken(sentence, evidenceText, [
    "病理",
    "活检",
    "ct",
    "mri",
    "pet",
    "喉镜",
    "内镜",
    "影像",
  ]);
  const hasSupportedFinding = hasSharedClinicalToken(sentence, evidenceText, [
    "鳞癌",
    "转移",
    "侵犯",
    "占位",
    "阳性",
    "阴性",
    "狭窄",
    "肿瘤",
    "声门",
    "淋巴结",
    "远处",
  ]);

  return !(hasSupportedModality && hasSupportedFinding);
}

function hasUnsupportedContraindicationConclusion(
  sentence: string,
  evidenceText: string,
): boolean {
  if (!/(无|没有|存在|排除|明确)\S{0,20}禁忌证|禁忌证\S{0,20}(无|没有|存在|排除|明确)/.test(sentence)) {
    return false;
  }

  return !evidenceText.includes("禁忌证");
}

function hasSharedClinicalToken(
  sentence: string,
  evidenceText: string,
  tokens: string[],
): boolean {
  const normalizedSentence = normalizeEvidenceText(sentence);

  return tokens.some((token) => {
    const normalizedToken = normalizeEvidenceText(token);

    return (
      normalizedSentence.includes(normalizedToken) &&
      evidenceText.includes(normalizedToken)
    );
  });
}

function splitClinicalSentences(value: string): string[] {
  return value
    .split(/[。！？!?；;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}
