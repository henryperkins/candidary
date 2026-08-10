-- Phase 3 closes the additive 0012 compatibility window. This migration is
-- intentionally fail-closed: it can install only after the live zero-legacy
-- predicates are all green, and every trigger below is part of one migration.

CREATE TABLE _event_cover_0014_proof_guard (
  proof INTEGER NOT NULL CHECK (proof = 1)
);

INSERT INTO _event_cover_0014_proof_guard (proof)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.deleted_at IS NULL
      AND e.cover_object_key IS NOT NULL
      AND e.cover_render_set_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM event_cover_backfill_jobs j
    JOIN events e ON e.id = j.event_id
    WHERE j.status IN ('needs_replacement', 'failed')
      AND e.deleted_at IS NULL
      AND e.cover_object_key IS NOT NULL
      AND e.cover_render_set_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM event_cover_render_sets s
    WHERE s.state = 'active'
      AND (
        s.manifest_sha256 IS NULL
        OR s.required_slots <> (
          SELECT count(*) FROM event_cover_render_objects o WHERE o.render_set_id = s.id
        )
        OR s.required_slots <> (
          SELECT count(*) FROM event_cover_render_objects o
          WHERE o.render_set_id = s.id AND o.event_id = s.event_id
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.deleted_at IS NULL
      AND json_extract(e.cover_config, '$.source.kind') = 'upload'
      AND (
        e.cover_object_key IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM event_cover_render_sets s
          JOIN event_cover_masters m ON m.id = s.master_id
          WHERE s.id = e.cover_render_set_id
            AND s.event_id = e.id AND s.state = 'active'
            AND m.event_id = e.id AND m.object_key = e.cover_object_key
        )
      )
  )
THEN 1 ELSE 0 END;

DROP TABLE _event_cover_0014_proof_guard;

-- A strict stored v1 source union and its canonical pointer ownership.
CREATE TRIGGER event_cover_source_pointer_insert
BEFORE INSERT ON events
WHEN NOT (
  NEW.cover_revision = 0
  AND json_valid(NEW.cover_config)
  AND json_type(NEW.cover_config) = 'object'
  AND json_type(NEW.cover_config, '$.version') = 'integer'
  AND json_extract(NEW.cover_config, '$.version') = 1
  AND (
    (
      json_extract(NEW.cover_config, '$.source.kind') = 'none'
      AND (SELECT count(*) FROM json_each(NEW.cover_config)) = 2
      AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.source')) = 1
      AND NEW.cover_object_key IS NULL AND NEW.cover_render_set_id IS NULL
    )
    OR (
      json_extract(NEW.cover_config, '$.source.kind') = 'preset'
      AND (SELECT count(*) FROM json_each(NEW.cover_config)) = 3
      AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.source')) = 3
      AND json_extract(NEW.cover_config, '$.source.presetId') IN (
        'warm-linen', 'botanical-shadow', 'pressed-paper',
        'candlelit-grain', 'coastal-haze', 'midnight-wash'
      )
      AND json_type(NEW.cover_config, '$.source.assetVersion') = 'integer'
      AND json_extract(NEW.cover_config, '$.source.assetVersion') = 1
      AND json_extract(NEW.cover_config, '$.effect') IN (
        'natural', 'warm', 'film', 'soft', 'monochrome'
      )
      AND NEW.cover_object_key IS NULL AND NEW.cover_render_set_id IS NULL
    )
    OR (
      json_extract(NEW.cover_config, '$.source.kind') = 'upload'
      AND (SELECT count(*) FROM json_each(NEW.cover_config)) = 4
      AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.source')) = 1
      AND json_extract(NEW.cover_config, '$.effect') IN (
        'natural', 'warm', 'film', 'soft', 'monochrome'
      )
      AND (
        (
          json_extract(NEW.cover_config, '$.focus.mode') = 'auto'
          AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.focus')) = 1
        )
        OR (
          json_extract(NEW.cover_config, '$.focus.mode') = 'manual'
          AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.focus')) = 4
          AND json_type(NEW.cover_config, '$.focus.x') IN ('integer', 'real')
          AND json_extract(NEW.cover_config, '$.focus.x') BETWEEN 0 AND 1
          AND json_type(NEW.cover_config, '$.focus.y') IN ('integer', 'real')
          AND json_extract(NEW.cover_config, '$.focus.y') BETWEEN 0 AND 1
          AND json_type(NEW.cover_config, '$.focus.zoom') IN ('integer', 'real')
          AND json_extract(NEW.cover_config, '$.focus.zoom') BETWEEN 1 AND 2
        )
      )
      AND NEW.cover_object_key IS NOT NULL AND NEW.cover_render_set_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM event_cover_render_sets s
        JOIN event_cover_masters m ON m.id = s.master_id AND m.event_id = s.event_id
        WHERE s.id = NEW.cover_render_set_id AND s.event_id = NEW.id
          AND m.object_key = NEW.cover_object_key
          AND s.state = 'active' AND s.published_revision = NEW.cover_revision
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'event cover source/pointer insert invariant');
END;

CREATE TRIGGER event_cover_source_pointer_update
BEFORE UPDATE OF cover_config, cover_object_key, cover_render_set_id, cover_revision, deleted_at ON events
WHEN NOT (
  json_valid(NEW.cover_config)
  AND json_type(NEW.cover_config) = 'object'
  AND json_type(NEW.cover_config, '$.version') = 'integer'
  AND json_extract(NEW.cover_config, '$.version') = 1
  AND (
    (
      json_extract(NEW.cover_config, '$.source.kind') = 'none'
      AND (SELECT count(*) FROM json_each(NEW.cover_config)) = 2
      AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.source')) = 1
      AND NEW.cover_object_key IS NULL AND NEW.cover_render_set_id IS NULL
    )
    OR (
      json_extract(NEW.cover_config, '$.source.kind') = 'preset'
      AND (SELECT count(*) FROM json_each(NEW.cover_config)) = 3
      AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.source')) = 3
      AND json_extract(NEW.cover_config, '$.source.presetId') IN (
        'warm-linen', 'botanical-shadow', 'pressed-paper',
        'candlelit-grain', 'coastal-haze', 'midnight-wash'
      )
      AND json_type(NEW.cover_config, '$.source.assetVersion') = 'integer'
      AND json_extract(NEW.cover_config, '$.source.assetVersion') = 1
      AND json_extract(NEW.cover_config, '$.effect') IN (
        'natural', 'warm', 'film', 'soft', 'monochrome'
      )
      AND NEW.cover_object_key IS NULL AND NEW.cover_render_set_id IS NULL
    )
    OR (
      json_extract(NEW.cover_config, '$.source.kind') = 'upload'
      AND (SELECT count(*) FROM json_each(NEW.cover_config)) = 4
      AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.source')) = 1
      AND json_extract(NEW.cover_config, '$.effect') IN (
        'natural', 'warm', 'film', 'soft', 'monochrome'
      )
      AND (
        (
          json_extract(NEW.cover_config, '$.focus.mode') = 'auto'
          AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.focus')) = 1
        )
        OR (
          json_extract(NEW.cover_config, '$.focus.mode') = 'manual'
          AND (SELECT count(*) FROM json_each(NEW.cover_config, '$.focus')) = 4
          AND json_type(NEW.cover_config, '$.focus.x') IN ('integer', 'real')
          AND json_extract(NEW.cover_config, '$.focus.x') BETWEEN 0 AND 1
          AND json_type(NEW.cover_config, '$.focus.y') IN ('integer', 'real')
          AND json_extract(NEW.cover_config, '$.focus.y') BETWEEN 0 AND 1
          AND json_type(NEW.cover_config, '$.focus.zoom') IN ('integer', 'real')
          AND json_extract(NEW.cover_config, '$.focus.zoom') BETWEEN 1 AND 2
        )
      )
      AND NEW.cover_object_key IS NOT NULL AND NEW.cover_render_set_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM event_cover_render_sets s
        JOIN event_cover_masters m ON m.id = s.master_id AND m.event_id = s.event_id
        WHERE s.id = NEW.cover_render_set_id AND s.event_id = NEW.id
          AND m.object_key = NEW.cover_object_key
          AND s.required_slots = (
            SELECT count(*) FROM event_cover_render_objects o
            WHERE o.render_set_id = s.id AND o.event_id = s.event_id
          )
          AND 12 = (
            SELECT count(*) FROM event_cover_render_objects o
            WHERE o.render_set_id = s.id AND o.event_id = s.event_id AND o.density = '1x'
          )
          AND 6 = (
            SELECT count(DISTINCT o.profile_id) FROM event_cover_render_objects o
            WHERE o.render_set_id = s.id AND o.event_id = s.event_id AND o.density = '1x'
          )
          AND NOT EXISTS (
            SELECT 1 FROM event_cover_render_objects o
            WHERE o.render_set_id = s.id AND o.event_id = s.event_id
            GROUP BY o.profile_id
            HAVING sum(CASE WHEN o.density = '2x' THEN 1 ELSE 0 END) = 1
          )
          AND (
            (s.state = 'active' AND s.manifest_sha256 IS NOT NULL
              AND s.ready_at IS NOT NULL AND s.published_at IS NOT NULL
              AND s.published_revision = NEW.cover_revision)
            OR (
              s.state IN ('staging', 'ready')
              AND (s.state <> 'ready' OR (s.manifest_sha256 IS NOT NULL AND s.ready_at IS NOT NULL))
              AND (
                EXISTS (
                  SELECT 1 FROM event_cover_publish_receipts r
                  JOIN event_cover_drafts d
                    ON d.id = r.draft_id AND d.event_id = r.event_id AND d.state = 'publishing'
                  JOIN event_cover_workflow_fences f
                    ON f.workflow_binding = 'COVER_RENDER_WORKFLOW'
                      AND f.workflow_instance_id = r.workflow_instance_id
                      AND f.event_id = r.event_id AND f.state = 'open'
                      AND f.dispatch_generation = r.dispatch_generation
                  WHERE r.event_id = NEW.id AND r.render_set_id = s.id
                    AND r.action = 'publish' AND r.expected_revision + 1 = NEW.cover_revision
                    AND r.status IN ('rendering', 'finalizing', 'applied')
                )
                OR EXISTS (
                  SELECT 1 FROM event_cover_backfill_jobs j
                  JOIN event_cover_workflow_fences f
                    ON f.workflow_binding = 'COVER_BACKFILL_WORKFLOW'
                      AND f.workflow_instance_id = j.workflow_instance_id
                      AND f.event_id = j.event_id AND f.state = 'open'
                      AND f.dispatch_generation = j.dispatch_generation
                  WHERE j.event_id = NEW.id AND j.render_set_id = s.id AND j.master_id = s.master_id
                    AND j.expected_revision + 1 = NEW.cover_revision
                    AND j.status IN ('rendering', 'finalizing', 'applied')
                )
              )
            )
          )
      )
    )
  )
  AND (
    (
      NEW.cover_config IS OLD.cover_config
      AND NEW.cover_object_key IS OLD.cover_object_key
      AND NEW.cover_render_set_id IS OLD.cover_render_set_id
      AND NEW.cover_revision = OLD.cover_revision
    )
    OR (
      NEW.cover_revision = OLD.cover_revision + 1
      AND (
        NEW.cover_config IS NOT OLD.cover_config
        OR NEW.cover_object_key IS NOT OLD.cover_object_key
        OR NEW.cover_render_set_id IS NOT OLD.cover_render_set_id
      )
    )
    OR (
      NEW.deleted_at IS NOT NULL
      AND NEW.cover_revision = OLD.cover_revision
      AND NEW.cover_config = '{"version":1,"source":{"kind":"none"}}'
      AND NEW.cover_object_key IS NULL AND NEW.cover_render_set_id IS NULL
      AND EXISTS (
        SELECT 1 FROM event_cover_purge_progress p
        WHERE p.event_id = NEW.id AND p.phase = 'relational'
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'event cover source/pointer update invariant');
END;

-- A ready or active set is a frozen exact manifest. It must be assembled while
-- staging, then moved as one state transition after all object rows exist.
CREATE TRIGGER event_cover_render_set_manifest_insert
BEFORE INSERT ON event_cover_render_sets
WHEN NEW.state IN ('ready', 'active') AND NOT (
  NEW.manifest_sha256 IS NOT NULL AND NEW.ready_at IS NOT NULL
  AND NEW.required_slots = (
    SELECT count(*) FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id
  )
  AND 12 = (
    SELECT count(*) FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id AND o.density = '1x'
  )
  AND 6 = (
    SELECT count(DISTINCT o.profile_id) FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id AND o.density = '1x'
  )
  AND NOT EXISTS (
    SELECT 1 FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id
    GROUP BY o.profile_id
    HAVING sum(CASE WHEN o.density = '2x' THEN 1 ELSE 0 END) = 1
  )
  AND EXISTS (
    SELECT 1 FROM event_cover_masters m WHERE m.id = NEW.master_id AND m.event_id = NEW.event_id
  )
  AND (
    (NEW.state = 'ready' AND NEW.published_revision IS NULL AND NEW.published_at IS NULL)
    OR (NEW.state = 'active' AND NEW.published_revision IS NOT NULL AND NEW.published_at IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'event cover render-set insert manifest invariant');
END;

CREATE TRIGGER event_cover_render_set_manifest_update
BEFORE UPDATE ON event_cover_render_sets
WHEN NEW.state IN ('ready', 'active') AND NOT (
  NEW.event_id = OLD.event_id AND NEW.master_id = OLD.master_id AND NEW.draft_id IS OLD.draft_id
  AND NEW.manifest_sha256 IS NOT NULL AND NEW.ready_at IS NOT NULL
  AND NEW.required_slots = (
    SELECT count(*) FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id
  )
  AND 12 = (
    SELECT count(*) FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id AND o.density = '1x'
  )
  AND 6 = (
    SELECT count(DISTINCT o.profile_id) FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id AND o.density = '1x'
  )
  AND NOT EXISTS (
    SELECT 1 FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND o.event_id = NEW.event_id
    GROUP BY o.profile_id
    HAVING sum(CASE WHEN o.density = '2x' THEN 1 ELSE 0 END) = 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM event_cover_render_objects o
    WHERE o.render_set_id = NEW.id AND (
      o.event_id <> NEW.event_id
      OR o.width <> (CASE o.profile_id
        WHEN 'short-lookup' THEN 360 WHEN 'compact-default' THEN 390
        WHEN 'standard-default' THEN 620 WHEN 'framed-default' THEN 620
        WHEN 'compact-expanded' THEN 390 WHEN 'wide-expanded' THEN 620 END)
        * (CASE o.density WHEN '2x' THEN 2 ELSE 1 END)
      OR o.height <> (CASE o.profile_id
        WHEN 'short-lookup' THEN 168 WHEN 'compact-default' THEN 205
        WHEN 'standard-default' THEN 218 WHEN 'framed-default' THEN 265
        WHEN 'compact-expanded' THEN 420 WHEN 'wide-expanded' THEN 420 END)
        * (CASE o.density WHEN '2x' THEN 2 ELSE 1 END)
      OR o.content_type <> (CASE o.format WHEN 'webp' THEN 'image/webp' ELSE 'image/jpeg' END)
    )
  )
  AND EXISTS (
    SELECT 1 FROM event_cover_masters m WHERE m.id = NEW.master_id AND m.event_id = NEW.event_id
  )
  AND (
    (NEW.state = 'ready' AND NEW.published_revision IS NULL AND NEW.published_at IS NULL)
    OR (NEW.state = 'active' AND NEW.published_revision IS NOT NULL AND NEW.published_at IS NOT NULL)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'event cover render-set update manifest invariant');
END;

CREATE TRIGGER event_cover_render_object_manifest_insert
BEFORE INSERT ON event_cover_render_objects
WHEN EXISTS (
  SELECT 1 FROM event_cover_render_sets s
  WHERE s.id = NEW.render_set_id AND s.state IN ('ready', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'event cover frozen manifest insert');
END;

CREATE TRIGGER event_cover_render_object_manifest_update
BEFORE UPDATE ON event_cover_render_objects
WHEN EXISTS (
  SELECT 1 FROM event_cover_render_sets s
  WHERE s.id IN (OLD.render_set_id, NEW.render_set_id) AND s.state IN ('ready', 'active')
)
BEGIN
  SELECT RAISE(ABORT, 'event cover frozen manifest update');
END;

CREATE TRIGGER event_cover_render_object_manifest_delete
BEFORE DELETE ON event_cover_render_objects
WHEN EXISTS (
  SELECT 1 FROM event_cover_render_sets s
  WHERE s.id = OLD.render_set_id AND s.state IN ('ready', 'active')
)
AND NOT EXISTS (
  SELECT 1 FROM events e
  JOIN event_cover_purge_progress p ON p.event_id = e.id AND p.phase = 'relational'
  WHERE e.id = OLD.event_id AND e.deleted_at IS NOT NULL
    AND e.cover_config = '{"version":1,"source":{"kind":"none"}}'
    AND e.cover_object_key IS NULL AND e.cover_render_set_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'event cover frozen manifest delete');
END;

CREATE TRIGGER event_cover_master_live_reference_delete
BEFORE DELETE ON event_cover_masters
WHEN EXISTS (
  SELECT 1 FROM events e
  WHERE (
    e.cover_object_key = OLD.object_key
    OR EXISTS (
      SELECT 1 FROM event_cover_render_sets s
      WHERE s.id = e.cover_render_set_id AND s.master_id = OLD.id
    )
  )
  AND NOT (
    e.deleted_at IS NOT NULL
    AND e.cover_config = '{"version":1,"source":{"kind":"none"}}'
    AND e.cover_object_key IS NULL AND e.cover_render_set_id IS NULL
    AND EXISTS (
      SELECT 1 FROM event_cover_purge_progress p
      WHERE p.event_id = e.id AND p.phase = 'relational'
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'event cover live master delete');
END;

CREATE TRIGGER event_cover_render_set_live_reference_delete
BEFORE DELETE ON event_cover_render_sets
WHEN EXISTS (
  SELECT 1 FROM events e
  WHERE e.id = OLD.event_id
    AND (e.cover_render_set_id = OLD.id OR OLD.state IN ('ready', 'active'))
    AND NOT (
      e.deleted_at IS NOT NULL
      AND e.cover_config = '{"version":1,"source":{"kind":"none"}}'
      AND e.cover_object_key IS NULL AND e.cover_render_set_id IS NULL
      AND EXISTS (
        SELECT 1 FROM event_cover_purge_progress p
        WHERE p.event_id = e.id AND p.phase = 'relational'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'event cover live render-set delete');
END;
