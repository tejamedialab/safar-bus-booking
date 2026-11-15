-- =====================================================================
-- Safar · Bus Booking Management System · initial schema
-- Money is stored as integer paise (₹1 = 100 paise) to avoid float errors.
-- All timestamps are timestamptz; the business timezone is Asia/Kolkata.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets GiST exclusion constraints use "=" on uuid/text

CREATE TYPE user_role       AS ENUM ('ADMIN', 'OPERATOR', 'PASSENGER');
CREATE TYPE seat_type       AS ENUM ('SEATER', 'SLEEPER');
CREATE TYPE bus_type        AS ENUM ('AC_SLEEPER', 'NON_AC_SLEEPER', 'AC_SEATER', 'NON_AC_SEATER', 'VOLVO_MULTI_AXLE');
CREATE TYPE trip_status     AS ENUM ('SCHEDULED', 'DEPARTED', 'COMPLETED', 'CANCELLED');
CREATE TYPE booking_status  AS ENUM ('CONFIRMED', 'PARTIALLY_CANCELLED', 'CANCELLED');
CREATE TYPE ticket_status   AS ENUM ('CONFIRMED', 'CANCELLED');
CREATE TYPE refund_status   AS ENUM ('PENDING', 'PROCESSED', 'FAILED');
CREATE TYPE refund_reason   AS ENUM ('PASSENGER_CANCELLATION', 'TRIP_CANCELLED');
CREATE TYPE gender          AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- ---------------------------------------------------------------------
-- Cancellation policy (configurable per operator)
-- ---------------------------------------------------------------------
CREATE TABLE cancellation_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  -- rules: [{ "minHoursBeforeDeparture": 48, "refundPercent": 90 }, ...]
  -- A cancellation is allowed only if some rule matches; the highest matching tier wins.
  rules       jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) > 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Operators and users
-- ---------------------------------------------------------------------
CREATE TABLE operators (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 120),
  code                    text NOT NULL CHECK (code ~ '^[A-Z]{2,5}$'),
  contact_email           text NOT NULL,
  contact_phone           text NOT NULL,
  is_active               boolean NOT NULL DEFAULT true,
  cancellation_policy_id  uuid NOT NULL REFERENCES cancellation_policies(id),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operators_code_uq ON operators (code);
CREATE UNIQUE INDEX operators_name_uq ON operators (lower(name));

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  password_hash  text NOT NULL,
  full_name      text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 100),
  phone          text,
  role           user_role NOT NULL,
  operator_id    uuid REFERENCES operators(id),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- operator staff must belong to exactly one operator; nobody else may
  CONSTRAINT users_operator_scope_ck CHECK ((role = 'OPERATOR') = (operator_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_uq ON users (email);
CREATE INDEX users_operator_idx ON users (operator_id);

-- ---------------------------------------------------------------------
-- Fleet: seat layouts and buses
-- ---------------------------------------------------------------------
CREATE TABLE seat_layouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid REFERENCES operators(id),          -- NULL = shared template
  name         text NOT NULL,
  decks        smallint NOT NULL CHECK (decks IN (1, 2)),
  grid_rows    smallint NOT NULL CHECK (grid_rows BETWEEN 1 AND 20),
  grid_cols    smallint NOT NULL CHECK (grid_cols BETWEEN 1 AND 6),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE layout_seats (
  layout_id    uuid NOT NULL REFERENCES seat_layouts(id) ON DELETE CASCADE,
  label        text NOT NULL CHECK (label ~ '^[A-Z0-9]{1,5}$'),
  deck         smallint NOT NULL CHECK (deck IN (1, 2)),   -- 1 = lower, 2 = upper
  grid_row     smallint NOT NULL,
  grid_col     smallint NOT NULL,
  seat_type    seat_type NOT NULL,
  is_window    boolean NOT NULL DEFAULT false,
  fare_factor  numeric(4, 2) NOT NULL DEFAULT 1.00 CHECK (fare_factor BETWEEN 0.50 AND 3.00),
  PRIMARY KEY (layout_id, label),
  UNIQUE (layout_id, deck, grid_row, grid_col)
);

CREATE TABLE buses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id      uuid NOT NULL REFERENCES operators(id),
  registration_no  text NOT NULL CHECK (registration_no ~ '^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$'),
  bus_type         bus_type NOT NULL,
  seat_layout_id   uuid NOT NULL REFERENCES seat_layouts(id),
  amenities        text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX buses_registration_uq ON buses (registration_no);
CREATE INDEX buses_operator_idx ON buses (operator_id);

-- ---------------------------------------------------------------------
-- Network: cities, routes and stops
-- ---------------------------------------------------------------------
CREATE TABLE cities (
  id     serial PRIMARY KEY,
  name   text NOT NULL,
  state  text NOT NULL
);
CREATE UNIQUE INDEX cities_name_uq ON cities (lower(name));

CREATE TABLE routes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id  uuid NOT NULL REFERENCES operators(id),
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9-]{3,20}$'),
  name         text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, code)
);

-- A route is an ordered list of stops. Each stop is a boarding/drop point in a city.
-- Offsets are minutes from the trip's origin departure; fares/distances are cumulative from the origin,
-- so the fare between stop i and stop j is cumulative_fare[j] - cumulative_fare[i].
CREATE TABLE route_stops (
  route_id              uuid NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  stop_order            smallint NOT NULL CHECK (stop_order >= 0),
  city_id               int NOT NULL REFERENCES cities(id),
  point_name            text NOT NULL,
  arrival_offset_min    int NOT NULL CHECK (arrival_offset_min >= 0),
  departure_offset_min  int NOT NULL,
  distance_km           int NOT NULL CHECK (distance_km >= 0),
  cumulative_fare_paise int NOT NULL CHECK (cumulative_fare_paise >= 0),
  PRIMARY KEY (route_id, stop_order),
  CHECK (departure_offset_min >= arrival_offset_min)
);
CREATE INDEX route_stops_city_idx ON route_stops (city_id, route_id);

-- ---------------------------------------------------------------------
-- Schedules (recurring timetable) and trips (one dated run of a schedule)
-- ---------------------------------------------------------------------
CREATE TABLE schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id         uuid NOT NULL REFERENCES routes(id),
  bus_id           uuid NOT NULL REFERENCES buses(id),
  departure_time   time NOT NULL,                       -- local (Asia/Kolkata) time at origin
  days_of_week     smallint[] NOT NULL CHECK (days_of_week <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(days_of_week) > 0),  -- 0 = Sunday
  fare_multiplier  numeric(4, 2) NOT NULL DEFAULT 1.00 CHECK (fare_multiplier BETWEEN 0.50 AND 3.00),
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_route_idx ON schedules (route_id);

CREATE TABLE trips (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id      uuid NOT NULL REFERENCES schedules(id),
  route_id         uuid NOT NULL REFERENCES routes(id),
  bus_id           uuid NOT NULL REFERENCES buses(id),
  seat_layout_id   uuid NOT NULL REFERENCES seat_layouts(id),   -- snapshot of the bus layout at generation time
  service_date     date NOT NULL,                                -- local date of origin departure
  departs_at       timestamptz NOT NULL,
  arrives_at       timestamptz NOT NULL,
  fare_multiplier  numeric(4, 2) NOT NULL,
  status           trip_status NOT NULL DEFAULT 'SCHEDULED',
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (arrives_at > departs_at),
  UNIQUE (schedule_id, service_date),
  UNIQUE (id, seat_layout_id),                                  -- target for composite FKs below
  -- The same physical bus can never run two overlapping trips.
  CONSTRAINT trips_bus_no_overlap EXCLUDE USING gist (
    bus_id WITH =, tstzrange(departs_at, arrives_at) WITH &&
  ) WHERE (status <> 'CANCELLED')
);
CREATE INDEX trips_route_departs_idx ON trips (route_id, departs_at) WHERE status = 'SCHEDULED';
CREATE INDEX trips_departs_idx ON trips (departs_at);

-- ---------------------------------------------------------------------
-- Seat holds: short-lived reservations while the passenger fills the form.
-- A hold covers a stop segment [from_stop, to_stop) for one seat.
-- ---------------------------------------------------------------------
CREATE TABLE seat_holds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_token   uuid NOT NULL,
  trip_id      uuid NOT NULL,
  layout_id    uuid NOT NULL,
  seat_label   text NOT NULL,
  from_stop    smallint NOT NULL,
  to_stop      smallint NOT NULL,
  segment      int4range GENERATED ALWAYS AS (int4range(from_stop, to_stop)) STORED,
  user_id      uuid NOT NULL REFERENCES users(id),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (to_stop > from_stop),
  FOREIGN KEY (trip_id, layout_id) REFERENCES trips (id, seat_layout_id) ON DELETE CASCADE,
  FOREIGN KEY (layout_id, seat_label) REFERENCES layout_seats (layout_id, label),
  -- Two holds may not overlap on the same seat and segment. Expired holds are purged
  -- inside the same transaction before a new hold is inserted.
  CONSTRAINT seat_holds_no_overlap EXCLUDE USING gist (
    trip_id WITH =, seat_label WITH =, segment WITH &&
  )
);
CREATE INDEX seat_holds_token_idx ON seat_holds (hold_token);
CREATE INDEX seat_holds_expiry_idx ON seat_holds (trip_id, expires_at);

-- ---------------------------------------------------------------------
-- Bookings (one PNR) and tickets (one seat + one passenger each)
-- ---------------------------------------------------------------------
CREATE TABLE bookings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pnr                   text NOT NULL CHECK (pnr ~ '^[A-Z0-9]{10}$'),
  user_id               uuid NOT NULL REFERENCES users(id),
  trip_id               uuid NOT NULL REFERENCES trips(id),
  from_stop             smallint NOT NULL,
  to_stop               smallint NOT NULL,
  status                booking_status NOT NULL DEFAULT 'CONFIRMED',
  total_fare_paise      int NOT NULL CHECK (total_fare_paise > 0),
  contact_email         text NOT NULL,
  contact_phone         text NOT NULL,
  hold_token            uuid NOT NULL,             -- a hold can be converted to a booking only once
  policy_snapshot       jsonb NOT NULL,            -- cancellation rules in force at booking time
  payment_reference     text NOT NULL,             -- simulated payment
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (to_stop > from_stop)
);
CREATE UNIQUE INDEX bookings_pnr_uq ON bookings (pnr);
CREATE UNIQUE INDEX bookings_hold_token_uq ON bookings (hold_token);
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_trip_idx ON bookings (trip_id);
CREATE INDEX bookings_created_idx ON bookings (created_at);

CREATE TABLE refunds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES bookings(id),
  amount_paise  int NOT NULL CHECK (amount_paise >= 0),
  percent       smallint NOT NULL CHECK (percent BETWEEN 0 AND 100),
  reason        refund_reason NOT NULL,
  status        refund_status NOT NULL DEFAULT 'PENDING',
  reference     text,                            -- simulated gateway reference once processed
  failure_note  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_booking_idx ON refunds (booking_id);
CREATE INDEX refunds_status_idx ON refunds (status, created_at);

CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id      uuid NOT NULL REFERENCES bookings(id),
  trip_id         uuid NOT NULL,
  layout_id       uuid NOT NULL,
  seat_label      text NOT NULL,
  from_stop       smallint NOT NULL,
  to_stop         smallint NOT NULL,
  segment         int4range GENERATED ALWAYS AS (int4range(from_stop, to_stop)) STORED,
  passenger_name  text NOT NULL CHECK (length(trim(passenger_name)) BETWEEN 2 AND 80),
  passenger_age   smallint NOT NULL CHECK (passenger_age BETWEEN 1 AND 120),
  passenger_gender gender NOT NULL,
  fare_paise      int NOT NULL CHECK (fare_paise > 0),
  status          ticket_status NOT NULL DEFAULT 'CONFIRMED',
  refund_id       uuid REFERENCES refunds(id),
  cancelled_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (to_stop > from_stop),
  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  -- the seat must exist in THIS trip's layout (composite FKs, enforced by the database)
  FOREIGN KEY (trip_id, layout_id) REFERENCES trips (id, seat_layout_id),
  FOREIGN KEY (layout_id, seat_label) REFERENCES layout_seats (layout_id, label),
  -- THE core integrity rule: a seat can never be confirmed twice for overlapping stop segments
  -- on the same trip, no matter how many requests race. Cancelled tickets free the seat.
  CONSTRAINT tickets_no_double_booking EXCLUDE USING gist (
    trip_id WITH =, seat_label WITH =, segment WITH &&
  ) WHERE (status = 'CONFIRMED')
);
CREATE INDEX tickets_booking_idx ON tickets (booking_id);
CREATE INDEX tickets_trip_status_idx ON tickets (trip_id, status);

-- ---------------------------------------------------------------------
-- Idempotency keys: a retried POST with the same key returns the original response.
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id          uuid NOT NULL REFERENCES users(id),
  key              text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  request_hash     text NOT NULL,
  response_status  smallint,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------------
-- Audit trail (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  actor_id     uuid REFERENCES users(id),
  actor_role   user_role,
  operator_id  uuid REFERENCES operators(id),      -- lets operators see their own trail
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}',
  request_id   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_operator_idx ON audit_logs (operator_id, created_at DESC);

CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
