import {
  evidenceModelListSchema,
  jsonValueSchema,
  type EvidenceModel,
  type JsonValue,
} from "@/domain/evidence";
import {
  specialtyStructureSchema,
  type CancerSite,
  type CaseInput,
  type CtSummary,
  type LabSummary,
  type PathologyStatus,
  type SpecialtyStructure,
  type ToleranceFactorSummary,
} from "@/domain/schemas";
import type { AuditEvent } from "@/server/repositories";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export interface CaseInputText {
  input: CaseInput;
  raw_text: string;
}

export interface StructureExtractionParams {
  case_id: string;
  inputs: CaseInputText[];
  version: number;
  created_at?: string;
}

export interface StructureExtractionResult {
  structure: SpecialtyStructure;
  evidence: EvidenceModel[];
}

export interface ClinicianStructureCorrections {
  cancer_site?: CancerSite;
  pathology?: {
    status?: PathologyStatus;
    pathology_type?: string | null;
    differentiation?: string | null;
  };
  ct?: {
    primary_site?: string | null;
    invasion_clues?: string[];
    lymph_node_clues?: string[];
    distant_metastasis_clues?: string[];
  };
  biomarkers?: Record<string, string>;
  labs?: {
    ecog?: number | null;
    blood_routine_available?: boolean;
    liver_function_available?: boolean;
    kidney_function_available?: boolean;
    albumin_available?: boolean;
    abnormal_clues?: string[];
  };
  tolerance_factors?: ToleranceFactorSummary[];
}

export interface ClinicianCorrectionParams {
  case_id: string;
  base_structure: SpecialtyStructure;
  corrections: ClinicianStructureCorrections;
  version: number;
  clinician_id?: string;
  created_at?: string;
}

const structureEvidenceAuditPayloadSchema = z
  .object({
    evidence: evidenceModelListSchema,
  })
  .passthrough();

export function extractSpecialtyStructure(
  params: StructureExtractionParams,
): StructureExtractionResult {
  const createdAt = params.created_at ?? new Date().toISOString();
  const evidence: EvidenceModel[] = [];

  const addEvidence = (fact: ExtractedFact): string => {
    const evidenceRecord: EvidenceModel = {
      evidence_id: randomUUID(),
      case_id: params.case_id,
      source_type: fact.input.input.input_type,
      source_ref: fact.input.input.input_id,
      field: fact.field,
      value: fact.value,
      quote: normalizeQuote(fact.quote),
      confidence: fact.confidence,
      extracted_by: "rule",
      created_at: createdAt,
    };

    evidence.push(evidenceRecord);
    return evidenceRecord.evidence_id;
  };

  const cancerSiteFact = findCancerSite(params.inputs);
  const cancerSite = cancerSiteFact?.value ?? "unknown";
  const cancerSiteEvidenceIds = cancerSiteFact
    ? [addEvidence({ ...cancerSiteFact, field: "cancer_site" })]
    : [];

  const pathology = extractPathology(params.inputs, addEvidence);
  const ct = extractCt(params.inputs, addEvidence);
  const biomarkers = extractBiomarkers(params.inputs, addEvidence);
  const labs = extractLabs(params.inputs, addEvidence);
  const toleranceFactors = buildToleranceFactors(labs);
  const evidenceIds = unique([
    ...cancerSiteEvidenceIds,
    ...pathology.evidence_ids,
    ...ct.evidence_ids,
    ...labs.evidence_ids,
    ...evidence.map((item) => item.evidence_id),
  ]);

  const structure = specialtyStructureSchema.parse({
    structure_id: randomUUID(),
    case_id: params.case_id,
    version: params.version,
    cancer_site: cancerSite,
    pathology,
    ct,
    biomarkers,
    labs,
    tolerance_factors: toleranceFactors,
    evidence_ids: evidenceIds,
    created_at: createdAt,
  });

  return { structure, evidence };
}

export function applyClinicianCorrections(
  params: ClinicianCorrectionParams,
): StructureExtractionResult {
  const createdAt = params.created_at ?? new Date().toISOString();
  const evidence: EvidenceModel[] = [];
  const changedEvidenceBySection = {
    pathology: [] as string[],
    ct: [] as string[],
    labs: [] as string[],
  };

  const base = params.base_structure;
  const corrected = specialtyStructureSchema.parse({
    ...base,
    structure_id: randomUUID(),
    version: params.version,
    cancer_site: params.corrections.cancer_site ?? base.cancer_site,
    pathology: {
      ...base.pathology,
      ...definedProperties({
        status: params.corrections.pathology?.status,
        pathology_type: optionalTextCorrection(
          params.corrections.pathology?.pathology_type,
          base.pathology.pathology_type,
        ),
        differentiation: optionalTextCorrection(
          params.corrections.pathology?.differentiation,
          base.pathology.differentiation,
        ),
      }),
      evidence_ids: [...base.pathology.evidence_ids],
    },
    ct: {
      ...base.ct,
      ...definedProperties({
        primary_site: optionalTextCorrection(
          params.corrections.ct?.primary_site,
          base.ct.primary_site,
        ),
        invasion_clues: params.corrections.ct?.invasion_clues,
        lymph_node_clues: params.corrections.ct?.lymph_node_clues,
        distant_metastasis_clues:
          params.corrections.ct?.distant_metastasis_clues,
      }),
      evidence_ids: [...base.ct.evidence_ids],
    },
    biomarkers: params.corrections.biomarkers ?? base.biomarkers,
    labs: {
      ...base.labs,
      ...definedProperties({
        ecog:
          params.corrections.labs?.ecog === null
            ? undefined
            : params.corrections.labs?.ecog,
        blood_routine_available:
          params.corrections.labs?.blood_routine_available,
        liver_function_available:
          params.corrections.labs?.liver_function_available,
        kidney_function_available:
          params.corrections.labs?.kidney_function_available,
        albumin_available: params.corrections.labs?.albumin_available,
        abnormal_clues: params.corrections.labs?.abnormal_clues,
      }),
      evidence_ids: [...base.labs.evidence_ids],
    },
    tolerance_factors:
      params.corrections.tolerance_factors ?? base.tolerance_factors,
    evidence_ids: [...base.evidence_ids],
    created_at: createdAt,
  });

  const addClinicianEvidence = (
    field: string,
    value: JsonValue,
    section?: keyof typeof changedEvidenceBySection,
  ) => {
    const evidenceRecord: EvidenceModel = {
      evidence_id: randomUUID(),
      case_id: params.case_id,
      source_type: "clinician_correction",
      source_ref: base.structure_id,
      field,
      value,
      quote: `医生修正 ${field}: ${formatCorrectionValue(value)}`,
      confidence: 1,
      extracted_by: "clinician",
      created_at: createdAt,
    };

    evidence.push(evidenceRecord);
    corrected.evidence_ids.push(evidenceRecord.evidence_id);
    if (section) {
      changedEvidenceBySection[section].push(evidenceRecord.evidence_id);
    }
  };

  recordChangedField(
    "cancer_site",
    base.cancer_site,
    corrected.cancer_site,
    addClinicianEvidence,
  );
  recordChangedField(
    "pathology.status",
    base.pathology.status,
    corrected.pathology.status,
    addClinicianEvidence,
    "pathology",
  );
  recordChangedField(
    "pathology.pathology_type",
    base.pathology.pathology_type ?? null,
    corrected.pathology.pathology_type ?? null,
    addClinicianEvidence,
    "pathology",
  );
  recordChangedField(
    "pathology.differentiation",
    base.pathology.differentiation ?? null,
    corrected.pathology.differentiation ?? null,
    addClinicianEvidence,
    "pathology",
  );
  recordChangedField(
    "ct.primary_site",
    base.ct.primary_site ?? null,
    corrected.ct.primary_site ?? null,
    addClinicianEvidence,
    "ct",
  );
  recordChangedField(
    "ct.invasion_clues",
    base.ct.invasion_clues,
    corrected.ct.invasion_clues,
    addClinicianEvidence,
    "ct",
  );
  recordChangedField(
    "ct.lymph_node_clues",
    base.ct.lymph_node_clues,
    corrected.ct.lymph_node_clues,
    addClinicianEvidence,
    "ct",
  );
  recordChangedField(
    "ct.distant_metastasis_clues",
    base.ct.distant_metastasis_clues,
    corrected.ct.distant_metastasis_clues,
    addClinicianEvidence,
    "ct",
  );
  recordChangedField(
    "biomarkers",
    base.biomarkers,
    corrected.biomarkers,
    addClinicianEvidence,
  );
  recordChangedField(
    "labs.ecog",
    base.labs.ecog ?? null,
    corrected.labs.ecog ?? null,
    addClinicianEvidence,
    "labs",
  );
  recordChangedField(
    "labs.blood_routine_available",
    base.labs.blood_routine_available,
    corrected.labs.blood_routine_available,
    addClinicianEvidence,
    "labs",
  );
  recordChangedField(
    "labs.liver_function_available",
    base.labs.liver_function_available,
    corrected.labs.liver_function_available,
    addClinicianEvidence,
    "labs",
  );
  recordChangedField(
    "labs.kidney_function_available",
    base.labs.kidney_function_available,
    corrected.labs.kidney_function_available,
    addClinicianEvidence,
    "labs",
  );
  recordChangedField(
    "labs.albumin_available",
    base.labs.albumin_available,
    corrected.labs.albumin_available,
    addClinicianEvidence,
    "labs",
  );
  recordChangedField(
    "labs.abnormal_clues",
    base.labs.abnormal_clues,
    corrected.labs.abnormal_clues,
    addClinicianEvidence,
    "labs",
  );
  recordChangedField(
    "tolerance_factors",
    base.tolerance_factors,
    corrected.tolerance_factors,
    addClinicianEvidence,
  );

  corrected.pathology.evidence_ids.push(...changedEvidenceBySection.pathology);
  corrected.ct.evidence_ids.push(...changedEvidenceBySection.ct);
  corrected.labs.evidence_ids.push(...changedEvidenceBySection.labs);
  corrected.evidence_ids = unique(corrected.evidence_ids);
  corrected.pathology.evidence_ids = unique(corrected.pathology.evidence_ids);
  corrected.ct.evidence_ids = unique(corrected.ct.evidence_ids);
  corrected.labs.evidence_ids = unique(corrected.labs.evidence_ids);

  return {
    structure: specialtyStructureSchema.parse(corrected),
    evidence,
  };
}

export function collectStructureEvidenceFromAuditEvents(
  events: AuditEvent[],
): EvidenceModel[] {
  return events.flatMap((event) => {
    const result = structureEvidenceAuditPayloadSchema.safeParse(event.payload);
    return result.success ? result.data.evidence : [];
  });
}

interface ExtractedFact {
  input: CaseInputText;
  field: string;
  value: JsonValue;
  quote: string;
  confidence: number;
}

function extractPathology(
  inputs: CaseInputText[],
  addEvidence: (fact: ExtractedFact) => string,
) {
  const pathologyInput = firstInputOfType(inputs, "pathology_biomarker");
  const allInput = pathologyInput ?? firstInputWithMatch(inputs, /病理|活检|细胞学|癌/i);
  const evidenceIds: string[] = [];
  let status: PathologyStatus = "not_available";
  let pathologyType: string | undefined;
  let differentiation: string | undefined;

  if (allInput) {
    const confirmedQuote = findOptionalQuote(
      allInput.raw_text,
      /病理|活检|细胞学|鳞状细胞癌|非角化性癌|腺癌|未分化癌|carcinoma/i,
    );
    const suspiciousQuote = findOptionalQuote(
      allInput.raw_text,
      /疑似|可疑|考虑|倾向/i,
    );

    if (confirmedQuote && !suspiciousQuote) {
      status = "confirmed";
      evidenceIds.push(
        addEvidence({
          input: allInput,
          field: "pathology.status",
          value: status,
          quote: confirmedQuote,
          confidence: 0.86,
        }),
      );
    } else if (confirmedQuote || suspiciousQuote) {
      status = "suspicious";
      const statusQuote = suspiciousQuote ?? confirmedQuote ?? allInput.raw_text;
      evidenceIds.push(
        addEvidence({
          input: allInput,
          field: "pathology.status",
          value: status,
          quote: statusQuote,
          confidence: 0.68,
        }),
      );
    }

    const typeQuote = findOptionalQuote(
      allInput.raw_text,
      /鳞状细胞癌|鳞癌|非角化性癌|腺癌|未分化癌|低分化癌|中分化癌|高分化癌/i,
    );
    if (typeQuote) {
      pathologyType = normalizePathologyType(typeQuote);
      evidenceIds.push(
        addEvidence({
          input: allInput,
          field: "pathology.pathology_type",
          value: pathologyType,
          quote: typeQuote,
          confidence: 0.82,
        }),
      );
    }

    const differentiationQuote = findOptionalQuote(
      allInput.raw_text,
      /高分化|中分化|低分化|未分化/i,
    );
    if (differentiationQuote) {
      differentiation = normalizeDifferentiation(differentiationQuote);
      evidenceIds.push(
        addEvidence({
          input: allInput,
          field: "pathology.differentiation",
          value: differentiation,
          quote: differentiationQuote,
          confidence: 0.8,
        }),
      );
    }
  }

  return {
    status,
    ...(pathologyType ? { pathology_type: pathologyType } : {}),
    ...(differentiation ? { differentiation } : {}),
    evidence_ids: unique(evidenceIds),
  };
}

function extractCt(
  inputs: CaseInputText[],
  addEvidence: (fact: ExtractedFact) => string,
): CtSummary {
  const ctInput = firstInputOfType(inputs, "ct_report");
  const evidenceIds: string[] = [];
  const invasionClues: string[] = [];
  const lymphNodeClues: string[] = [];
  const distantMetastasisClues: string[] = [];

  if (!ctInput) {
    return {
      invasion_clues: [],
      lymph_node_clues: [],
      distant_metastasis_clues: [],
      evidence_ids: [],
    };
  }

  const primarySiteQuote = findOptionalQuote(
    ctInput.raw_text,
    /鼻咽|口咽|扁桃体|舌根|下咽|梨状窝|喉|声门|声带/i,
  );
  const primarySite = primarySiteQuote
    ? normalizeQuote(primarySiteQuote, 40)
    : undefined;

  if (primarySite) {
    evidenceIds.push(
      addEvidence({
        input: ctInput,
        field: "ct.primary_site",
        value: primarySite,
          quote: primarySiteQuote ?? primarySite,
        confidence: 0.7,
      }),
    );
  }

  for (const quote of findQuotes(
    ctInput.raw_text,
    /侵犯|累及|外侵|破坏|包绕|狭窄|闭塞|固定/i,
  )) {
    invasionClues.push(normalizeQuote(quote, 80));
    evidenceIds.push(
      addEvidence({
        input: ctInput,
        field: "ct.invasion_clues",
        value: normalizeQuote(quote, 80),
        quote,
        confidence: 0.76,
      }),
    );
  }

  for (const quote of findQuotes(ctInput.raw_text, /淋巴结|颈部|LN|转移淋巴/i)) {
    lymphNodeClues.push(normalizeQuote(quote, 80));
    evidenceIds.push(
      addEvidence({
        input: ctInput,
        field: "ct.lymph_node_clues",
        value: normalizeQuote(quote, 80),
        quote,
        confidence: 0.74,
      }),
    );
  }

  for (const quote of findQuotes(
    ctInput.raw_text,
    /远处转移|肺转移|肝转移|骨转移|M1/i,
  )) {
    distantMetastasisClues.push(normalizeQuote(quote, 80));
    evidenceIds.push(
      addEvidence({
        input: ctInput,
        field: "ct.distant_metastasis_clues",
        value: normalizeQuote(quote, 80),
        quote,
        confidence: 0.74,
      }),
    );
  }

  return {
    ...(primarySite ? { primary_site: primarySite } : {}),
    invasion_clues: unique(invasionClues),
    lymph_node_clues: unique(lymphNodeClues),
    distant_metastasis_clues: unique(distantMetastasisClues),
    evidence_ids: unique(evidenceIds),
  };
}

function extractBiomarkers(
  inputs: CaseInputText[],
  addEvidence: (fact: ExtractedFact) => string,
): Record<string, string> {
  const biomarkers: Record<string, string> = {};
  const input = firstInputOfType(inputs, "pathology_biomarker");

  if (!input) {
    return biomarkers;
  }

  const markerPatterns: Array<[string, RegExp]> = [
    ["EBV_DNA", /EBV\s*DNA|EBV-DNA|EB病毒DNA/i],
    ["PD-L1", /PD-?L1|CPS|TPS/i],
    ["HPV", /HPV/i],
    ["p16", /p16/i],
    ["Ki-67", /Ki-?67/i],
  ];

  for (const [field, pattern] of markerPatterns) {
    const quote = findOptionalQuote(input.raw_text, pattern);
    if (!quote) {
      continue;
    }

    const value = normalizeQuote(quote, 80);
    biomarkers[field] = value;
    addEvidence({
      input,
      field: `biomarkers.${field}`,
      value,
      quote,
      confidence: 0.78,
    });
  }

  return biomarkers;
}

function extractLabs(
  inputs: CaseInputText[],
  addEvidence: (fact: ExtractedFact) => string,
): LabSummary {
  const labInput = firstInputOfType(inputs, "lab_report");
  const clinicalInput = firstInputOfType(inputs, "clinician_note");
  const evidenceIds: string[] = [];
  let ecog: number | undefined;

  const ecogInput = [labInput, clinicalInput].find(
    (input) => input && /ECOG\s*[:：]?\s*[0-5]/i.test(input.raw_text),
  );
  if (ecogInput) {
    const ecogMatch = ecogInput.raw_text.match(/ECOG\s*[:：]?\s*([0-5])/i);
    if (ecogMatch?.[1]) {
      ecog = Number(ecogMatch[1]);
      evidenceIds.push(
        addEvidence({
          input: ecogInput,
          field: "labs.ecog",
          value: ecog,
          quote: findQuote(ecogInput.raw_text, /ECOG\s*[:：]?\s*[0-5]/i),
          confidence: 0.88,
        }),
      );
    }
  }

  if (!labInput) {
    return {
      ...(ecog === undefined ? {} : { ecog }),
      blood_routine_available: false,
      liver_function_available: false,
      kidney_function_available: false,
      albumin_available: false,
      abnormal_clues: [],
      evidence_ids: evidenceIds,
    };
  }

  const bloodRoutineAvailable = hasMatch(
    labInput.raw_text,
    /血常规|白细胞|中性粒|血红蛋白|血小板|WBC|HGB|PLT/i,
  );
  const liverFunctionAvailable = hasMatch(
    labInput.raw_text,
    /肝功能|ALT|AST|转氨酶|胆红素|TBIL/i,
  );
  const kidneyFunctionAvailable = hasMatch(
    labInput.raw_text,
    /肾功能|肌酐|尿素|尿素氮|Cr|CREA|BUN/i,
  );
  const albuminAvailable = hasMatch(labInput.raw_text, /白蛋白|ALB|albumin/i);

  const availabilityFacts: Array<[string, boolean, RegExp]> = [
    [
      "labs.blood_routine_available",
      bloodRoutineAvailable,
      /血常规|白细胞|中性粒|血红蛋白|血小板|WBC|HGB|PLT/i,
    ],
    [
      "labs.liver_function_available",
      liverFunctionAvailable,
      /肝功能|ALT|AST|转氨酶|胆红素|TBIL/i,
    ],
    [
      "labs.kidney_function_available",
      kidneyFunctionAvailable,
      /肾功能|肌酐|尿素|尿素氮|Cr|CREA|BUN/i,
    ],
    ["labs.albumin_available", albuminAvailable, /白蛋白|ALB|albumin/i],
  ];

  for (const [field, available, pattern] of availabilityFacts) {
    if (!available) {
      continue;
    }

    evidenceIds.push(
      addEvidence({
        input: labInput,
        field,
        value: true,
        quote: findQuote(labInput.raw_text, pattern),
        confidence: 0.78,
      }),
    );
  }

  const abnormalClues = unique(
    findQuotes(
      labInput.raw_text,
      /异常|降低|升高|贫血|感染|白细胞.*高|中性粒.*高|血红蛋白.*低|血小板.*低|肌酐.*高|转氨酶.*高|白蛋白.*低/i,
    ).map((quote) => normalizeQuote(quote, 80)),
  );

  for (const clue of abnormalClues) {
    evidenceIds.push(
      addEvidence({
        input: labInput,
        field: "labs.abnormal_clues",
        value: clue,
        quote: clue,
        confidence: 0.7,
      }),
    );
  }

  return {
    ...(ecog === undefined ? {} : { ecog }),
    blood_routine_available: bloodRoutineAvailable,
    liver_function_available: liverFunctionAvailable,
    kidney_function_available: kidneyFunctionAvailable,
    albumin_available: albuminAvailable,
    abnormal_clues: abnormalClues,
    evidence_ids: unique(evidenceIds),
  };
}

function buildToleranceFactors(labs: LabSummary): ToleranceFactorSummary[] {
  const missingInformation = [
    ...(labs.ecog === undefined ? ["ECOG"] : []),
    ...(labs.blood_routine_available ? [] : ["血常规"]),
    ...(labs.liver_function_available ? [] : ["肝功能"]),
    ...(labs.kidney_function_available ? [] : ["肾功能"]),
    ...(labs.albumin_available ? [] : ["白蛋白"]),
  ];
  const provisionalLevel =
    missingInformation.length >= 3
      ? "unknown"
      : missingInformation.length > 0 || labs.abnormal_clues.length > 0
        ? "caution"
        : "good";
  const riskFactors = [
    ...(labs.ecog !== undefined && labs.ecog >= 2 ? [`ECOG ${labs.ecog}`] : []),
    ...labs.abnormal_clues,
  ];

  return [
    "radiotherapy",
    "chemotherapy",
    "immunotherapy",
    "surgery_anesthesia",
  ].map((modality) => ({
    modality,
    provisional_level: provisionalLevel,
    risk_factors: unique(riskFactors),
    missing_information: missingInformation,
  })) as ToleranceFactorSummary[];
}

function findCancerSite(inputs: CaseInputText[]) {
  const patterns: Array<[CancerSite, RegExp]> = [
    ["nasopharynx", /鼻咽/i],
    ["oropharynx", /口咽|扁桃体|舌根/i],
    ["hypopharynx", /下咽|梨状窝/i],
    ["larynx", /喉癌|喉部|喉腔|声门|声带/i],
  ];

  for (const [site, pattern] of patterns) {
    const input = firstInputWithMatch(inputs, pattern);
    if (input) {
      return {
        input,
        value: site,
        quote: findQuote(input.raw_text, pattern),
        confidence: 0.72,
      };
    }
  }

  return null;
}

function firstInputOfType(
  inputs: CaseInputText[],
  inputType: CaseInput["input_type"],
): CaseInputText | undefined {
  return inputs.find(
    (input) =>
      input.input.input_type === inputType && input.raw_text.trim().length > 0,
  );
}

function firstInputWithMatch(
  inputs: CaseInputText[],
  pattern: RegExp,
): CaseInputText | undefined {
  return inputs.find((input) => pattern.test(input.raw_text));
}

function findQuote(text: string, pattern: RegExp): string {
  return (
    splitText(text).find((part) => pattern.test(part)) ??
    text.match(pattern)?.[0] ??
    text.trim().slice(0, 80)
  );
}

function findOptionalQuote(text: string, pattern: RegExp): string | undefined {
  return splitText(text).find((part) => pattern.test(part)) ?? text.match(pattern)?.[0];
}

function findQuotes(text: string, pattern: RegExp): string[] {
  return unique(splitText(text).filter((part) => pattern.test(part))).slice(0, 8);
}

function splitText(text: string): string[] {
  return text
    .split(/[\r\n。；;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasMatch(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function normalizeQuote(value: string | undefined, maxLength = 160): string {
  const quote = (value ?? "").replace(/\s+/g, " ").trim();
  if (!quote) {
    return "未提供原文片段";
  }

  return quote.length > maxLength ? `${quote.slice(0, maxLength)}...` : quote;
}

function normalizePathologyType(quote: string): string {
  if (/鳞状细胞癌|鳞癌/i.test(quote)) {
    return "鳞状细胞癌";
  }

  if (/非角化性癌/i.test(quote)) {
    return "非角化性癌";
  }

  if (/腺癌/i.test(quote)) {
    return "腺癌";
  }

  if (/未分化癌/i.test(quote)) {
    return "未分化癌";
  }

  return normalizeQuote(quote, 40);
}

function normalizeDifferentiation(quote: string): string {
  if (/高分化/.test(quote)) {
    return "高分化";
  }

  if (/中分化/.test(quote)) {
    return "中分化";
  }

  if (/低分化/.test(quote)) {
    return "低分化";
  }

  if (/未分化/.test(quote)) {
    return "未分化";
  }

  return normalizeQuote(quote, 40);
}

function optionalTextCorrection(
  correction: string | null | undefined,
  fallback: string | undefined,
): string | undefined {
  if (correction === null) {
    return undefined;
  }

  if (correction === undefined) {
    return fallback;
  }

  const trimmed = correction.trim();
  return trimmed ? trimmed : undefined;
}

function recordChangedField(
  field: string,
  before: unknown,
  after: unknown,
  addEvidence: (
    field: string,
    value: JsonValue,
    section?: "pathology" | "ct" | "labs",
  ) => void,
  section?: "pathology" | "ct" | "labs",
) {
  if (!jsonEqual(before, after)) {
    addEvidence(field, jsonValueSchema.parse(after), section);
  }
}

function definedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatCorrectionValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
