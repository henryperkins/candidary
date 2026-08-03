CREATE TABLE release_certifications (
  worker_version_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(worker_version_id) BETWEEN 1 AND 128)
    CHECK (worker_version_id = trim(worker_version_id)),
  build_sha TEXT NOT NULL
    CHECK (length(build_sha) = 40)
    CHECK (build_sha NOT GLOB '*[^0-9a-f]*'),
  guest_journey_version INTEGER NOT NULL
    CHECK (typeof(guest_journey_version) = 'integer')
    CHECK (guest_journey_version > 0),
  migration_manifest_sha256 TEXT NOT NULL
    CHECK (length(migration_manifest_sha256) = 64)
    CHECK (migration_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_manifest_sha256 TEXT NOT NULL
    CHECK (length(evidence_manifest_sha256) = 64)
    CHECK (evidence_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  physical_evidence_refs_json TEXT NOT NULL
    CHECK (length(physical_evidence_refs_json) BETWEEN 2 AND 32768)
    CHECK (json_valid(physical_evidence_refs_json))
    CHECK (json_type(physical_evidence_refs_json) = 'array')
    CHECK (json_array_length(physical_evidence_refs_json) > 0),
  certified_at TEXT NOT NULL
    CHECK (length(certified_at) = 24)
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', certified_at) = certified_at)
);

CREATE INDEX release_certifications_exact
  ON release_certifications (
    build_sha,
    guest_journey_version,
    migration_manifest_sha256
  );
