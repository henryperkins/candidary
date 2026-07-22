ALTER TABLE export_jobs ADD COLUMN manifest_object_key TEXT;
ALTER TABLE export_jobs ADD COLUMN part_count INTEGER NOT NULL DEFAULT 0 CHECK (part_count >= 0);

CREATE TABLE export_parts (
  id TEXT PRIMARY KEY,
  export_job_id TEXT NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number >= 1),
  object_key TEXT NOT NULL,
  media_count INTEGER NOT NULL CHECK (media_count >= 1),
  source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
  created_at TEXT NOT NULL,
  UNIQUE(export_job_id, part_number)
);

CREATE INDEX export_parts_job_number ON export_parts(export_job_id, part_number);
