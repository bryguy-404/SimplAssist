BEGIN;

-- The chat widget shows a small dot mascot in its header whenever no logo is
-- displayed. Owners choose its colour; every new and existing widget starts
-- with white, which reads against any brand colour.
ALTER TABLE public.widget_configs
  ADD COLUMN mascot_color text NOT NULL DEFAULT '#FFFFFF'
  CONSTRAINT widget_configs_mascot_color_hex
    CHECK (mascot_color ~ '^#[0-9A-Fa-f]{6}$');

COMMENT ON COLUMN public.widget_configs.mascot_color IS
  'Hex colour of the header mascot shown when the widget has no logo to display.';

-- The column inherits widget_configs row-level security and existing table
-- privileges; this migration intentionally creates no new policy or grant.

COMMIT;
