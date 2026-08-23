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

CREATE TABLE IF NOT EXISTS imaging_tool_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ct', 'wsi')),
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES assessment_runs(run_id) ON DELETE CASCADE,
  input_id TEXT NOT NULL REFERENCES case_inputs(input_id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'quality_insufficient')),
  model_version TEXT NOT NULL,
  result_evidence_ids_json TEXT NOT NULL,
  error_message TEXT,
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
  conflict_resolution TEXT CHECK (conflict_resolution IN ('confirm_left', 'confirm_right', 'acknowledge_unknown')),
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

-- Materialized, traceable clinical facts used to assemble bounded agent context.
-- Source documents remain the clinical source of truth; these rows are an index.
CREATE TABLE IF NOT EXISTS clinical_facts (
  fact_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  structure_id TEXT REFERENCES specialty_structures(structure_id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'reported', 'unknown', 'conflicting')),
  evidence_ids_json TEXT NOT NULL,
  source_priority INTEGER NOT NULL CHECK (source_priority >= 0),
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (structure_id, fact_key)
);

CREATE TABLE IF NOT EXISTS clinical_conflicts (
  conflict_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  structure_id TEXT REFERENCES specialty_structures(structure_id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'high', 'medium', 'low')),
  field TEXT NOT NULL,
  left_evidence_ids_json TEXT NOT NULL,
  right_evidence_ids_json TEXT NOT NULL,
  description TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('unresolved', 'clinician_confirmed', 'superseded', 'acknowledged_unknown')),
  blocks_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
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

-- Locally injected knowledge only. Patient inputs never enter these tables.
CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL UNIQUE,
  source_title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  cancer_site_scope_json TEXT NOT NULL,
  evidence_level TEXT NOT NULL,
  review_status TEXT NOT NULL,
  publish_date TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  original_path TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_document_versions (
  document_version_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(document_id) ON DELETE CASCADE,
  knowledge_version TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (document_id, knowledge_version, source_sha256)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL REFERENCES knowledge_document_versions(document_version_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  heading_path TEXT NOT NULL,
  page_start INTEGER,
  page_end INTEGER,
  text_chunk TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (document_version_id, ordinal),
  UNIQUE (document_version_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id) ON DELETE CASCADE,
  embedding_model TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL CHECK (embedding_dimension > 0),
  embedding_json TEXT NOT NULL,
  embedded_content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chunk_id, embedding_model)
);

CREATE TABLE IF NOT EXISTS knowledge_ingestion_runs (
  ingestion_run_id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES knowledge_documents(document_id) ON DELETE SET NULL,
  knowledge_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped_duplicate')),
  requested_by TEXT,
  summary_json TEXT NOT NULL,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunk_fts USING fts5(
  chunk_id UNINDEXED,
  source_title,
  heading_path,
  text_chunk,
  structured_tags
);

CREATE INDEX IF NOT EXISTS case_inputs_case_id_idx ON case_inputs(case_id);
CREATE INDEX IF NOT EXISTS specialty_structures_case_id_idx ON specialty_structures(case_id);
CREATE INDEX IF NOT EXISTS assessment_runs_case_id_idx ON assessment_runs(case_id);
CREATE INDEX IF NOT EXISTS imaging_tool_jobs_run_status_idx ON imaging_tool_jobs(run_id, status);
CREATE INDEX IF NOT EXISTS clarification_requests_run_id_idx ON clarification_requests(run_id);
CREATE INDEX IF NOT EXISTS clarification_responses_request_id_idx ON clarification_responses(request_id);
CREATE INDEX IF NOT EXISTS case_conversation_messages_case_id_created_idx ON case_conversation_messages(case_id, created_at);
CREATE INDEX IF NOT EXISTS patient_memory_snapshots_case_id_created_idx ON patient_memory_snapshots(case_id, created_at);
CREATE INDEX IF NOT EXISTS patient_memory_snapshots_case_id_valid_idx ON patient_memory_snapshots(case_id, source_fingerprint, is_stale);
CREATE INDEX IF NOT EXISTS pending_rough_memory_items_case_status_created_idx ON pending_rough_memory_items(case_id, status, created_at);
CREATE INDEX IF NOT EXISTS clinical_facts_case_structure_idx ON clinical_facts(case_id, structure_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS clinical_conflicts_case_resolution_idx ON clinical_conflicts(case_id, resolution, severity);
CREATE INDEX IF NOT EXISTS run_events_run_id_sequence_idx ON run_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS assessment_reports_run_id_idx ON assessment_reports(run_id);
CREATE INDEX IF NOT EXISTS reviews_report_id_idx ON reviews(report_id);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS knowledge_document_versions_document_idx ON knowledge_document_versions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_document_versions_status_idx ON knowledge_document_versions(knowledge_version, status);
CREATE INDEX IF NOT EXISTS knowledge_chunks_version_ordinal_idx ON knowledge_chunks(document_version_id, ordinal);
CREATE INDEX IF NOT EXISTS knowledge_embeddings_model_idx ON knowledge_embeddings(embedding_model, chunk_id);
CREATE INDEX IF NOT EXISTS knowledge_ingestion_runs_document_idx ON knowledge_ingestion_runs(document_id, started_at DESC);
`;
