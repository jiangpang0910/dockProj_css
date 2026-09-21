-- 0005: deleting a project (by hand or the idle cleanup) failed when one of its imports had staged rows pointing at
-- an existing berth: that FK had no ON DELETE action, and Postgres checked it before the cascade from import_run
-- reached the staged rows. A staged row whose berth is gone is meaningless, so it goes with the berth.
ALTER TABLE import_staged_booking DROP CONSTRAINT import_staged_booking_berth_id_fkey;
ALTER TABLE import_staged_booking ADD CONSTRAINT import_staged_booking_berth_id_fkey
  FOREIGN KEY (berth_id) REFERENCES berth (id) ON DELETE CASCADE;
