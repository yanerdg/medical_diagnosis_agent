export const databaseSchema = `
CREATE TABLE IF NOT EXISTS cases (
  case_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  patient_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready_for_assessment', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_inputs (
  input_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  input_type TEXT NOT NULL CHECK (
    input_type IN (
      'clinician_note',
      'ct_report',
      'pathology_biomarker',
      'lab_report',
      'treatment_history',
      'demographics',
      'other'
    )
  ),
  raw_text_path TEXT NOT NULL,
  raw_text_hash TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  submitted_at TEXT NOT NULL,
  UNIQUE (case_id, input_type, version)
);

CREATE TABLE IF NOT EXISTS specialty_structures (
  structure_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  cancer_site TEXT NOT NULL CHECK (
    cancer_site IN ('nasopharynx', 'oropharynx', 'hypopharynx', 'larynx', 'unknown')
  ),
  structure_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, version)
);

CREATE TABLE IF NOT EXISTS assessment_runs (
  run_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN (
      'created',
      'running',
      'paused_for_clinician_input',
      'completed',
      'failed',
      'rejected_by_safety_gate'
    )
  ),
  structure_id TEXT REFERENCES specialty_structures(structure_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clarification_requests (
  request_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES assessment_runs(run_id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clarification_responses (
  response_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES clarification_requests(request_id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer_text TEXT,
  marked_unknown INTEGER NOT NULL CHECK (marked_unknown IN (0, 1)),
  supplemental_input_id TEXT REFERENCES case_inputs(input_id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_conversation_messages (
  message_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('clinician', 'agent')),
  content TEXT NOT NULL,
  case_input_id TEXT REFERENCES case_inputs(input_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patient_memory_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('model', 'deterministic', 'fallback')),
  memory_json TEXT NOT NULL,
  input_count INTEGER NOT NULL CHECK (input_count >= 0),
  source_fingerprint TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  is_stale INTEGER NOT NULL CHECK (is_stale IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_rough_memory_items (
  rough_item_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  source_case_input_id TEXT REFERENCES case_inputs(input_id) ON DELETE SET NULL,
  bucket TEXT NOT NULL CHECK (
    bucket IN (
      'profile',
      'history',
      'imaging',
      'pathology',
      'labs',
      'treatment',
      'other'
    )
  ),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'compacted')),
  created_at TEXT NOT NULL,
  compacted_at TEXT,
  UNIQUE (source_case_input_id)
);

CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES assessment_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  message TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS assessment_reports (
  report_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES assessment_runs(run_id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  report_json TEXT NOT NULL,
  report_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  review_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES assessment_reports(report_id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('adopted', 'rejected', 'needs_revision')),
  comment TEXT,
  reviewed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS case_inputs_case_id_idx ON case_inputs(case_id);
CREATE INDEX IF NOT EXISTS specialty_structures_case_id_idx ON specialty_structures(case_id);
CREATE INDEX IF NOT EXISTS assessment_runs_case_id_idx ON assessment_runs(case_id);
CREATE INDEX IF NOT EXISTS clarification_requests_run_id_idx ON clarification_requests(run_id);
CREATE INDEX IF NOT EXISTS clarification_responses_request_id_idx ON clarification_responses(request_id);
CREATE INDEX IF NOT EXISTS case_conversation_messages_case_id_created_idx ON case_conversation_messages(case_id, created_at);
CREATE INDEX IF NOT EXISTS patient_memory_snapshots_case_id_created_idx ON patient_memory_snapshots(case_id, created_at);
CREATE INDEX IF NOT EXISTS patient_memory_snapshots_case_id_valid_idx ON patient_memory_snapshots(case_id, source_fingerprint, is_stale);
CREATE INDEX IF NOT EXISTS pending_rough_memory_items_case_status_created_idx ON pending_rough_memory_items(case_id, status, created_at);
CREATE INDEX IF NOT EXISTS run_events_run_id_sequence_idx ON run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS assessment_reports_run_id_idx ON assessment_reports(run_id);
CREATE INDEX IF NOT EXISTS reviews_report_id_idx ON reviews(report_id);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id);
`;
