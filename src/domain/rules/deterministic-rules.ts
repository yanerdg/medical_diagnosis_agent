import type {
  AssessmentReportJson,
  LabSummary,
  ToleranceAssessmentItem,
} from "../schemas";

export type RuleSeverity = "error" | "warning";

export type RuleIssue = {
  code: string;
  severity: RuleSeverity;
  message: string;
  path?: string;
  evidence?: string;
};

export type RedFlagCategory =
  | "airway"
  | "bleeding"
  | "severe_dysphagia"
  | "infection"
  | "critical_value";

export type RedFlagLevel = "urgent" | "emergency";

export type DetectedRedFlag = {
  category: RedFlagCategory;
  level: RedFlagLevel;
  matched_text: string;
};

export type SafetyGateInput = {
  report: AssessmentReportJson;
  sourceTexts?: string[];
  outputText?: string;
  labs?: LabSummary;
};

export type SafetyGateResult = {
  allowed: boolean;
  status: "passed" | "rejected";
  issues: RuleIssue[];
  red_flags: DetectedRedFlag[];
};

type RequiredToleranceInput =
  | "ECOG"
  | "血常规"
  | "肝功能"
  | "肾功能"
  | "白蛋白";

const CONFIRMED_DIAGNOSIS_PATTERNS = [
  /已确诊/,
  /确诊为/,
  /病理确诊/,
  /confirmed diagnosis/i,
  /pathologically confirmed/i,
  /diagnosed with/i,
];

const RED_FLAG_PATTERNS: Array<{
  category: RedFlagCategory;
  level: RedFlagLevel;
  patterns: RegExp[];
}> = [
  {
    category: "airway",
    level: "emergency",
    patterns: [
      /喉梗阻/,
      /气道(?:危急|严重狭窄|受阻|梗阻)/,
      /喉腔(?:明显)?狭窄/,
      /喘鸣/,
      /静息(?:呼吸困难|气促)/,
      /窒息/,
      /stridor/i,
      /airway obstruction/i,
    ],
  },
  {
    category: "bleeding",
    level: "urgent",
    patterns: [/活动性出血/, /咯血/, /出血不止/, /大出血/, /hemoptysis/i],
  },
  {
    category: "severe_dysphagia",
    level: "urgent",
    patterns: [
      /严重吞咽困难/,
      /不能吞咽/,
      /无法吞咽/,
      /误吸/,
      /明显脱水/,
      /重度营养不良/,
      /severe dysphagia/i,
      /aspiration/i,
    ],
  },
  {
    category: "infection",
    level: "urgent",
    patterns: [
      /严重感染/,
      /高热/,
      /脓毒症/,
      /感染性休克/,
      /sepsis/i,
      /septic shock/i,
    ],
  },
  {
    category: "critical_value",
    level: "urgent",
    patterns: [
      /危急值/,
      /白细胞[^。；,，]*?(?:危急|极低|极高)/,
      /血小板[^。；,，]*?(?:<|低于)\s*20/,
      /血红蛋白[^。；,，]*?(?:<|低于)\s*60/,
      /肌酐[^。；,，]*?(?:危急|显著升高)/,
      /电解质[^。；,，]*?危急/,
      /critical value/i,
    ],
  },
];

const SAFETY_PATTERNS: Array<{
  code: string;
  message: string;
  patterns: RegExp[];
}> = [
  {
    code: "safety.no_dose",
    message: "不得输出药物剂量或给药用量。",
    patterns: [
      /(?:剂量|用量|每次|每日)/,
      /(?:顺铂|卡铂|紫杉醇|西妥昔单抗|免疫治疗|化疗|放疗|给药|静滴|口服)[^。；\n]*(?:mg\/m2|mg\/㎡|\d+\s*(?:mg|g|ml|IU|单位))/i,
      /(?:mg\/m2|mg\/㎡|\d+\s*(?:mg|g|ml|IU|单位))[^。；\n]*(?:给药|静滴|口服|化疗|放疗)/i,
    ],
  },
  {
    code: "safety.no_course",
    message: "不得输出疗程、周期或自动化治疗安排。",
    patterns: [
      /疗程/,
      /(?:\d+|[一二三四五六七八九十]+)\s*个?周期/,
      /每\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:周|天).*?(?:一次|周期)/,
      /连续\s*(?:\d+|[一二三四五六七八九十]+)\s*天/,
    ],
  },
  {
    code: "safety.no_automatic_order",
    message: "不得自动处方、自动开医嘱或写回正式病历。",
    patterns: [
      /自动(?:处方|开立|开医嘱|医嘱|下单|执行|写回)/,
      /(?:生成|开具|下达)医嘱/,
      /开药/,
      /处方已生成/,
      /直接写回(?:正式)?病历/,
    ],
  },
  {
    code: "safety.require_clinician_review",
    message: "不得绕过医生复核、病理复核或 MDT 判断。",
    patterns: [
      /无需(?:医生|医师|临床|MDT|病理).*?(?:复核|判断|确认|会诊)/,
      /不需要.*?(?:医生|医师|临床|MDT|病理).*?(?:复核|判断|确认|会诊)/,
      /绕过.*?(?:医生|医师|临床|MDT|病理|复核)/,
      /可直接执行/,
      /无需复核/,
    ],
  },
];

export function evaluatePathologyRules(
  report: AssessmentReportJson,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const pathologyStatus = report.diagnostic_evidence.pathology_status;
  const hasConfirmedPathology = pathologyStatus === "confirmed";

  if (
    hasConfirmedPathology &&
    !hasConcretePathologyType(report.diagnostic_evidence.pathology_type)
  ) {
    issues.push({
      code: "pathology.confirmed_requires_pathology",
      severity: "error",
      path: "diagnostic_evidence.pathology_status",
      message: "缺少明确病理类型时不能将 pathology_status 标记为 confirmed。",
      evidence: report.diagnostic_evidence.pathology_type,
    });
  }

  if (!hasConfirmedPathology) {
    const confirmedText = collectStrings(report).find((value) =>
      CONFIRMED_DIAGNOSIS_PATTERNS.some((pattern) => pattern.test(value)),
    );

    if (confirmedText !== undefined) {
      issues.push({
        code: "pathology.no_confirmed_text_without_pathology",
        severity: "error",
        message: "缺少病理确认时不能输出“已确诊”或等价表述。",
        evidence: confirmedText,
      });
    }

    report.sensitivity_assessment.forEach((item, index) => {
      if (item.level === "likely_sensitive") {
        issues.push({
          code: "pathology.no_likely_sensitive_without_pathology",
          severity: "error",
          path: `sensitivity_assessment.${index}.level`,
          message: "缺少病理确认时敏感性结论不能为 likely_sensitive。",
          evidence: item.modality,
        });
      }
    });
  }

  return issues;
}

export function evaluateToleranceRules(
  report: AssessmentReportJson,
  labs?: LabSummary,
): RuleIssue[] {
  const labMissingInputs = getMissingToleranceInputsFromLabs(labs);

  return report.tolerance_assessment.flatMap((item, index) =>
    item.level === "good" &&
    getMissingToleranceInputsForItem(item, labMissingInputs).length > 0
      ? [
          buildToleranceIssue(
            item,
            index,
            getMissingToleranceInputsForItem(item, labMissingInputs).join("、"),
          ),
        ]
      : [],
  );
}

export function detectRedFlags(input: string | string[]): DetectedRedFlag[] {
  const texts = Array.isArray(input) ? input : [input];
  const detected = new Map<RedFlagCategory, DetectedRedFlag>();

  for (const text of texts) {
    for (const config of RED_FLAG_PATTERNS) {
      if (detected.has(config.category)) {
        continue;
      }

      const matchedPattern = config.patterns.find((pattern) =>
        pattern.test(text),
      );
      if (matchedPattern !== undefined) {
        detected.set(config.category, {
          category: config.category,
          level: config.level,
          matched_text: extractMatchedSnippet(text, matchedPattern),
        });
      }
    }
  }

  return Array.from(detected.values());
}

export function evaluateRedFlagRules(
  report: AssessmentReportJson,
  sourceTexts: string[] = [],
): { issues: RuleIssue[]; red_flags: DetectedRedFlag[] } {
  const redFlags = detectRedFlags([
    ...sourceTexts,
    ...report.red_flags,
    report.summary,
  ]);
  const surfacedText = report.red_flags.join("\n");
  const issues = redFlags.flatMap((redFlag) =>
    redFlagIsSurfaced(redFlag, surfacedText)
      ? []
      : [
          {
            code: "red_flag.must_surface",
            severity: "error" as const,
            path: "red_flags",
            message: "输入中存在红旗风险时必须在报告 red_flags 中靠前输出。",
            evidence: redFlag.matched_text,
          },
        ],
  );

  return { issues, red_flags: redFlags };
}

export function evaluateSafetyRules(outputText: string): RuleIssue[] {
  return SAFETY_PATTERNS.flatMap((config) => {
    const matchedPattern = config.patterns.find((pattern) =>
      pattern.test(outputText),
    );

    return matchedPattern === undefined
      ? []
      : [
          {
            code: config.code,
            severity: "error" as const,
            message: config.message,
            evidence: extractMatchedSnippet(outputText, matchedPattern),
          },
        ];
  });
}

export function runDeterministicSafetyGate(
  input: SafetyGateInput,
): SafetyGateResult {
  const redFlagResult = evaluateRedFlagRules(input.report, input.sourceTexts);
  const issues = [
    ...evaluatePathologyRules(input.report),
    ...evaluateToleranceRules(input.report, input.labs),
    ...redFlagResult.issues,
    ...evaluateSafetyRules(
      input.outputText ?? collectStrings(input.report).join("\n"),
    ),
  ];
  const hasError = issues.some((issue) => issue.severity === "error");

  return {
    allowed: !hasError,
    status: hasError ? "rejected" : "passed",
    issues,
    red_flags: redFlagResult.red_flags,
  };
}

function hasConcretePathologyType(pathologyType: string): boolean {
  const normalized = pathologyType.trim().toLowerCase();

  return (
    normalized.length > 0 &&
    !["unknown", "not_available", "not available", "未提供", "未知", "无"].includes(
      normalized,
    )
  );
}

function getMissingToleranceInputsFromLabs(
  labs: LabSummary | undefined,
): RequiredToleranceInput[] {
  if (labs === undefined) {
    return [];
  }

  const missing: RequiredToleranceInput[] = [];
  if (labs.ecog === undefined) {
    missing.push("ECOG");
  }
  if (!labs.blood_routine_available) {
    missing.push("血常规");
  }
  if (!labs.liver_function_available) {
    missing.push("肝功能");
  }
  if (!labs.kidney_function_available) {
    missing.push("肾功能");
  }
  if (!labs.albumin_available) {
    missing.push("白蛋白");
  }

  return missing;
}

function getMissingToleranceInputsFromTexts(
  values: string[],
): RequiredToleranceInput[] {
  const text = values.join("\n");
  const missing: RequiredToleranceInput[] = [];

  if (/ECOG/i.test(text)) {
    missing.push("ECOG");
  }
  if (/血常规|骨髓储备|白细胞|血小板|血红蛋白/.test(text)) {
    missing.push("血常规");
  }
  if (/肝肾功能|肝功能/.test(text)) {
    missing.push("肝功能");
  }
  if (/肝肾功能|肾功能|肌酐|eGFR/i.test(text)) {
    missing.push("肾功能");
  }
  if (/白蛋白|营养状态/.test(text)) {
    missing.push("白蛋白");
  }

  return missing;
}

function getMissingToleranceInputsForItem(
  item: ToleranceAssessmentItem,
  labMissingInputs: RequiredToleranceInput[],
): RequiredToleranceInput[] {
  return Array.from(
    new Set([
      ...labMissingInputs,
      ...getMissingToleranceInputsFromTexts(item.missing_information),
    ]),
  );
}

function buildToleranceIssue(
  item: ToleranceAssessmentItem,
  index: number,
  missingInputs: string,
): RuleIssue {
  return {
    code: "tolerance.no_good_with_missing_key_inputs",
    severity: "error",
    path: `tolerance_assessment.${index}.level`,
    message: "缺少关键耐受性信息时对应耐受性不能为 good。",
    evidence: `${item.modality}: missing ${missingInputs}`,
  };
}

function redFlagIsSurfaced(
  redFlag: DetectedRedFlag,
  surfacedText: string,
): boolean {
  if (surfacedText.length === 0) {
    return false;
  }

  if (surfacedText.includes(redFlag.matched_text)) {
    return true;
  }

  const categoryKeywords: Record<RedFlagCategory, RegExp> = {
    airway: /气道|喉梗阻|喘鸣|呼吸困难|窒息|airway|stridor/i,
    bleeding: /出血|咯血|hemoptysis/i,
    severe_dysphagia: /吞咽|误吸|脱水|营养不良|dysphagia|aspiration/i,
    infection: /感染|高热|脓毒症|sepsis/i,
    critical_value: /危急值|白细胞|血小板|血红蛋白|肌酐|电解质|critical/i,
  };

  return categoryKeywords[redFlag.category].test(surfacedText);
}

function extractMatchedSnippet(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  if (match?.index === undefined) {
    return text.slice(0, 120);
  }

  const start = Math.max(0, match.index - 24);
  const end = Math.min(text.length, match.index + match[0].length + 24);

  return text.slice(start, end);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectStrings(item));
  }

  return [];
}
