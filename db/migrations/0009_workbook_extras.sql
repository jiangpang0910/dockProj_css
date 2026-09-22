-- 0009: everything else the legacy workbook holds. The Tours tab (guided visits aboard vessels: they hold no berth,
-- so they are their own records) and the 8-year usage summary (days per berth per year, as the facility counted
-- them). Both ride along with an import: parsed on upload, stored on the run, written to the project on commit.
ALTER TABLE import_run ADD COLUMN extras jsonb;    -- {tours: [...], usage: [...]} as the parser returned them

CREATE TABLE tour (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  date        date NOT NULL,
  time        text,                                 -- "15:30", or the sheet's own words ("tbd")
  guide       text,
  guest       text,
  people      integer CHECK (people IS NULL OR people >= 0),
  vessel_name text,                                 -- as written; not a FK, the vessel may not be on record
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tour_project_date ON tour (project_id, date, time);
-- the same tour stated twice (two commits of the same workbook) is one tour
CREATE UNIQUE INDEX tour_dedupe ON tour (project_id, date, coalesce(time, ''), coalesce(guide, ''), coalesce(guest, ''), coalesce(vessel_name, ''));

CREATE TABLE berth_usage (
  project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  berth_name text NOT NULL,                         -- as written in the summary; "Marsh Landing" has no berth row
  year       integer NOT NULL,
  days       integer NOT NULL CHECK (days >= 0),
  PRIMARY KEY (project_id, berth_name, year)
);
