-- Free-form tables (any sheet with a header row, or a CSV) are a third import format. shared/contract.ts ImportFormat.
ALTER TABLE import_run DROP CONSTRAINT import_run_format_check;
ALTER TABLE import_run ADD CONSTRAINT import_run_format_check CHECK (format IN ('legacy_grid', 'template', 'table'));
