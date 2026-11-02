import { DatabaseSync } from 'node:sqlite';

// Times are stored as epoch milliseconds (UTC). Overlap rule everywhere: a.start < b.end AND a.end > b.start.
const schema = `
CREATE TABLE IF NOT EXISTS dealerships (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  open_minute INTEGER NOT NULL CHECK (open_minute BETWEEN 0 AND 1440),
  close_minute INTEGER NOT NULL CHECK (close_minute BETWEEN 0 AND 1440 AND close_minute > open_minute)
);
CREATE TABLE IF NOT EXISTS service_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  required_skill TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS technicians (
  id TEXT PRIMARY KEY,
  dealership_id TEXT NOT NULL REFERENCES dealerships(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS technician_skills (
  technician_id TEXT NOT NULL REFERENCES technicians(id),
  skill TEXT NOT NULL,
  PRIMARY KEY (technician_id, skill)
);
CREATE TABLE IF NOT EXISTS service_bays (
  id TEXT PRIMARY KEY,
  dealership_id TEXT NOT NULL REFERENCES dealerships(id),
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT
);
CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vin TEXT NOT NULL UNIQUE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  dealership_id TEXT NOT NULL REFERENCES dealerships(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  service_type_id TEXT NOT NULL REFERENCES service_types(id),
  technician_id TEXT NOT NULL REFERENCES technicians(id),
  bay_id TEXT NOT NULL REFERENCES service_bays(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL CHECK (end_at > start_at),
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER
);
CREATE INDEX IF NOT EXISTS appointments_bay ON appointments (bay_id, start_at) WHERE status = 'CONFIRMED';
CREATE INDEX IF NOT EXISTS appointments_technician ON appointments (technician_id, start_at) WHERE status = 'CONFIRMED';
CREATE INDEX IF NOT EXISTS appointments_vehicle ON appointments (vehicle_id, start_at) WHERE status = 'CONFIRMED';
CREATE INDEX IF NOT EXISTS appointments_dealership ON appointments (dealership_id, start_at);

-- Last line of defence: even if application code has a bug, the database refuses a double booking.
-- (In PostgreSQL this would be an EXCLUDE USING gist constraint on tstzrange.)
CREATE TRIGGER IF NOT EXISTS appointments_no_bay_overlap
BEFORE INSERT ON appointments
WHEN NEW.status = 'CONFIRMED' AND EXISTS (
  SELECT 1 FROM appointments a
  WHERE a.status = 'CONFIRMED' AND a.bay_id = NEW.bay_id
    AND a.start_at < NEW.end_at AND a.end_at > NEW.start_at)
BEGIN SELECT RAISE(ABORT, 'BAY_DOUBLE_BOOKED'); END;

CREATE TRIGGER IF NOT EXISTS appointments_no_technician_overlap
BEFORE INSERT ON appointments
WHEN NEW.status = 'CONFIRMED' AND EXISTS (
  SELECT 1 FROM appointments a
  WHERE a.status = 'CONFIRMED' AND a.technician_id = NEW.technician_id
    AND a.start_at < NEW.end_at AND a.end_at > NEW.start_at)
BEGIN SELECT RAISE(ABORT, 'TECHNICIAN_DOUBLE_BOOKED'); END;

CREATE TRIGGER IF NOT EXISTS appointments_no_vehicle_overlap
BEFORE INSERT ON appointments
WHEN NEW.status = 'CONFIRMED' AND EXISTS (
  SELECT 1 FROM appointments a
  WHERE a.status = 'CONFIRMED' AND a.vehicle_id = NEW.vehicle_id
    AND a.start_at < NEW.end_at AND a.end_at > NEW.start_at)
BEGIN SELECT RAISE(ABORT, 'VEHICLE_DOUBLE_BOOKED'); END;
`;

export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(schema);
  return db;
}

// Reference data a dealership would normally manage in its DMS. Idempotent, so it is safe on every start.
export function seed(db: DatabaseSync): void {
  const rows: [string, unknown[][]][] = [
    ['INSERT OR IGNORE INTO dealerships VALUES (?, ?, ?, ?, ?)', [
      ['dlr-hcm', 'Keyloop Motors Ho Chi Minh City', 420, 8 * 60, 17 * 60],
      ['dlr-hn', 'Keyloop Motors Ha Noi', 420, 8 * 60, 17 * 60],
    ]],
    ['INSERT OR IGNORE INTO service_types VALUES (?, ?, ?, ?)', [
      ['svc-oil', 'Oil and filter change', 60, 'GENERAL'],
      ['svc-tyre', 'Tyre rotation', 45, 'GENERAL'],
      ['svc-brake', 'Brake inspection and repair', 90, 'BRAKES'],
      ['svc-ev', 'EV battery health check', 120, 'EV'],
    ]],
    ['INSERT OR IGNORE INTO technicians VALUES (?, ?, ?)', [
      ['tech-an', 'dlr-hcm', 'Nguyen Van An'],
      ['tech-binh', 'dlr-hcm', 'Tran Thi Binh'],
      ['tech-chi', 'dlr-hcm', 'Le Minh Chi'],
      ['tech-dung', 'dlr-hn', 'Pham Quoc Dung'],
    ]],
    ['INSERT OR IGNORE INTO technician_skills VALUES (?, ?)', [
      ['tech-an', 'GENERAL'], ['tech-an', 'BRAKES'],
      ['tech-binh', 'GENERAL'],
      ['tech-chi', 'GENERAL'], ['tech-chi', 'EV'],
      ['tech-dung', 'GENERAL'],
    ]],
    ['INSERT OR IGNORE INTO service_bays VALUES (?, ?, ?)', [
      ['bay-hcm-1', 'dlr-hcm', 'Bay 1'],
      ['bay-hcm-2', 'dlr-hcm', 'Bay 2'],
      ['bay-hn-1', 'dlr-hn', 'Bay 1'],
    ]],
    ['INSERT OR IGNORE INTO customers VALUES (?, ?, ?, ?)', [
      ['cus-1', 'Hoang Lan', 'lan@example.com', '+84900000001'],
      ['cus-2', 'Vo Tuan', 'tuan@example.com', '+84900000002'],
    ]],
    ['INSERT OR IGNORE INTO vehicles VALUES (?, ?, ?, ?, ?, ?)', [
      ['veh-1', 'cus-1', 'WVWZZZ1KZAW000001', 'Volkswagen', 'Golf', 2021],
      ['veh-2', 'cus-1', 'RLHFC2650MY000002', 'VinFast', 'VF 8', 2024],
      ['veh-3', 'cus-2', 'JTDKN3DU0A0000003', 'Toyota', 'Corolla Cross', 2022],
    ]],
  ];
  for (const [sql, values] of rows) {
    const stmt = db.prepare(sql);
    for (const v of values) stmt.run(...(v as never[]));
  }
}
