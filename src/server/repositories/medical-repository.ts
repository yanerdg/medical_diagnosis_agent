import { jsonValueSchema, type JsonValue } from "@/domain/evidence";
import {
  assessmentReportRecordSchema,
  assessmentRunSchema,
  caseInputSchema,
  caseSchema,
  clarificationRequestRecordSchema,
  clarificationResponseSchema,
  reviewSchema,
  specialtyStructureSchema,
  type AssessmentReportRecord,
  type AssessmentRun,
  type CaseInput,
  type CaseRecord,
  type ClarificationRequestRecord,
  type ClarificationResponse,
  type Review,
  type SpecialtyStructure,
} from "@/domain/schemas";
import { randomUUID } from "node:crypto";
import { getDatabase, type SqliteDatabase } from "../db";
import { RawInputStore } from "../storage/raw-input-store";
import type {
  AuditEvent,
  CaseConversationMessage,
  CreateAuditEventParams,
  CreateCaseConversationMessageParams,
  CreateCaseInputFromRawTextParams,
  CreatePendingRoughMemoryItemParams,
  CreateRunEventParams,
  PatientMemorySnapshot,
  PendingRoughMemoryItem,
  RunEvent,
  SavePatientMemorySnapshotParams,
} from "./types";

type CaseRow = Omit<CaseRecord, "patient_ref"> & {
  patient_ref: string | null;
};

type CaseInputRow = CaseInput;

interface SpecialtyStructureRow {
  structure_json: string;
}

type AssessmentRunRow = Omit<AssessmentRun, "structure_id"> & {
  structure_id: string | null;
};

interface ClarificationRequestRow {
  request_id: string;
  case_id: string;
  run_id: string;
  reason: string;
  questions_json: string;
  created_at: string;
}

type ClarificationResponseRow = Omit<
  ClarificationResponse,
  "answer_text" | "marked_unknown" | "supplemental_input_id"
> & {
  answer_text: string | null;
  marked_unknown: 0 | 1;
  supplemental_input_id: string | null;
};

type CaseConversationMessageRow = Omit<
  CaseConversationMessage,
  "case_input_id"
> & {
  case_input_id: string | null;
};

type PatientMemorySnapshotRow = Omit<
  PatientMemorySnapshot,
  "memory" | "is_stale"
> & {
  memory_json: string;
  is_stale: 0 | 1;
};

type PendingRoughMemoryItemRow = Omit<
  PendingRoughMemoryItem,
  "source_case_input_id" | "compacted_at"
> & {
  source_case_input_id: string | null;
  compacted_at: string | null;
};

type AssessmentReportRow = Omit<AssessmentReportRecord, "report_json"> & {
  report_json: string;
};

type ReviewRow = Omit<Review, "comment"> & {
  comment: string | null;
};

type RunEventRow = Omit<RunEvent, "message" | "payload"> & {
  message: string | null;
  payload_json: string;
};

type AuditEventRow = Omit<AuditEvent, "actor_id" | "payload"> & {
  actor_id: string | null;
  payload_json: string;
};

export class MedicalRepository {
  constructor(
    private readonly database: SqliteDatabase = getDatabase(),
    private readonly rawInputStore = new RawInputStore(),
  ) {}

  saveCase(caseRecord: CaseRecord): CaseRecord {
    const record = caseSchema.parse(caseRecord);

    this.database
      .prepare(
        `
        INSERT INTO cases (
          case_id,
          display_name,
          patient_ref,
          status,
          created_at,
          updated_at
        )
        VALUES (
          @case_id,
          @display_name,
          @patient_ref,
          @status,
          @created_at,
          @updated_at
        )
        ON CONFLICT(case_id) DO UPDATE SET
          display_name = excluded.display_name,
          patient_ref = excluded.patient_ref,
          status = excluded.status,
          updated_at = excluded.updated_at
        `,
      )
      .run({
        ...record,
        patient_ref: record.patient_ref ?? null,
      });

    return record;
  }

  getCase(caseId: string): CaseRecord | null {
    const row = this.database
      .prepare("SELECT * FROM cases WHERE case_id = ?")
      .get(caseId) as CaseRow | undefined;

    return row ? toCaseRecord(row) : null;
  }

  listCases(): CaseRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM cases ORDER BY updated_at DESC, created_at DESC")
      .all() as CaseRow[];

    return rows.map(toCaseRecord);
  }

  deleteCase(caseId: string): boolean {
    const inputs = this.listCaseInputs(caseId);
    const result = this.database
      .prepare("DELETE FROM cases WHERE case_id = ?")
      .run(caseId);

    if (result.changes === 0) {
      return false;
    }

    for (const input of inputs) {
      this.rawInputStore.deleteText(input.raw_text_path);
    }

    return true;
  }

  saveCaseInput(input: CaseInput): CaseInput {
    const record = caseInputSchema.parse(input);

    this.database
      .prepare(
        `
        INSERT INTO case_inputs (
          input_id,
          case_id,
          input_type,
          raw_text_path,
          raw_text_hash,
          version,
          submitted_at
        )
        VALUES (
          @input_id,
          @case_id,
          @input_type,
          @raw_text_path,
          @raw_text_hash,
          @version,
          @submitted_at
        )
        ON CONFLICT(input_id) DO UPDATE SET
          raw_text_path = excluded.raw_text_path,
          raw_text_hash = excluded.raw_text_hash,
          version = excluded.version,
          submitted_at = excluded.submitted_at
        `,
      )
      .run(record);

    return record;
  }

  createCaseInputFromRawText(
    params: CreateCaseInputFromRawTextParams,
  ): CaseInput {
    const inputId = params.input_id ?? randomUUID();
    const storedInput = this.rawInputStore.saveText({
      case_id: params.case_id,
      input_id: inputId,
      raw_text: params.raw_text,
    });
    const caseInput = caseInputSchema.parse({
      input_id: inputId,
      case_id: params.case_id,
      input_type: params.input_type,
      raw_text_path: storedInput.raw_text_path,
      raw_text_hash: storedInput.raw_text_hash,
      version:
        params.version ??
        this.getNextCaseInputVersion(params.case_id, params.input_type),
      submitted_at: params.submitted_at ?? nowIso(),
    });

    return this.saveCaseInput(caseInput);
  }

  getCaseInput(inputId: string): CaseInput | null {
    const row = this.database
      .prepare("SELECT * FROM case_inputs WHERE input_id = ?")
      .get(inputId) as CaseInputRow | undefined;

    return row ? caseInputSchema.parse(row) : null;
  }

  listCaseInputs(caseId: string): CaseInput[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM case_inputs
        WHERE case_id = ?
        ORDER BY submitted_at DESC, version DESC
        `,
      )
      .all(caseId) as CaseInputRow[];

    return rows.map((row) => caseInputSchema.parse(row));
  }

  readCaseInputRawText(inputId: string): string | null {
    const input = this.getCaseInput(inputId);

    if (!input) {
      return null;
    }

    return this.rawInputStore.readText(input.raw_text_path);
  }

  saveSpecialtyStructure(structure: SpecialtyStructure): SpecialtyStructure {
    const record = specialtyStructureSchema.parse(structure);

    this.database
      .prepare(
        `
        INSERT INTO specialty_structures (
          structure_id,
          case_id,
          version,
          cancer_site,
          structure_json,
          created_at
        )
        VALUES (
          @structure_id,
          @case_id,
          @version,
          @cancer_site,
          @structure_json,
          @created_at
        )
        ON CONFLICT(structure_id) DO UPDATE SET
          version = excluded.version,
          cancer_site = excluded.cancer_site,
          structure_json = excluded.structure_json,
          created_at = excluded.created_at
        `,
      )
      .run({
        structure_id: record.structure_id,
        case_id: record.case_id,
        version: record.version,
        cancer_site: record.cancer_site,
        structure_json: stringifyJson(record),
        created_at: record.created_at,
      });

    return record;
  }

  getSpecialtyStructure(structureId: string): SpecialtyStructure | null {
    const row = this.database
      .prepare(
        "SELECT structure_json FROM specialty_structures WHERE structure_id = ?",
      )
      .get(structureId) as SpecialtyStructureRow | undefined;

    return row ? parseSpecialtyStructure(row) : null;
  }

  getLatestSpecialtyStructure(caseId: string): SpecialtyStructure | null {
    const row = this.database
      .prepare(
        `
        SELECT structure_json
        FROM specialty_structures
        WHERE case_id = ?
        ORDER BY version DESC
        LIMIT 1
        `,
      )
      .get(caseId) as SpecialtyStructureRow | undefined;

    return row ? parseSpecialtyStructure(row) : null;
  }

  listSpecialtyStructures(caseId: string): SpecialtyStructure[] {
    const rows = this.database
      .prepare(
        `
        SELECT structure_json
        FROM specialty_structures
        WHERE case_id = ?
        ORDER BY version DESC
        `,
      )
      .all(caseId) as SpecialtyStructureRow[];

    return rows.map(parseSpecialtyStructure);
  }

  saveAssessmentRun(run: AssessmentRun): AssessmentRun {
    const record = assessmentRunSchema.parse(run);

    this.database
      .prepare(
        `
        INSERT INTO assessment_runs (
          run_id,
          case_id,
          status,
          structure_id,
          created_at,
          updated_at
        )
        VALUES (
          @run_id,
          @case_id,
          @status,
          @structure_id,
          @created_at,
          @updated_at
        )
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          structure_id = excluded.structure_id,
          updated_at = excluded.updated_at
        `,
      )
      .run({
        ...record,
        structure_id: record.structure_id ?? null,
      });

    return record;
  }

  getAssessmentRun(runId: string): AssessmentRun | null {
    const row = this.database
      .prepare("SELECT * FROM assessment_runs WHERE run_id = ?")
      .get(runId) as AssessmentRunRow | undefined;

    return row ? toAssessmentRun(row) : null;
  }

  listAssessmentRuns(caseId: string): AssessmentRun[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM assessment_runs
        WHERE case_id = ?
        ORDER BY created_at DESC
        `,
      )
      .all(caseId) as AssessmentRunRow[];

    return rows.map(toAssessmentRun);
  }

  appendRunEvent(params: CreateRunEventParams): RunEvent {
    const append = this.database.transaction(() => {
      const event = toRunEvent({
        event_id: params.event_id ?? randomUUID(),
        run_id: params.run_id,
        sequence:
          params.sequence ?? this.getNextRunEventSequence(params.run_id),
        event_type: params.event_type,
        message: params.message,
        payload: params.payload,
        created_at: params.created_at ?? nowIso(),
      });

      this.database
        .prepare(
          `
          INSERT INTO run_events (
            event_id,
            run_id,
            sequence,
            event_type,
            message,
            payload_json,
            created_at
          )
          VALUES (
            @event_id,
            @run_id,
            @sequence,
            @event_type,
            @message,
            @payload_json,
            @created_at
          )
          `,
        )
        .run({
          event_id: event.event_id,
          run_id: event.run_id,
          sequence: event.sequence,
          event_type: event.event_type,
          message: event.message ?? null,
          payload_json: stringifyJson(event.payload),
          created_at: event.created_at,
        });

      return event;
    });

    return append();
  }

  listRunEvents(runId: string): RunEvent[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM run_events
        WHERE run_id = ?
        ORDER BY sequence ASC
        `,
      )
      .all(runId) as RunEventRow[];

    return rows.map(toRunEventFromRow);
  }

  saveClarificationRequest(
    request: ClarificationRequestRecord,
  ): ClarificationRequestRecord {
    const record = clarificationRequestRecordSchema.parse(request);

    this.database
      .prepare(
        `
        INSERT INTO clarification_requests (
          request_id,
          case_id,
          run_id,
          reason,
          questions_json,
          created_at
        )
        VALUES (
          @request_id,
          @case_id,
          @run_id,
          @reason,
          @questions_json,
          @created_at
        )
        ON CONFLICT(request_id) DO UPDATE SET
          reason = excluded.reason,
          questions_json = excluded.questions_json
        `,
      )
      .run({
        request_id: record.request_id,
        case_id: record.case_id,
        run_id: record.run_id,
        reason: record.reason,
        questions_json: stringifyJson(record.questions),
        created_at: record.created_at,
      });

    return record;
  }

  getClarificationRequest(
    requestId: string,
  ): ClarificationRequestRecord | null {
    const row = this.database
      .prepare("SELECT * FROM clarification_requests WHERE request_id = ?")
      .get(requestId) as ClarificationRequestRow | undefined;

    return row ? toClarificationRequest(row) : null;
  }

  listClarificationRequests(runId: string): ClarificationRequestRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM clarification_requests
        WHERE run_id = ?
        ORDER BY created_at ASC
        `,
      )
      .all(runId) as ClarificationRequestRow[];

    return rows.map(toClarificationRequest);
  }

  saveClarificationResponse(
    response: ClarificationResponse,
  ): ClarificationResponse {
    const record = clarificationResponseSchema.parse(response);

    this.database
      .prepare(
        `
        INSERT INTO clarification_responses (
          response_id,
          request_id,
          question_id,
          answer_text,
          marked_unknown,
          supplemental_input_id,
          submitted_at
        )
        VALUES (
          @response_id,
          @request_id,
          @question_id,
          @answer_text,
          @marked_unknown,
          @supplemental_input_id,
          @submitted_at
        )
        ON CONFLICT(response_id) DO UPDATE SET
          answer_text = excluded.answer_text,
          marked_unknown = excluded.marked_unknown,
          supplemental_input_id = excluded.supplemental_input_id,
          submitted_at = excluded.submitted_at
        `,
      )
      .run({
        response_id: record.response_id,
        request_id: record.request_id,
        question_id: record.question_id,
        answer_text: record.answer_text ?? null,
        marked_unknown: record.marked_unknown ? 1 : 0,
        supplemental_input_id: record.supplemental_input_id ?? null,
        submitted_at: record.submitted_at,
      });

    return record;
  }

  listClarificationResponses(requestId: string): ClarificationResponse[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM clarification_responses
        WHERE request_id = ?
        ORDER BY submitted_at ASC
        `,
      )
      .all(requestId) as ClarificationResponseRow[];

    return rows.map(toClarificationResponse);
  }

  createCaseConversationMessage(
    params: CreateCaseConversationMessageParams,
  ): CaseConversationMessage {
    const message: CaseConversationMessage = {
      message_id: params.message_id ?? randomUUID(),
      case_id: params.case_id,
      role: params.role,
      content: params.content,
      case_input_id: params.case_input_id,
      created_at: params.created_at ?? nowIso(),
    };

    this.database
      .prepare(
        `
        INSERT INTO case_conversation_messages (
          message_id,
          case_id,
          role,
          content,
          case_input_id,
          created_at
        )
        VALUES (
          @message_id,
          @case_id,
          @role,
          @content,
          @case_input_id,
          @created_at
        )
        `,
      )
      .run({
        ...message,
        case_input_id: message.case_input_id ?? null,
      });

    return message;
  }

  listCaseConversationMessages(
    caseId: string,
    options: { limit?: number } = {},
  ): CaseConversationMessage[] {
    if (options.limit !== undefined) {
      const rows = this.database
        .prepare(
          `
          SELECT *
          FROM (
            SELECT *, rowid AS sort_rowid
            FROM case_conversation_messages
            WHERE case_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
          )
          ORDER BY created_at ASC, sort_rowid ASC
          `,
        )
        .all(caseId, options.limit) as CaseConversationMessageRow[];

      return rows.map(toCaseConversationMessage);
    }

    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM case_conversation_messages
        WHERE case_id = ?
        ORDER BY created_at ASC, rowid ASC
        `,
      )
      .all(caseId) as CaseConversationMessageRow[];

    return rows.map(toCaseConversationMessage);
  }

  savePatientMemorySnapshot(
    params: SavePatientMemorySnapshotParams,
  ): PatientMemorySnapshot {
    const snapshot: PatientMemorySnapshot = {
      snapshot_id: params.snapshot_id ?? randomUUID(),
      case_id: params.case_id,
      mode: params.mode,
      memory: params.memory,
      input_count: params.input_count,
      source_fingerprint: params.source_fingerprint,
      generated_at: params.generated_at,
      is_stale: params.is_stale,
      created_at: params.created_at ?? nowIso(),
    };

    const save = this.database.transaction(() => {
      this.database
        .prepare(
          `
          INSERT INTO patient_memory_snapshots (
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
          VALUES (
            @snapshot_id,
            @case_id,
            @mode,
            @memory_json,
            @input_count,
            @source_fingerprint,
            @generated_at,
            @is_stale,
            @created_at
          )
          ON CONFLICT(snapshot_id) DO UPDATE SET
            mode = excluded.mode,
            memory_json = excluded.memory_json,
            input_count = excluded.input_count,
            source_fingerprint = excluded.source_fingerprint,
            generated_at = excluded.generated_at,
            is_stale = excluded.is_stale,
            created_at = excluded.created_at
          `,
        )
        .run({
          snapshot_id: snapshot.snapshot_id,
          case_id: snapshot.case_id,
          mode: snapshot.mode,
          memory_json: stringifyJson(snapshot.memory),
          input_count: snapshot.input_count,
          source_fingerprint: snapshot.source_fingerprint,
          generated_at: snapshot.generated_at,
          is_stale: snapshot.is_stale ? 1 : 0,
          created_at: snapshot.created_at,
        });

      if (!snapshot.is_stale) {
        this.database
          .prepare(
            `
            UPDATE patient_memory_snapshots
            SET is_stale = 1
            WHERE case_id = ? AND snapshot_id <> ?
            `,
          )
          .run(snapshot.case_id, snapshot.snapshot_id);
      }
    });

    save();

    return snapshot;
  }

  getLatestPatientMemorySnapshot(caseId: string): PatientMemorySnapshot | null {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM patient_memory_snapshots
        WHERE case_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
        `,
      )
      .get(caseId) as PatientMemorySnapshotRow | undefined;

    return row ? toPatientMemorySnapshot(row) : null;
  }

  getLatestValidPatientMemorySnapshot(
    caseId: string,
    sourceFingerprint: string,
  ): PatientMemorySnapshot | null {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM patient_memory_snapshots
        WHERE case_id = ? AND source_fingerprint = ? AND is_stale = 0
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
        `,
      )
      .get(caseId, sourceFingerprint) as PatientMemorySnapshotRow | undefined;

    return row ? toPatientMemorySnapshot(row) : null;
  }

  markPatientMemorySnapshotsStale(caseId: string): number {
    const result = this.database
      .prepare(
        `
        UPDATE patient_memory_snapshots
        SET is_stale = 1
        WHERE case_id = ? AND is_stale = 0
        `,
      )
      .run(caseId);

    return result.changes;
  }

  createPendingRoughMemoryItem(
    params: CreatePendingRoughMemoryItemParams,
  ): PendingRoughMemoryItem {
    const item: PendingRoughMemoryItem = {
      rough_item_id: params.rough_item_id ?? randomUUID(),
      case_id: params.case_id,
      source_case_input_id: params.source_case_input_id,
      bucket: params.bucket,
      content: params.content,
      status: params.status ?? "pending",
      created_at: params.created_at ?? nowIso(),
      compacted_at: params.compacted_at,
    };

    this.database
      .prepare(
        `
        INSERT INTO pending_rough_memory_items (
          rough_item_id,
          case_id,
          source_case_input_id,
          bucket,
          content,
          status,
          created_at,
          compacted_at
        )
        VALUES (
          @rough_item_id,
          @case_id,
          @source_case_input_id,
          @bucket,
          @content,
          @status,
          @created_at,
          @compacted_at
        )
        ON CONFLICT(source_case_input_id) DO UPDATE SET
          case_id = excluded.case_id,
          bucket = excluded.bucket,
          content = excluded.content,
          status = excluded.status,
          created_at = excluded.created_at,
          compacted_at = excluded.compacted_at
        `,
      )
      .run({
        ...item,
        source_case_input_id: item.source_case_input_id ?? null,
        compacted_at: item.compacted_at ?? null,
      });

    if (item.source_case_input_id) {
      const existing = this.database
        .prepare(
          `
          SELECT *
          FROM pending_rough_memory_items
          WHERE source_case_input_id = ?
          LIMIT 1
          `,
        )
        .get(item.source_case_input_id) as
        | PendingRoughMemoryItemRow
        | undefined;

      return existing ? toPendingRoughMemoryItem(existing) : item;
    }

    return item;
  }

  listPendingRoughMemoryItems(caseId: string): PendingRoughMemoryItem[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM pending_rough_memory_items
        WHERE case_id = ? AND status = 'pending'
        ORDER BY created_at ASC, rowid ASC
        `,
      )
      .all(caseId) as PendingRoughMemoryItemRow[];

    return rows.map(toPendingRoughMemoryItem);
  }

  countPendingRoughMemoryItems(caseId: string): number {
    const row = this.database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM pending_rough_memory_items
        WHERE case_id = ? AND status = 'pending'
        `,
      )
      .get(caseId) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  markPendingRoughMemoryItemsCompacted(
    caseId: string,
    compactedAt = nowIso(),
  ): number {
    const result = this.database
      .prepare(
        `
        UPDATE pending_rough_memory_items
        SET status = 'compacted',
            compacted_at = ?
        WHERE case_id = ? AND status = 'pending'
        `,
      )
      .run(compactedAt, caseId);

    return result.changes;
  }

  saveAssessmentReport(
    report: AssessmentReportRecord,
  ): AssessmentReportRecord {
    const record = assessmentReportRecordSchema.parse(report);

    this.database
      .prepare(
        `
        INSERT INTO assessment_reports (
          report_id,
          run_id,
          case_id,
          report_json,
          report_markdown,
          created_at
        )
        VALUES (
          @report_id,
          @run_id,
          @case_id,
          @report_json,
          @report_markdown,
          @created_at
        )
        ON CONFLICT(report_id) DO UPDATE SET
          report_json = excluded.report_json,
          report_markdown = excluded.report_markdown
        `,
      )
      .run({
        report_id: record.report_id,
        run_id: record.run_id,
        case_id: record.case_id,
        report_json: stringifyJson(record.report_json),
        report_markdown: record.report_markdown,
        created_at: record.created_at,
      });

    return record;
  }

  getAssessmentReport(reportId: string): AssessmentReportRecord | null {
    const row = this.database
      .prepare("SELECT * FROM assessment_reports WHERE report_id = ?")
      .get(reportId) as AssessmentReportRow | undefined;

    return row ? toAssessmentReport(row) : null;
  }

  getAssessmentReportForRun(runId: string): AssessmentReportRecord | null {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM assessment_reports
        WHERE run_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
        `,
      )
      .get(runId) as AssessmentReportRow | undefined;

    return row ? toAssessmentReport(row) : null;
  }

  saveReview(review: Review): Review {
    const record = reviewSchema.parse(review);

    this.database
      .prepare(
        `
        INSERT INTO reviews (
          review_id,
          report_id,
          reviewer_id,
          decision,
          comment,
          reviewed_at
        )
        VALUES (
          @review_id,
          @report_id,
          @reviewer_id,
          @decision,
          @comment,
          @reviewed_at
        )
        ON CONFLICT(review_id) DO UPDATE SET
          decision = excluded.decision,
          comment = excluded.comment,
          reviewed_at = excluded.reviewed_at
        `,
      )
      .run({
        review_id: record.review_id,
        report_id: record.report_id,
        reviewer_id: record.reviewer_id,
        decision: record.decision,
        comment: record.comment ?? null,
        reviewed_at: record.reviewed_at,
      });

    return record;
  }

  listReviews(reportId: string): Review[] {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM reviews
        WHERE report_id = ?
        ORDER BY reviewed_at DESC
        `,
      )
      .all(reportId) as ReviewRow[];

    return rows.map(toReview);
  }

  recordAuditEvent(params: CreateAuditEventParams): AuditEvent {
    const event = toAuditEvent({
      audit_event_id: params.audit_event_id ?? randomUUID(),
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      action: params.action,
      actor_id: params.actor_id,
      payload: params.payload,
      created_at: params.created_at ?? nowIso(),
    });

    this.database
      .prepare(
        `
        INSERT INTO audit_events (
          audit_event_id,
          entity_type,
          entity_id,
          action,
          actor_id,
          payload_json,
          created_at
        )
        VALUES (
          @audit_event_id,
          @entity_type,
          @entity_id,
          @action,
          @actor_id,
          @payload_json,
          @created_at
        )
        `,
      )
      .run({
        audit_event_id: event.audit_event_id,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        action: event.action,
        actor_id: event.actor_id ?? null,
        payload_json: stringifyJson(event.payload),
        created_at: event.created_at,
      });

    return event;
  }

  listAuditEvents(entityType?: string, entityId?: string): AuditEvent[] {
    if (entityType && entityId) {
      const rows = this.database
        .prepare(
          `
          SELECT *
          FROM audit_events
          WHERE entity_type = ? AND entity_id = ?
          ORDER BY created_at ASC
          `,
        )
        .all(entityType, entityId) as AuditEventRow[];

      return rows.map(toAuditEventFromRow);
    }

    if (entityType) {
      const rows = this.database
        .prepare(
          `
          SELECT *
          FROM audit_events
          WHERE entity_type = ?
          ORDER BY created_at ASC
          `,
        )
        .all(entityType) as AuditEventRow[];

      return rows.map(toAuditEventFromRow);
    }

    const rows = this.database
      .prepare("SELECT * FROM audit_events ORDER BY created_at ASC")
      .all() as AuditEventRow[];

    return rows.map(toAuditEventFromRow);
  }

  private getNextCaseInputVersion(
    caseId: string,
    inputType: string,
  ): number {
    const row = this.database
      .prepare(
        `
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM case_inputs
        WHERE case_id = ? AND input_type = ?
        `,
      )
      .get(caseId, inputType) as { next_version: number } | undefined;

    return row?.next_version ?? 1;
  }

  private getNextRunEventSequence(runId: string): number {
    const row = this.database
      .prepare(
        `
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM run_events
        WHERE run_id = ?
        `,
      )
      .get(runId) as { next_sequence: number } | undefined;

    return row?.next_sequence ?? 1;
  }
}

let repository: MedicalRepository | undefined;

export function getMedicalRepository(): MedicalRepository {
  repository ??= new MedicalRepository();
  return repository;
}

function toCaseRecord(row: CaseRow): CaseRecord {
  return caseSchema.parse({
    ...row,
    patient_ref: optionalString(row.patient_ref),
  });
}

function toAssessmentRun(row: AssessmentRunRow): AssessmentRun {
  return assessmentRunSchema.parse({
    ...row,
    structure_id: optionalString(row.structure_id),
  });
}

function parseSpecialtyStructure(
  row: SpecialtyStructureRow,
): SpecialtyStructure {
  return specialtyStructureSchema.parse(parseJson(row.structure_json));
}

function toClarificationRequest(
  row: ClarificationRequestRow,
): ClarificationRequestRecord {
  return clarificationRequestRecordSchema.parse({
    request_id: row.request_id,
    case_id: row.case_id,
    run_id: row.run_id,
    reason: row.reason,
    questions: parseJson(row.questions_json),
    created_at: row.created_at,
  });
}

function toClarificationResponse(
  row: ClarificationResponseRow,
): ClarificationResponse {
  return clarificationResponseSchema.parse({
    ...row,
    answer_text: optionalString(row.answer_text),
    marked_unknown: row.marked_unknown === 1,
    supplemental_input_id: optionalString(row.supplemental_input_id),
  });
}

function toCaseConversationMessage(
  row: CaseConversationMessageRow,
): CaseConversationMessage {
  return {
    ...row,
    case_input_id: optionalString(row.case_input_id),
  };
}

function toPatientMemorySnapshot(
  row: PatientMemorySnapshotRow,
): PatientMemorySnapshot {
  return {
    snapshot_id: row.snapshot_id,
    case_id: row.case_id,
    mode: row.mode,
    memory: parseJson(row.memory_json) as PatientMemorySnapshot["memory"],
    input_count: row.input_count,
    source_fingerprint: row.source_fingerprint,
    generated_at: row.generated_at,
    is_stale: row.is_stale === 1,
    created_at: row.created_at,
  };
}

function toPendingRoughMemoryItem(
  row: PendingRoughMemoryItemRow,
): PendingRoughMemoryItem {
  return {
    ...row,
    compacted_at: optionalString(row.compacted_at),
    source_case_input_id: optionalString(row.source_case_input_id),
  };
}

function toAssessmentReport(row: AssessmentReportRow): AssessmentReportRecord {
  return assessmentReportRecordSchema.parse({
    ...row,
    report_json: parseJson(row.report_json),
  });
}

function toReview(row: ReviewRow): Review {
  return reviewSchema.parse({
    ...row,
    comment: optionalString(row.comment),
  });
}

function toRunEvent(event: Omit<RunEvent, "payload"> & { payload: unknown }): RunEvent {
  return {
    ...event,
    message: optionalString(event.message),
    payload: jsonValueSchema.parse(event.payload) as JsonValue,
  };
}

function toRunEventFromRow(row: RunEventRow): RunEvent {
  return toRunEvent({
    event_id: row.event_id,
    run_id: row.run_id,
    sequence: row.sequence,
    event_type: row.event_type,
    message: optionalString(row.message),
    payload: parseJson(row.payload_json),
    created_at: row.created_at,
  });
}

function toAuditEvent(
  event: Omit<AuditEvent, "payload"> & { payload: unknown },
): AuditEvent {
  return {
    ...event,
    actor_id: optionalString(event.actor_id),
    payload: jsonValueSchema.parse(event.payload) as JsonValue,
  };
}

function toAuditEventFromRow(row: AuditEventRow): AuditEvent {
  return toAuditEvent({
    audit_event_id: row.audit_event_id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    action: row.action,
    actor_id: optionalString(row.actor_id),
    payload: parseJson(row.payload_json),
    created_at: row.created_at,
  });
}

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function nowIso(): string {
  return new Date().toISOString();
}
