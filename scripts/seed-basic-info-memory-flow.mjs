import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const CASE_ID = "mock-basic-info-memory-flow";
const DISPLAY_NAME = "Mock Basic Information Validation Case";
const PATIENT_REF = "MOCK-BASIC-INFO-001";
const dbPath = join(process.cwd(), "data", "medical-diagnosis-agent.sqlite");
const rawCaseDir = join(process.cwd(), "data", "raw-inputs", CASE_ID);
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const baseTime = new Date("2026-07-14T09:00:00.000Z").getTime();
const iso = (offsetMinutes) => new Date(baseTime + offsetMinutes * 60_000).toISOString();

const initialInputs = [
  {
    input_type: "demographics",
    raw_text:
      "58-year-old male; height 172 cm; weight 64 kg; BMI 21.6; smoking history 40 pack-years; ECOG 1; no obvious malnutrition.",
    version: 1,
  },
  {
    input_type: "clinician_note",
    raw_text:
      "Persistent hoarseness for 3 months, worsened over the last 2 weeks with foreign-body sensation on swallowing. Indirect laryngoscopy shows a right vocal cord neoplasm involving the anterior commissure, with slightly limited vocal cord mobility.",
    version: 1,
  },
  {
    input_type: "ct_report",
    raw_text:
      "Enhanced CT shows a right glottic lesion involving the anterior commissure, without thyroid cartilage invasion. Ipsilateral level II lymph node short axis is 0.9 cm. No distant metastasis reported.",
    version: 1,
  },
  {
    input_type: "pathology_biomarker",
    raw_text:
      "Right vocal cord biopsy: moderately differentiated squamous cell carcinoma. p16 negative; PD-L1 CPS 8.",
    version: 1,
  },
  {
    input_type: "lab_report",
    raw_text:
      "CBC, liver function, renal function, and albumin are within treatment-tolerable range. Albumin 41 g/L, creatinine 78 umol/L, eGFR 95 mL/min.",
    version: 1,
  },
];

const conversationTurns = [
  {
    clinician:
      "Weight decreased by about 4 kg over 3 months, less than 5 percent; ECOG remains 1 and nutrition is acceptable.",
    agent:
      "Noted. Weight loss is mild and does not by itself suggest poor tolerance, but nutrition should continue to be monitored during chemoradiotherapy.",
  },
  {
    clinician:
      "Baseline pure-tone hearing screen is normal and there is no obvious renal function risk.",
    agent:
      "This supports cisplatin eligibility from renal and hearing perspectives, assuming hydration and monitoring are feasible.",
  },
  {
    clinician:
      "Dental and oral evaluation has been completed; there is no active oral infection.",
    agent:
      "Oral preparation is complete, which lowers avoidable radiotherapy interruption risk.",
  },
  {
    clinician:
      "Smoking history is 40 pack-years and the patient has started smoking cessation counseling.",
    agent:
      "Smoking history should remain in the baseline profile and cessation support should continue during treatment.",
  },
  {
    clinician:
      "Final working stage is cT2N1M0 glottic squamous cell carcinoma, planned for definitive concurrent chemoradiotherapy discussion.",
    agent:
      "The current evidence supports discussion of definitive concurrent chemoradiotherapy, with pathology, stage, renal function, hearing, nutrition, and oral status documented.",
  },
];

const memorySnapshot = {
  categories: [
    {
      id: "profile",
      label: "Basic Information",
      summary:
        "Patient clinical profile variables relevant to treatment tolerance and baseline risk.",
      items: [
        "58-year-old male; height 172 cm; weight 64 kg; BMI 21.6; smoking history 40 pack-years; ECOG 1; no obvious malnutrition.",
        "Weight decreased by about 4 kg over 3 months, less than 5 percent; baseline nutrition remains acceptable.",
      ],
    },
    {
      id: "history",
      label: "Illness History and Current Course",
      summary:
        "Symptom course and laryngoscopy findings support suspected glottic cancer requiring definitive staging and treatment discussion.",
      items: [
        "Persistent hoarseness for 3 months, worsened over the last 2 weeks with swallowing foreign-body sensation.",
        "Indirect laryngoscopy shows a right vocal cord neoplasm involving the anterior commissure with slightly limited vocal cord mobility.",
      ],
    },
    {
      id: "ct",
      label: "CT Summary",
      summary:
        "Imaging supports local glottic lesion assessment and nodal staging.",
      items: [
        "Enhanced CT shows a right glottic lesion involving the anterior commissure without thyroid cartilage invasion.",
        "Ipsilateral level II lymph node short axis is 0.9 cm; no distant metastasis is reported.",
      ],
    },
    {
      id: "pathology",
      label: "Pathology and Molecular Biomarkers",
      summary:
        "Pathology confirms squamous cell carcinoma and biomarker status informs treatment discussion.",
      items: [
        "Right vocal cord biopsy shows moderately differentiated squamous cell carcinoma.",
        "p16 is negative; PD-L1 CPS is 8.",
      ],
    },
    {
      id: "labs",
      label: "Monitoring Markers and Baseline Labs",
      summary:
        "Baseline organ function appears compatible with treatment, pending routine monitoring.",
      items: [
        "Albumin is 41 g/L, creatinine is 78 umol/L, and eGFR is 95 mL/min.",
        "Baseline pure-tone hearing screen is normal and no obvious renal function risk is documented.",
      ],
    },
    {
      id: "treatment",
      label: "Treatment History, Tolerance, and Resistance",
      summary:
        "Pre-treatment preparation and eligibility factors support definitive concurrent chemoradiotherapy discussion.",
      items: [
        "Dental and oral evaluation is complete, with no active oral infection.",
        "Final working stage is cT2N1M0 glottic squamous cell carcinoma, planned for definitive concurrent chemoradiotherapy discussion.",
      ],
    },
  ],
  generatedAt: iso(30),
  inputCount: initialInputs.length + conversationTurns.length,
};

function safeSeg(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function saveRawText(inputId, text) {
  const dir = rawCaseDir;
  const abs = join(dir, `${safeSeg(inputId)}.txt`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, text, { encoding: "utf8" });
  const rel = relative(process.cwd(), abs);

  return {
    raw_text_hash: createHash("sha256").update(text, "utf8").digest("hex"),
    raw_text_path: rel.split(sep).join("/"),
  };
}

function fingerprintFromInputs(inputs) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        candidates: inputs
          .map((input) => ({
            categoryHint: input.input_type,
            id: `input:${input.input_id}`,
            source: "case_input",
            text: input.raw_text,
          }))
          .sort((left, right) =>
            [left.source, left.id, left.categoryHint, left.text]
              .join("\u0000")
              .localeCompare(
                [right.source, right.id, right.categoryHint, right.text].join("\u0000"),
              ),
          ),
      }),
    )
    .digest("hex");
}

function insertInput({
  caseId,
  inputType,
  rawText,
  submittedAt,
  version,
}) {
  const inputId = randomUUID();
  const stored = saveRawText(inputId, rawText);

  db.prepare(
    `INSERT INTO case_inputs (
      input_id,
      case_id,
      input_type,
      raw_text_path,
      raw_text_hash,
      version,
      submitted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    inputId,
    caseId,
    inputType,
    stored.raw_text_path,
    stored.raw_text_hash,
    version,
    submittedAt,
  );

  return {
    input_id: inputId,
    input_type: inputType,
    raw_text: rawText,
    submitted_at: submittedAt,
  };
}

function assertBasicInformationIsClinicalOnly(memory) {
  const profile = memory.categories.find((category) => category.id === "profile");

  if (!profile) {
    throw new Error("Expected Basic Information profile category.");
  }

  const serializedProfile = JSON.stringify(profile);
  const forbidden = [
    DISPLAY_NAME,
    PATIENT_REF,
    "Case name",
    "Patient reference",
    "Case status",
    "draft",
    CASE_ID,
  ];

  for (const value of forbidden) {
    if (serializedProfile.includes(value)) {
      throw new Error(`Basic Information contains system metadata: ${value}`);
    }
  }

  const requiredClinicalFacts = [
    "58-year-old male",
    "height 172 cm",
    "weight 64 kg",
    "smoking history 40 pack-years",
    "ECOG 1",
  ];

  for (const value of requiredClinicalFacts) {
    if (!serializedProfile.includes(value)) {
      throw new Error(`Basic Information is missing clinical variable: ${value}`);
    }
  }
}

const tx = db.transaction(() => {
  db.prepare("DELETE FROM cases WHERE case_id = ? OR display_name = ?").run(
    CASE_ID,
    DISPLAY_NAME,
  );
  rmSync(rawCaseDir, { recursive: true, force: true });

  db.prepare(
    `INSERT INTO cases (
      case_id,
      display_name,
      patient_ref,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).run(CASE_ID, DISPLAY_NAME, PATIENT_REF, iso(0), iso(30));

  const savedInputs = [];

  initialInputs.forEach((input, index) => {
    savedInputs.push(
      insertInput({
        caseId: CASE_ID,
        inputType: input.input_type,
        rawText: input.raw_text,
        submittedAt: iso(index + 1),
        version: input.version,
      }),
    );
  });

  conversationTurns.forEach((turn, index) => {
    const submittedAt = iso(10 + index * 2);
    const input = insertInput({
      caseId: CASE_ID,
      inputType: "clinician_note",
      rawText: turn.clinician,
      submittedAt,
      version: index + 2,
    });
    savedInputs.push(input);

    db.prepare(
      `INSERT INTO case_conversation_messages (
        message_id,
        case_id,
        role,
        content,
        case_input_id,
        created_at
      )
      VALUES (?, ?, 'clinician', ?, ?, ?)`,
    ).run(randomUUID(), CASE_ID, turn.clinician, input.input_id, submittedAt);

    db.prepare(
      `INSERT INTO pending_rough_memory_items (
        rough_item_id,
        case_id,
        source_case_input_id,
        bucket,
        content,
        status,
        created_at,
        compacted_at
      )
      VALUES (?, ?, ?, ?, ?, 'compacted', ?, ?)`,
    ).run(
      randomUUID(),
      CASE_ID,
      input.input_id,
      index === 3 ? "profile" : index === 4 ? "treatment" : "history",
      turn.clinician,
      submittedAt,
      iso(30),
    );

    db.prepare(
      `INSERT INTO case_conversation_messages (
        message_id,
        case_id,
        role,
        content,
        case_input_id,
        created_at
      )
      VALUES (?, ?, 'agent', ?, NULL, ?)`,
    ).run(randomUUID(), CASE_ID, turn.agent, iso(11 + index * 2));
  });

  assertBasicInformationIsClinicalOnly(memorySnapshot);

  db.prepare(
    `INSERT INTO patient_memory_snapshots (
      snapshot_id,
      case_id,
      mode,
      memory_json,
      input_count,
      source_fingerprint,
      generated_at,
      is_stale,
      created_at
    )
    VALUES (?, ?, 'deterministic', ?, ?, ?, ?, 0, ?)`,
  ).run(
    randomUUID(),
    CASE_ID,
    JSON.stringify(memorySnapshot),
    memorySnapshot.inputCount,
    fingerprintFromInputs(savedInputs),
    memorySnapshot.generatedAt,
    iso(30),
  );
});

tx();

const profile = memorySnapshot.categories.find((category) => category.id === "profile");
const messageCount = db
  .prepare("SELECT COUNT(*) AS count FROM case_conversation_messages WHERE case_id = ?")
  .get(CASE_ID).count;
const compactedCount = db
  .prepare(
    "SELECT COUNT(*) AS count FROM pending_rough_memory_items WHERE case_id = ? AND status = 'compacted'",
  )
  .get(CASE_ID).count;

console.log(JSON.stringify(
  {
    basicInformationItems: profile.items,
    caseId: CASE_ID,
    compactedRoughMemoryItems: compactedCount,
    conversationMessages: messageCount,
    displayName: DISPLAY_NAME,
    patientReference: PATIENT_REF,
    verification:
      "Basic Information contains clinical variables only; case name/reference/status remain system metadata.",
  },
  null,
  2,
));

db.close();
