// Mutation testing: break one piece of business logic at a time and check that the test suite fails.
// A mutation that "survives" (tests still pass) points at logic no test really checks.
// Usage: npm run mutation   (edits src/ in place and restores each file; run on a clean working tree)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// [file in src/, description, original code, mutated code]
const mutations = [
  ['scheduler.ts', 'technician overlap uses <= (breaks back-to-back)', "WHERE a.technician_id = t.id AND a.status = 'CONFIRMED'\n           AND a.start_at < ?", "WHERE a.technician_id = t.id AND a.status = 'CONFIRMED'\n           AND a.start_at <= ?"],
  ['scheduler.ts', 'ignore technician skill', 'JOIN technician_skills s ON s.technician_id = t.id AND s.skill = ?', 'JOIN technician_skills s ON s.technician_id = t.id AND (s.skill = ? OR 1)'],
  ['scheduler.ts', 'ignore bay occupancy', 'WHERE a.bay_id = b.id AND', "WHERE a.bay_id = 'none' AND"],
  ['scheduler.ts', 'ignore technician occupancy', 'WHERE a.technician_id = t.id AND', "WHERE a.technician_id = 'none' AND"],
  ['scheduler.ts', 'cancelled appointments still block', "a.bay_id = b.id AND a.status = 'CONFIRMED'", 'a.bay_id = b.id'],
  ['scheduler.ts', 'deferred transaction instead of write lock', "db.exec('BEGIN IMMEDIATE')", "db.exec('BEGIN')"],
  ['scheduler.ts', 'no vehicle clash check', 'if (clash) throw', 'if (false) throw'],
  ['scheduler.ts', 'no qualified-technician check', 'if (!qualified?.n)', 'if (false)'],
  ['scheduler.ts', 'service may end after closing', 'localMinute + duration > dealership.close_minute', 'localMinute > dealership.close_minute'],
  ['scheduler.ts', 'closing time exclusive (off by one)', 'localMinute + duration > dealership.close_minute', 'localMinute + duration >= dealership.close_minute'],
  ['scheduler.ts', 'start == now accepted', 'if (start <= now())', 'if (start < now())'],
  ['scheduler.ts', 'time zone sign flipped', 'start / MINUTE + dealership.utc_offset_minutes', 'start / MINUTE - dealership.utc_offset_minutes'],
  ['scheduler.ts', 'no 15-minute grid', 'if (start % (SLOT_MINUTES * MINUTE) !== 0)', 'if (false)'],
  ['scheduler.ts', 'idempotency ignores body', 'if (!same) throw', 'if (false) throw'],
  ['scheduler.ts', 'idempotency key ignored', 'if (idempotencyKey) {', 'if (false) {'],
  ['scheduler.ts', 'cancel counts already-cancelled', "WHERE id = ? AND status = 'CONFIRMED'", 'WHERE id = ?'],
  ['scheduler.ts', 'trigger error not mapped to SLOT_TAKEN', '/DOUBLE_BOOKED/.test(err.message)', 'false'],
  ['scheduler.ts', 'last-assigned bay instead of first', 'bays[0].id', 'bays[bays.length - 1].id'],
  ['db.ts', 'no bay trigger', "BEGIN SELECT RAISE(ABORT, 'BAY_DOUBLE_BOOKED'); END;", 'BEGIN SELECT 1; END;'],
  ['db.ts', 'no technician trigger', "BEGIN SELECT RAISE(ABORT, 'TECHNICIAN_DOUBLE_BOOKED'); END;", 'BEGIN SELECT 1; END;'],
  ['db.ts', 'no vehicle trigger', "BEGIN SELECT RAISE(ABORT, 'VEHICLE_DOUBLE_BOOKED'); END;", 'BEGIN SELECT 1; END;'],
  ['app.ts', 'unknown fields silently dropped', 'ajv: { customOptions: { removeAdditional: false } },', ''],
  ['app.ts', 'client errors reported as 500', 'if (e.statusCode && e.statusCode < 500) {', 'if (false) {'],
  ['app.ts', 'replay returns 201', 'reply.status(replayed ? 200 : 201)', 'reply.status(201)'],
  ['app.ts', 'cancel metric always increments', 'if (changed) inc(', 'if (true) inc('],
  ['scheduler.ts', 'bay overlap uses <=', "WHERE a.bay_id = b.id AND a.status = 'CONFIRMED'\n           AND a.start_at < ?", "WHERE a.bay_id = b.id AND a.status = 'CONFIRMED'\n           AND a.start_at <= ?"],
  ['scheduler.ts', 'vehicle overlap uses <=', "vehicle_id = ? AND status = 'CONFIRMED' AND start_at < ?", "vehicle_id = ? AND status = 'CONFIRMED' AND start_at <= ?"],
  ['scheduler.ts', 'availability ignores bays', 'available: technicians.length > 0 && bays.length > 0', 'available: technicians.length > 0'],
  ['scheduler.ts', 'list filter from inclusive broken', 'a.start_at >= ? AND a.start_at < ?', 'a.start_at > ? AND a.start_at < ?'],
  ['scheduler.ts', 'customer taken from request, not vehicle owner', 'customerId, req.vehicleId', "'cus-1', req.vehicleId"],
  ['db.ts', 'bay trigger uses <=', "a.bay_id = NEW.bay_id\n    AND a.start_at < NEW.end_at", "a.bay_id = NEW.bay_id\n    AND a.start_at <= NEW.end_at"],
];

if (execFileSync('git', ['status', '--porcelain', 'src'], { cwd: root }).length) {
  console.error('src/ has uncommitted changes; commit or stash them first.');
  process.exit(2);
}

const runTests = () => String(execFileSync(process.execPath,
  ['--disable-warning=ExperimentalWarning', '--test', 'test/*.test.ts'], { cwd: root, stdio: 'pipe', timeout: 120_000 }));

// Baseline: the unmutated code must pass, otherwise every mutation would look "caught".
console.log(`baseline: ${runTests().match(/^ℹ pass (\d+)/m)[1]} tests pass on unmutated code\n`);

let caught = 0, ran = 0;
for (const [file, name, rawFrom, rawTo] of mutations) {
  const path = `${root}src/${file}`;
  const original = readFileSync(path, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const from = rawFrom.replaceAll('\n', eol), to = rawTo.replaceAll('\n', eol);
  if (!original.includes(from)) { console.log(`SKIP     ${name} (code changed, update this mutation)`); continue; }
  ran++;
  writeFileSync(path, original.replace(from, to));
  let failing = '';
  try {
    runTests();
  } catch (e) {
    failing = (String(e.stdout).match(/^ℹ fail (\d+)/m) ?? [])[1] ?? 'crash';
  } finally {
    writeFileSync(path, original);
  }
  if (failing) caught++;
  console.log(`${failing ? 'CAUGHT  ' : 'SURVIVED'} ${name}${failing ? `  (${failing} failing)` : ''}`);
}
console.log(`\n${caught}/${ran} mutations caught`);
process.exit(caught === ran ? 0 : 1);
