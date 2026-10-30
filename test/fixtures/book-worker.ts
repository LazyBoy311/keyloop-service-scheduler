// Runs one booking on its own database connection, so tests can race real concurrent writers.
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../src/db.ts';
import { BookingError, createScheduler } from '../../src/scheduler.ts';

const db = openDb(workerData.dbPath);
try {
  const { appointment } = createScheduler(db, () => workerData.now).book(workerData.req);
  parentPort!.postMessage(appointment.status);
} catch (err) {
  parentPort!.postMessage(err instanceof BookingError ? err.code : String(err));
} finally {
  db.close();
}
