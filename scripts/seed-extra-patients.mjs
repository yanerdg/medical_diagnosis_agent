import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const dbPath = join(process.cwd(), "data", "medical-diagnosis-agent.sqlite");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const patients = [
  {
    displayName: "喉癌复诊病例 012 · 王建国",
    patientRef: "OPD-2026-0710-012",
    status: "draft",
    baseTime: "2026-07-11T09:30:00.000Z",
    inputs: [
      {
        input_type: "clinician_note",
        raw_text:
          "男，63岁，声门上型喉癌放化疗后 6 个月复诊。诉近 2 周吞咽疼痛加重，进食受限。查体：会厌区黏膜充血、局部溃疡，未见明确新生物。拟评估复发风险与再程治疗耐受性。",
      },
      {
        input_type: "ct_report",
        raw_text:
          "喉部增强CT：会厌及杓会厌襞黏膜增厚，符合放疗后改变；未见明确肿块复发征象。双颈未见明显肿大淋巴结。",
      },
      {
        input_type: "lab_report",
        raw_text:
          "血常规：WBC 3.8×10^9/L，Hb 112 g/L，PLT 156×10^9/L。白蛋白 35 g/L，提示轻度营养不良。",
      },
    ],
  },
  {
    displayName: "下咽癌初诊病例 008 · 张丽华",
    patientRef: "OPD-2026-0712-008",
    status: "draft",
    baseTime: "2026-07-12T11:15:00.000Z",
    inputs: [
      {
        input_type: "clinician_note",
        raw_text:
          "女，55岁，无吸烟史。主诉咽部异物感伴右颈部包块 2 个月。查体：右梨状窝新生物，右颈III区可触及 3cm 质硬淋巴结。拟评估同步放化疗方案。",
      },
      {
        input_type: "pathology_biomarker",
        raw_text:
          "梨状窝活检：低分化鳞状细胞癌。免疫组化：p16(-)，Ki-67约60%。",
      },
      {
        input_type: "treatment_history",
        raw_text: "既往体健，无手术及放化疗史。否认药物过敏，无慢性肾病史。",
      },
    ],
  },
];

const dataDir = process.cwd();

function safeSeg(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function saveRawText(caseId, inputId, text) {
  const dir = join(dataDir, "data", "raw-inputs", safeSeg(caseId));
  const abs = join(dir, `${safeSeg(inputId)}.txt`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, text, { encoding: "utf8" });
  const rel = relative(dataDir, abs);
  return {
    raw_text_path: rel.split(sep).join("/"),
    raw_text_hash: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

const insertCase = db.prepare(
  `INSERT INTO cases (case_id, display_name, patient_ref, status, created_at, updated_at)
   VALUES (@case_id, @display_name, @patient_ref, @status, @created_at, @updated_at)`,
);
const insertInput = db.prepare(
  `INSERT INTO case_inputs (input_id, case_id, input_type, raw_text_path, raw_text_hash, version, submitted_at)
   VALUES (@input_id, @case_id, @input_type, @raw_text_path, @raw_text_hash, @version, @submitted_at)`,
);
const findCaseByName = db.prepare(
  "SELECT case_id FROM cases WHERE display_name = ?",
);

const tx = db.transaction(() => {
  for (const patient of patients) {
    if (findCaseByName.get(patient.displayName)) {
      console.log("Skip existing patient:", patient.displayName);
      continue;
    }

    const caseId = randomUUID();
    const base = new Date(patient.baseTime).getTime();
    const createdAt = new Date(base).toISOString();
    const updatedAt = new Date(base + patient.inputs.length * 60_000).toISOString();

    insertCase.run({
      case_id: caseId,
      display_name: patient.displayName,
      patient_ref: patient.patientRef,
      status: patient.status,
      created_at: createdAt,
      updated_at: updatedAt,
    });

    patient.inputs.forEach((input, index) => {
      const inputId = randomUUID();
      const stored = saveRawText(caseId, inputId, input.raw_text);
      insertInput.run({
        input_id: inputId,
        case_id: caseId,
        input_type: input.input_type,
        raw_text_path: stored.raw_text_path,
        raw_text_hash: stored.raw_text_hash,
        version: 1,
        submitted_at: new Date(base + index * 60_000).toISOString(),
      });
    });

    console.log("Seeded patient:", patient.displayName, `(${caseId})`);
  }
});

tx();
db.close();
