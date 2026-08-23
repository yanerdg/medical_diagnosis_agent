import type { CaseInputType } from "@/domain/schemas";
import type { JsonValue } from "@/domain/evidence";
import type { PatientMemory } from "@/lib/clinical-memory";
import type {
  ClinicalFact,
  ConflictItem,
  CreateClinicalFactParams,
  CreateConflictItemParams,
} from "@/server/context/types";

export type {
  ClinicalFact,
  ConflictItem,
  CreateClinicalFactParams,
  CreateConflictItemParams,
};

export interface CreateCaseInputFromRawTextParams {
  input_id?: string;
  case_id: string;
  input_type: CaseInputType;
  raw_text: string;
  version?: number;
  submitted_at?: string;
}

export interface RunEvent {
  event_id: string;
  run_id: string;
  sequence: number;
  event_type: string;
  message?: string;
  payload: JsonValue;
  created_at: string;
}

export type CreateRunEventParams = Omit<
  RunEvent,
  "event_id" | "sequence" | "created_at"
> &
  Partial<Pick<RunEvent, "event_id" | "sequence" | "created_at">>;

export interface AuditEvent {
  audit_event_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id?: string;
  payload: JsonValue;
  created_at: string;
}

export type CreateAuditEventParams = Omit<
  AuditEvent,
  "audit_event_id" | "created_at"
> &
  Partial<Pick<AuditEvent, "audit_event_id" | "created_at">>;

export type CaseConversationMessageRole = "clinician" | "agent";

export interface CaseConversationMessage {
  message_id: string;
  case_id: string;
  role: CaseConversationMessageRole;
  content: string;
  case_input_id?: string;
  created_at: string;
}

export type CreateCaseConversationMessageParams = Omit<
  CaseConversationMessage,
  "message_id" | "created_at"
> &
  Partial<Pick<CaseConversationMessage, "message_id" | "created_at">>;

export type PatientMemorySnapshotMode = "model" | "deterministic" | "fallback";

export interface PatientMemorySnapshot {
  snapshot_id: string;
  case_id: string;
  mode: PatientMemorySnapshotMode;
  memory: PatientMemory;
  input_count: number;
  source_fingerprint: string;
  generated_at: string;
  is_stale: boolean;
  created_at: string;
}

export type SavePatientMemorySnapshotParams = Omit<
  PatientMemorySnapshot,
  "snapshot_id" | "created_at"
> &
  Partial<Pick<PatientMemorySnapshot, "snapshot_id" | "created_at">>;

export type PendingRoughMemoryBucket =
  | "profile"
  | "history"
  | "imaging"
  | "pathology"
  | "labs"
  | "treatment"
  | "other";

export type PendingRoughMemoryStatus = "pending" | "compacted";

export interface PendingRoughMemoryItem {
  rough_item_id: string;
  case_id: string;
  source_case_input_id?: string;
  bucket: PendingRoughMemoryBucket;
  content: string;
  status: PendingRoughMemoryStatus;
  created_at: string;
  compacted_at?: string;
}

export type CreatePendingRoughMemoryItemParams = Omit<
  PendingRoughMemoryItem,
  "rough_item_id" | "status" | "created_at" | "compacted_at"
> &
  Partial<
    Pick<
      PendingRoughMemoryItem,
      "rough_item_id" | "status" | "created_at" | "compacted_at"
    >
  >;
