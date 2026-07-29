ALTER TABLE events
ADD COLUMN theme_config TEXT NOT NULL
DEFAULT '{"version":1,"presetId":"candidary-default","overrides":{}}'
CHECK (
  length(theme_config) <= 512
  AND json_valid(theme_config)
  AND json_type(theme_config) = 'object'
);
