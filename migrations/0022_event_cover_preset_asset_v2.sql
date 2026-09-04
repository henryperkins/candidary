-- Admit the second immutable preset asset generation without changing the
-- stored cover config version or any source/pointer ownership rule.
DROP TRIGGER event_cover_source_pointer_insert;
DROP TRIGGER event_cover_source_pointer_update;

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
      AND json_extract(NEW.cover_config, '$.source.assetVersion') IN (1, 2)
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
      AND json_extract(NEW.cover_config, '$.source.assetVersion') IN (1, 2)
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
      NEW.cover_revision = OLD.cover_revision + 1
      AND NEW.cover_config IS OLD.cover_config
      AND NEW.cover_object_key IS OLD.cover_object_key
      AND NEW.cover_render_set_id IS OLD.cover_render_set_id
      AND EXISTS (
        SELECT 1 FROM event_cover_publish_receipts r
        WHERE r.event_id = NEW.id
          AND r.action = CASE
            WHEN json_extract(NEW.cover_config, '$.source.kind') = 'none' THEN 'remove'
            ELSE 'publish'
          END
          AND r.expected_revision = OLD.cover_revision
          AND r.status = 'applied' AND r.applied_revision = NEW.cover_revision
          AND r.result_cover_json = NEW.cover_config AND r.retryable = 0
          AND r.workflow_instance_id IS NULL AND r.render_set_id IS NULL AND r.draft_id IS NULL
          AND r.dispatch_state = 'confirmed' AND r.dispatch_generation = 0
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
