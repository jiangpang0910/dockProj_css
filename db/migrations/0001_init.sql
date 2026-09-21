-- 0001_init.sql — the whole schema. database.md explains it; this file is the source of truth.
-- Postgres 15+ (Neon). Run once per database by `npm run db:migrate`.

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets a GiST index mix `uuid WITH =` and `daterange WITH &&`

-- ─────────────────────────── projects ───────────────────────────
-- Everything else belongs to exactly one project. Deleting a project deletes all of it.

CREATE TABLE project (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (length(trim(name)) > 0),
  origin         text NOT NULL CHECK (origin IN ('sample', 'defaults', 'empty')),
  template_key   text UNIQUE CHECK (template_key IN ('sample', 'defaults')),  -- non-NULL = read-only template
  as_of_date     date,                                                       -- "today" override; NULL = real date
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_opened_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_idle ON project (last_opened_at) WHERE template_key IS NULL;   -- cleanup job

-- ─────────────────────────── reference data ───────────────────────────

CREATE TABLE berth (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  kind       text NOT NULL CHECK (kind IN ('berth', 'section')),
  length_ft  numeric(6, 1) CHECK (length_ft > 0),
  active     boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  CHECK ((kind = 'berth') = (length_ft IS NOT NULL)),       -- berths have a length, sections don't
  UNIQUE (project_id, id, kind)                              -- target of booking's composite FK
);
CREATE UNIQUE INDEX berth_name_uq ON berth (project_id, lower(name));

CREATE TABLE vessel (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  name       text NOT NULL CHECK (length(trim(name)) > 0),  -- stored normalised: trimmed, single spaces, "OS/V"→"OSV"
  length_ft  numeric(6, 1) CHECK (length_ft > 0),            -- NULL = unknown (legacy imports only)
  draft_ft   numeric(5, 1) CHECK (draft_ft > 0),
  operator   text,
  notes      text,
  UNIQUE (project_id, id)                                    -- target of booking's composite FK
);
CREATE UNIQUE INDEX vessel_name_uq ON vessel (project_id, lower(name));

-- ─────────────────────────── bookings ───────────────────────────

CREATE TABLE booking (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  berth_id      uuid NOT NULL,
  berth_kind    text NOT NULL,              -- copy of berth.kind, pinned by the FK below (see database.md §5)
  occupant_type text NOT NULL CHECK (occupant_type IN ('vessel', 'event', 'closure')),
  vessel_id     uuid,
  title         text CHECK (title IS NULL OR length(trim(title)) > 0),
  start_date    date NOT NULL,              -- INCLUSIVE
  end_date      date NOT NULL,              -- INCLUSIVE
  -- the CASE keeps a reversed range from erroring inside daterange() before booking_range_valid can name it
  period        daterange GENERATED ALWAYS AS
                  (CASE WHEN start_date <= end_date THEN daterange(start_date, end_date, '[]') END) STORED,
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  source        text NOT NULL CHECK (source IN ('manual', 'import')),
  notes         text,
  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT booking_range_valid CHECK (start_date <= end_date),                              -- R1
  CONSTRAINT booking_vessel_iff  CHECK ((occupant_type = 'vessel') = (vessel_id IS NOT NULL)),
  CONSTRAINT booking_title_iff   CHECK ((vessel_id IS NULL) = (title IS NOT NULL)),

  -- same project + true berth kind, in one FK. NO ACTION (not RESTRICT) so a project delete can cascade.
  CONSTRAINT booking_berth_fk  FOREIGN KEY (project_id, berth_id, berth_kind) REFERENCES berth (project_id, id, kind),
  CONSTRAINT booking_vessel_fk FOREIGN KEY (project_id, vessel_id) REFERENCES vessel (project_id, id),

  -- R2: no two confirmed bookings share a day on an exclusive berth
  CONSTRAINT booking_no_overlap EXCLUDE USING gist (berth_id WITH =, period WITH &&)
    WHERE (status = 'confirmed' AND berth_kind = 'berth'),
  -- R4: a vessel is in one place at a time (sections included)
  CONSTRAINT booking_vessel_once EXCLUDE USING gist (vessel_id WITH =, period WITH &&)
    WHERE (status = 'confirmed' AND vessel_id IS NOT NULL)
);
CREATE INDEX booking_window    ON booking USING gist (project_id, period) WHERE status = 'confirmed';  -- schedule grid
CREATE INDEX booking_by_berth  ON booking (berth_id);    -- "is this berth referenced?" (any status)
CREATE INDEX booking_by_vessel ON booking (vessel_id);   -- "is this vessel referenced?" (any status)

-- R3: vessel fits the berth. NULL length (unknown vessel, or a section) → comparison is NULL → passes;
-- the service blocks unknown lengths for manual bookings.
CREATE FUNCTION booking_fit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v numeric; b numeric;
BEGIN
  IF NEW.vessel_id IS NULL OR NEW.status <> 'confirmed' THEN RETURN NEW; END IF;
  SELECT length_ft INTO v FROM vessel WHERE id = NEW.vessel_id;
  SELECT length_ft INTO b FROM berth  WHERE id = NEW.berth_id;
  IF v > b THEN
    RAISE EXCEPTION 'VESSEL_TOO_LONG: vessel % ft > berth % ft', v, b
      USING ERRCODE = 'check_violation', CONSTRAINT = 'booking_fit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_fit BEFORE INSERT OR UPDATE OF berth_id, vessel_id, status ON booking
  FOR EACH ROW EXECUTE FUNCTION booking_fit();

-- R6: a length edit can't break an existing confirmed booking
CREATE FUNCTION vessel_length_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking b JOIN berth be ON be.id = b.berth_id
             WHERE b.vessel_id = NEW.id AND b.status = 'confirmed' AND be.length_ft < NEW.length_ft) THEN
    RAISE EXCEPTION 'VESSEL_TOO_LONG: new length % ft breaks a confirmed booking', NEW.length_ft
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vessel_length_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vessel_length_guard BEFORE UPDATE OF length_ft ON vessel
  FOR EACH ROW WHEN (NEW.length_ft IS DISTINCT FROM OLD.length_ft) EXECUTE FUNCTION vessel_length_guard();

CREATE FUNCTION berth_length_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM booking b JOIN vessel v ON v.id = b.vessel_id
             WHERE b.berth_id = NEW.id AND b.status = 'confirmed' AND v.length_ft > NEW.length_ft) THEN
    RAISE EXCEPTION 'VESSEL_TOO_LONG: new length % ft is shorter than a booked vessel', NEW.length_ft
      USING ERRCODE = 'check_violation', CONSTRAINT = 'berth_length_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER berth_length_guard BEFORE UPDATE OF length_ft ON berth
  FOR EACH ROW WHEN (NEW.length_ft IS DISTINCT FROM OLD.length_ft) EXECUTE FUNCTION berth_length_guard();

-- API shape: Booking.title is computed for vessel bookings (BCNF: the name lives on vessel only)
CREATE VIEW booking_view AS
SELECT b.*,
       COALESCE(b.title, v.name) AS display_title,
       be.name                   AS berth_name,
       be.length_ft              AS berth_length_ft,
       v.length_ft               AS vessel_length_ft
FROM booking b
JOIN berth be      ON be.id = b.berth_id
LEFT JOIN vessel v ON v.id  = b.vessel_id;

-- ─────────────────────────── import staging ───────────────────────────
-- An upload is parsed into these tables; nothing touches berth/vessel/booking until commit.

CREATE TABLE import_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
  filename     text NOT NULL,
  format       text NOT NULL CHECK (format IN ('legacy_grid', 'template')),
  status       text NOT NULL CHECK (status IN ('previewed', 'committed', 'discarded')),
  sheets       integer NOT NULL,            -- facts about the parse that can't be recomputed later
  cells        integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);

CREATE TABLE import_staged_berth (          -- berths the file defines (template sheet, or grid labels like "Name - 410'")
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id  uuid NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('berth', 'section')),
  length_ft  numeric(6, 1) CHECK (length_ft > 0),
  sort_order integer NOT NULL,
  CHECK ((kind = 'berth') = (length_ft IS NOT NULL))
);
CREATE UNIQUE INDEX import_staged_berth_uq ON import_staged_berth (import_id, lower(name));

CREATE TABLE import_staged_vessel (         -- one row per distinct vessel in the file
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
  name      text NOT NULL,
  length_ft numeric(6, 1) CHECK (length_ft > 0),
  draft_ft  numeric(5, 1) CHECK (draft_ft > 0),
  operator  text,
  notes     text
);
CREATE UNIQUE INDEX import_staged_vessel_uq ON import_staged_vessel (import_id, lower(name));

CREATE TABLE import_staged_booking (        -- rows that passed the rules; copied into booking on commit
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id        uuid NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
  berth_id         uuid REFERENCES berth (id),                                   -- an existing berth…
  staged_berth_id  uuid REFERENCES import_staged_berth (id) ON DELETE CASCADE,   -- …or one defined in this file
  occupant_type    text NOT NULL CHECK (occupant_type IN ('vessel', 'event', 'closure')),
  staged_vessel_id uuid REFERENCES import_staged_vessel (id) ON DELETE CASCADE,
  title            text,
  start_date       date NOT NULL,
  end_date         date NOT NULL CHECK (start_date <= end_date),
  notes            text,
  CHECK (num_nonnulls(berth_id, staged_berth_id) = 1),
  CHECK ((occupant_type = 'vessel') = (staged_vessel_id IS NOT NULL)),
  CHECK ((staged_vessel_id IS NULL) = (title IS NOT NULL))
);

CREATE TABLE import_issue (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         uuid NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
  code              text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
  sheet             text NOT NULL,
  cell              text,
  message           text NOT NULL,
  -- the parsed row, when there is one (all NULL otherwise): what the file said, mistakes included
  row_berth_label   text,
  row_occupant_type text CHECK (row_occupant_type IN ('vessel', 'event', 'closure')),
  row_title         text,
  row_start_date    date,
  row_end_date      date,
  resolution        text CHECK (resolution IN ('created', 'dismissed')),   -- NULL = open
  resolution_note   text
);
CREATE INDEX import_issue_by_run ON import_issue (import_id, severity, resolution);

-- ─────────────────────────── cloning a template ───────────────────────────
-- "Open the sample" / "Start from the default fleet" = copy a template project into a fresh one.
-- One statement from the app: SELECT clone_project(:templateId, :name, :origin).

CREATE FUNCTION clone_project(src uuid, new_name text, new_origin text) RETURNS uuid
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

  DROP TABLE berth_map, vessel_map;
  RETURN dst;
END $$;
