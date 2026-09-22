-- Berths lose `kind`. A row with no length is no longer a second kind of thing with its own (absent) rules —
-- it is an ordinary berth whose length nobody has filled in yet, so the FIT check can't run on it.
--
-- Why: "we don't know this row's length" and "this row has no occupancy rules" were welded into one flag.
-- Only the first is in the source data (the legacy grid has rows like "Small craft slips" with no "- 410'"),
-- and the second switched off R2 — the double-booking check — which has nothing to do with lengths.
-- After this migration every berth is exclusive (R2 everywhere) and a NULL length means "fit unverified",
-- the same state an unknown vessel length already produces. See manual.md R2/R3 and backend.md §2.

-- 1. R2 now covers the rows that used to be sections, so any stays that overlapped there must be settled
--    first or the widened constraint can't be built. Keep the longer stay, cancel the shorter one, and say
--    why in its notes: cancelled bookings stay visible ("Include cancelled" on the Bookings screen).
DO $$
DECLARE victim uuid;
BEGIN
  LOOP
    SELECT loser.id INTO victim
    FROM booking loser
    JOIN booking keeper
      ON keeper.berth_id = loser.berth_id AND keeper.id <> loser.id AND keeper.period && loser.period
     AND keeper.status = 'confirmed'
    JOIN berth be ON be.id = loser.berth_id AND be.kind = 'section'
    WHERE loser.status = 'confirmed'
    ORDER BY (upper(loser.period) - lower(loser.period)), loser.start_date, loser.id
    LIMIT 1;
    EXIT WHEN victim IS NULL;
    UPDATE booking SET status = 'cancelled', updated_at = now(),
           notes = concat_ws(E'\n', notes,
             '[0007] Cancelled by migration: this stay shared a "section" row with a longer one. '
             'Sections are now ordinary berths, and a berth holds one occupant at a time. '
             'Re-book it on another berth if it really happened.')
     WHERE id = victim;
  END LOOP;
END $$;

-- 2. booking.berth_kind existed only to pin R2 to exclusive berths through the composite FK. Both go.
--    booking_view selects b.*, so it has the column baked in and must be rebuilt after the drop.
--    booking_no_overlap names berth_kind in its WHERE, so it goes first and comes back in step 3 covering
--    every berth.
DROP VIEW booking_view;
ALTER TABLE booking DROP CONSTRAINT booking_no_overlap;
ALTER TABLE booking DROP CONSTRAINT booking_berth_fk;
ALTER TABLE booking DROP COLUMN berth_kind;

-- CASCADE takes the CHECK ((kind = 'berth') = (length_ft IS NOT NULL)) and UNIQUE (project_id, id, kind) with it.
ALTER TABLE berth DROP COLUMN kind CASCADE;
ALTER TABLE berth ADD CONSTRAINT berth_project_id_id_key UNIQUE (project_id, id);   -- new FK target
ALTER TABLE booking ADD CONSTRAINT booking_berth_fk
  FOREIGN KEY (project_id, berth_id) REFERENCES berth (project_id, id);

CREATE VIEW booking_view AS
SELECT b.*,
       COALESCE(b.title, v.name) AS display_title,
       be.name                   AS berth_name,
       be.length_ft              AS berth_length_ft,
       v.length_ft               AS vessel_length_ft
FROM booking b
JOIN berth be      ON be.id = b.berth_id
LEFT JOIN vessel v ON v.id  = b.vessel_id;

-- 3. R2 for every berth, not just the ones that carried a length.
ALTER TABLE booking ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (berth_id WITH =, period WITH &&) WHERE (status = 'confirmed');

-- 4. The importer stages berths the same way: a length or nothing, no kind.
ALTER TABLE import_staged_berth DROP COLUMN kind CASCADE;

-- 5. clone_project copied both columns.
CREATE OR REPLACE FUNCTION clone_project(src uuid, new_name text, new_origin text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE dst uuid := gen_random_uuid();
BEGIN
  INSERT INTO project (id, name, origin, as_of_date)
  SELECT dst, new_name, new_origin, as_of_date FROM project WHERE id = src;
  IF NOT FOUND THEN RAISE EXCEPTION 'no project %', src USING ERRCODE = 'no_data_found'; END IF;

  CREATE TEMP TABLE berth_map  ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM berth  WHERE project_id = src;
  CREATE TEMP TABLE vessel_map ON COMMIT DROP AS SELECT id AS old_id, gen_random_uuid() AS new_id FROM vessel WHERE project_id = src;

  INSERT INTO berth (id, project_id, name, length_ft, active, sort_order)
  SELECT m.new_id, dst, b.name, b.length_ft, b.active, b.sort_order
  FROM berth b JOIN berth_map m ON m.old_id = b.id;

  INSERT INTO vessel (id, project_id, name, length_ft, draft_ft, operator, notes)
  SELECT m.new_id, dst, v.name, v.length_ft, v.draft_ft, v.operator, v.notes
  FROM vessel v JOIN vessel_map m ON m.old_id = v.id;

  INSERT INTO booking (project_id, berth_id, occupant_type, vessel_id, title,
                       start_date, end_date, status, source, notes)
  SELECT dst, bm.new_id, b.occupant_type, vm.new_id, b.title,
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
