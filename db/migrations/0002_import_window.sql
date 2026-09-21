-- 0002_import_window.sql — what 0001 lacked for the planning window and the Python pipeline's row metadata.
-- ImportRun.window / counts.outsideWindow (shared/contract.ts) and ImportedRow.classifiedBy need storage.

ALTER TABLE import_run
  ADD COLUMN plan_from      date    NOT NULL DEFAULT '1997-01-01',
  ADD COLUMN plan_to        date    NOT NULL DEFAULT '2050-12-31',
  ADD COLUMN outside_window integer NOT NULL DEFAULT 0 CHECK (outside_window >= 0),
  ADD CONSTRAINT import_run_window_valid CHECK (plan_from <= plan_to);
ALTER TABLE import_run ALTER COLUMN plan_from DROP DEFAULT, ALTER COLUMN plan_to DROP DEFAULT;

ALTER TABLE import_issue
  ADD COLUMN row_classified_by text CHECK (row_classified_by IN ('regex', 'template', 'model')),
  ADD COLUMN row_notes         text;

-- A staged vessel may just point at one the project already has (commit keeps the existing row).
-- counts.vessels = the new ones only.
ALTER TABLE import_staged_vessel ADD COLUMN is_new boolean NOT NULL DEFAULT true;
