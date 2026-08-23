import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const CASE_ID = "87061fbb-a99f-4374-9440-3ef143e796d2";
const dbPath = join(process.cwd(), "data", "medical-diagnosis-agent.sqlite");
const db = new Database(dbPath);
db.pragma("foreign_keys = ON");

const caseRow = db.prepare("SELECT case_id FROM cases WHERE case_id = ?").get(CASE_ID);
if (!caseRow) {
  console.error("Case not found:", CASE_ID);
  process.exit(1);
}

// Clean any previously seeded runs for an idempotent re-seed.
db.prepare("DELETE FROM assessment_runs WHERE case_id = ?").run(CASE_ID);

const runId = randomUUID();
const baseTime = new Date("2026-07-12T16:22:00.000Z").getTime();
const iso = (offsetMinutes) => new Date(baseTime + offsetMinutes * 60_000).toISOString();

db.prepare(
  `INSERT INTO assessment_runs (run_id, case_id, status, structure_id, created_at, updated_at)
   VALUES (?, ?, 'paused_for_clinician_input', NULL, ?, ?)`,
).run(runId, CASE_ID, iso(0), iso(20));

const rounds = [
  {
    reason:
      "已读取首版资料，为完成放化疗敏感性与耐受性评估，仍缺少分期与器官功能关键项，请补充以下信息。",
    createdOffset: 1,
    questions: [
      {
        id: "q1",
        priority: "high",
        question: "请确认临床 TNM 分期，特别是声带活动度对应的 T 分期与颈部淋巴结 N 分期。",
        expected_answer_type: "free_text",
        clinical_purpose: "分期直接决定是否适合根治性同步放化疗及敏感性预期。",
        blocks_conclusion: true,
      },
      {
        id: "q2",
        priority: "high",
        question: "患者的 ECOG 体能状态评分及近 3 个月体重变化如何？",
        expected_answer_type: "free_text",
        clinical_purpose: "体能状态与营养储备是含铂同步化疗耐受性的关键前提。",
        blocks_conclusion: true,
      },
    ],
    answers: [
      {
        questionId: "q1",
        answerText:
          "临床分期 cT2N1M0：右声带肿物累及前联合、声带活动稍受限判为 T2；双颈 II-III 区淋巴结最大短径 0.9cm、单侧判为 N1；无远处转移 M0。",
        createdOffset: 8,
      },
      {
        questionId: "q2",
        answerText:
          "ECOG 1 分，日常活动不受限；近 3 个月体重下降约 4kg（<5%），无明显营养不良，白蛋白 41 g/L。",
        createdOffset: 9,
      },
    ],
  },
  {
    reason:
      "分期与体能状态已明确。为核对含铂方案的器官功能安全性，还需确认以下两项。",
    createdOffset: 12,
    questions: [
      {
        id: "q3",
        priority: "high",
        question: "近期肌酐清除率/eGFR 及听力基线是否支持顺铂方案？如不支持，是否考虑卡铂替代？",
        expected_answer_type: "free_text",
        clinical_purpose: "顺铂具有肾毒性与耳毒性，需确认器官功能以确定给药方案。",
        blocks_conclusion: true,
      },
      {
        id: "q4",
        priority: "medium",
        question: "是否已完成口腔/牙科评估及戒烟干预，有无活动性感染？",
        expected_answer_type: "free_text",
        clinical_purpose: "放疗前口腔处理与戒烟影响黏膜炎风险与整体耐受性。",
        blocks_conclusion: false,
      },
    ],
    answers: [
      {
        questionId: "q3",
        answerText:
          "eGFR 95 mL/min、肌酐 78 μmol/L，肾功能良好；纯音听阈筛查正常。支持标准顺铂同步方案，暂无需卡铂替代。",
        createdOffset: 18,
      },
      {
        questionId: "q4",
        answerText:
          "已完成口腔评估，无活动性感染、无需拔牙；已开始戒烟干预。",
        createdOffset: 19,
      },
    ],
  },
];

const insertReq = db.prepare(
  `INSERT INTO clarification_requests (request_id, case_id, run_id, reason, questions_json, created_at)
   VALUES (@request_id, @case_id, @run_id, @reason, @questions_json, @created_at)`,
);
const insertResp = db.prepare(
  `INSERT INTO clarification_responses (response_id, request_id, question_id, answer_text, marked_unknown, supplemental_input_id, submitted_at)
   VALUES (@response_id, @request_id, @question_id, @answer_text, 0, NULL, @submitted_at)`,
);

const tx = db.transaction(() => {
  for (const round of rounds) {
    const requestId = randomUUID();
    insertReq.run({
      request_id: requestId,
      case_id: CASE_ID,
      run_id: runId,
      reason: round.reason,
      questions_json: JSON.stringify(round.questions),
      created_at: iso(round.createdOffset),
    });
    for (const answer of round.answers) {
      insertResp.run({
        response_id: randomUUID(),
        request_id: requestId,
        question_id: answer.questionId,
        answer_text: answer.answerText,
        submitted_at: iso(answer.createdOffset),
      });
    }
  }
});

tx();

db.prepare("UPDATE cases SET updated_at = ? WHERE case_id = ?").run(iso(20), CASE_ID);

console.log("Seeded run", runId, "with", rounds.length, "agent rounds.");
db.close();
