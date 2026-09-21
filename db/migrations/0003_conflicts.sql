-- 0003_conflicts.sql — rows an import could read but couldn't place, kept as first-class records.
--
-- A conflict is a *claim*: "this occupant wanted this berth on these days". It's the unit a person triages on the
-- Conflicts tab now, and the unit a CP-SAT solver will assign later (backend.md §6.6): decision = which berth
-- (and later, which days), given the confirmed bookings, berth lengths and vessel lengths.
--
-- Lifecycle: staged (upload preview) → open (import committed) → placed (a booking was made) | dismissed.
-- Discarding the import deletes its staged conflicts. Blockers are NOT stored: they're computed live from
-- confirmed bookings on read, so cancelling a blocker is reflected immediately.

CREATE TABLE conflict (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  import_id       uuid REFERENCES import_run (id) ON DELETE SET NULL,   -- NULL once cloned from a template
  type            text NOT NULL CHECK (type IN ('OVERLAP', 'VESSEL_TOO_LONG', 'VESSEL_DOUBLE_BERTHED', 'NO_BERTH', 'BERTH_INACTIVE')),
  status          text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'open', 'placed', 'dismissed')),
  -- the claim, as the file stated it
  occupant_type   text NOT NULL CHECK (occupant_type IN ('vessel', 'event', 'closure')),
  title           text NOT NULL,
  berth_label     text,                 -- raw label / Berth column (NULL = the row had none)
  berth_name      text,                 -- the berth it matched, by name (staged berths don't have ids yet)
  vessel_name     text,                 -- vessel claims only
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  notes           text,
  sheet           text NOT NULL,
  cell            text,
  message         text NOT NULL,        -- why, at detection time
  -- set at commit from the names above
  berth_id        uuid REFERENCES berth (id) ON DELETE SET NULL,
  vessel_id       uuid REFERENCES vessel (id) ON DELETE SET NULL,
  -- resolution
  booking_id      uuid REFERENCES booking (id) ON DELETE SET NULL,     -- the booking made when placed
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  CONSTRAINT conflict_dates CHECK (start_date <= end_date),
  CONSTRAINT conflict_vessel CHECK ((occupant_type = 'vessel') = (vessel_name IS NOT NULL)),
  CONSTRAINT conflict_resolved CHECK ((status IN ('placed', 'dismissed')) = (resolved_at IS NOT NULL))
);
CREATE INDEX conflict_by_project ON conflict (project_id, status, type, start_date);
CREATE INDEX conflict_by_import  ON conflict (import_id);

-- Cloning a template now carries its open conflicts, so the sample project has a Conflicts tab to explore.
CREATE OR REPLACE FUNCTION clone_project(src uuid, new_name text, new_origin text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE dst uuid := gen_random_uuid();
BEGIN
  INSERT INTO project (id, name, origin, as_of_date)
  SELECT dst, new_name, new_origin, as_of_date FROM project WHERE id = src;
  IF NOT FOUND THEN RAISE EXCEPTION 'no project %', src USING ERRCODE = 'no_data_found'; END IF;

  CREATE TEMP TABLE berth_map  ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM berth  WHERE project_id = src;
  CREATE TEMP TABLE vessel_map ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM vessel WHERE project_id = src;

  INSERT INTO berth (id, project_id, name, kind, length_ft, active, sort_order)
  SELECT m.new_id, dst, b.name, b.kind, b.length_ft, b.active, b.sort_order
  FROM berth b JOIN berth_map m ON m.old_id = b.id;

  INSERT INTO vessel (id, project_id, name, length_ft, draft_ft, operator, notes)
  SELECT m.new_id, dst, v.name, v.length_ft, v.draft_ft, v.operator, v.notes
  FROM vessel v JOIN vessel_map m ON m.old_id = v.id;

  INSERT INTO booking (project_id, berth_id, berth_kind, occupant_type, vessel_id, title,
                       start_date, end_date, status, source, notes)
  SELECT dst, bm.new_id, b.berth_kind, b.occupant_type, vm.new_id, b.title,
         b.start_date, b.end_date, b.status, b.source, b.notes
  FROM booking b
  JOIN berth_map bm       ON bm.old_id = b.berth_id
  LEFT JOIN vessel_map vm ON vm.old_id = b.vessel_id
  WHERE b.project_id = src;

  INSERT INTO conflict (project_id, type, status, occupant_type, title, berth_label, berth_name, vessel_name,
                        start_date, end_date, notes, sheet, cell, message, berth_id, vessel_id)
  SELECT dst, c.type, 'open', c.occupant_type, c.title, c.berth_label, c.berth_name, c.vessel_name,
         c.start_date, c.end_date, c.notes, c.sheet, c.cell, c.message, bm.new_id, vm.new_id
  FROM conflict c
  LEFT JOIN berth_map bm  ON bm.old_id = c.berth_id
  LEFT JOIN vessel_map vm ON vm.old_id = c.vessel_id
  WHERE c.project_id = src AND c.status = 'open';

  DROP TABLE berth_map, vessel_map;
  RETURN dst;
END $$;
