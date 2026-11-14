import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface DeviceRow {
  id: string;
  name: string;
  token: string;
  identity: string | null;
  lastSeen: number;
  createdAt: number;
}

export interface TaskRow {
  id: string;
  deviceId: string;
  tool: string;
  input: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  result: string | null;
  error: string | null;
  runId: string | null;
  /** The idempotency key of the request that created the task, if one was given. */
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A task that has waited this long without being picked up never runs. */
export const TASK_TTL_MS = 24 * 60 * 60 * 1000;

export interface RunRow {
  id: string;
  deviceId: string;
  deviceName: string;
  tool: string;
  status: string;
  durationMs: number | null;
  startedAt: number;
  recordedAt: number;
}

/** Small SQLite wrapper for the relay. Uses Node's built-in driver so the
 * server needs no native build step. */
export class RelayStore {
  private readonly db: DatabaseSync;

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDirectory, 'relay.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
        identity TEXT, lastSeen INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
        status TEXT NOT NULL, result TEXT, error TEXT, runId TEXT, requestId TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, deviceName TEXT NOT NULL, tool TEXT NOT NULL,
        status TEXT NOT NULL, durationMs INTEGER, startedAt INTEGER NOT NULL, recordedAt INTEGER NOT NULL
      );
    `);
    // A database that was created before requestId existed keeps its tasks:
    // the column is added in place instead of rebuilding the table.
    const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'requestId')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN requestId TEXT');
    }
    // One idempotency key names one live task per device, so a request that
    // is sent twice cannot run twice. A task that already failed (including
    // one that expired) leaves the index, so the same key may be tried again.
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_device_request ON tasks(deviceId, requestId) WHERE requestId IS NOT NULL AND status != 'failed' AND status != 'cancelled'`);
  }

  addDevice(device: DeviceRow): void {
    this.db.prepare('INSERT INTO devices (id, name, token, identity, lastSeen, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(device.id, device.name, device.token, device.identity, device.lastSeen, device.createdAt);
  }

  deviceByToken(token: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE token = ?').get(token) as DeviceRow | undefined;
  }

  deviceById(id: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  devices(): DeviceRow[] {
    return this.db.prepare('SELECT id, name, identity, lastSeen, createdAt FROM devices ORDER BY createdAt').all() as unknown as DeviceRow[];
  }

  touchDevice(id: string, identity: string | null): void {
    this.db.prepare('UPDATE devices SET lastSeen = ?, identity = COALESCE(?, identity) WHERE id = ?')
      .run(Date.now(), identity, id);
  }

  removeDevice(id: string): void {
    this.db.prepare('DELETE FROM devices WHERE id = ?').run(id);
  }

  addTask(task: TaskRow): void {
    this.db.prepare('INSERT INTO tasks (id, deviceId, tool, input, status, result, error, runId, requestId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.deviceId, task.tool, task.input, task.status, task.result, task.error, task.runId, task.requestId ?? null, task.createdAt, task.updatedAt);
  }

  task(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  /** The live task that already carries this idempotency key, if there is one. */
  taskByRequestId(deviceId: string, requestId: string): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE deviceId = ? AND requestId = ? AND status != 'failed' AND status != 'cancelled' ORDER BY createdAt DESC LIMIT 1`)
      .get(deviceId, requestId) as TaskRow | undefined;
  }

  /**
   * Hands the oldest queued task of a device to the node that just polled,
   * and marks it running so a second poll cannot pick up the same task.
   * Returns the task, or undefined when nothing is queued.
   */
  claimQueuedTask(deviceId: string): TaskRow | undefined {
    const next = this.db.prepare(`SELECT * FROM tasks WHERE deviceId = ? AND status = 'queued' ORDER BY createdAt ASC LIMIT 1`)
      .get(deviceId) as TaskRow | undefined;
    if (!next) return undefined;
    const claimed = this.db.prepare(`UPDATE tasks SET status = 'running', updatedAt = ? WHERE id = ? AND status = 'queued'`)
      .run(Date.now(), next.id);
    if (Number(claimed.changes) === 0) return undefined;
    return { ...next, status: 'running' };
  }

  /**
   * Marks the queued tasks that have waited longer than the TTL as failed
   * instead of leaving them queued forever. Runs lazily on the read paths,
   * so no timer process is needed. Returns how many tasks expired.
   */
  expireQueuedTasks(deviceId?: string, now = Date.now()): number {
    const expiredAt = now - TASK_TTL_MS;
    const result = deviceId
      ? this.db.prepare(`UPDATE tasks SET status = 'failed', error = '任务已过期（超过 24 小时未执行）。', updatedAt = ? WHERE deviceId = ? AND status = 'queued' AND createdAt <= ?`)
          .run(now, deviceId, expiredAt)
      : this.db.prepare(`UPDATE tasks SET status = 'failed', error = '任务已过期（超过 24 小时未执行）。', updatedAt = ? WHERE status = 'queued' AND createdAt <= ?`)
          .run(now, expiredAt);
    return Number(result.changes);
  }

  updateTask(id: string, patch: Partial<Pick<TaskRow, 'status' | 'result' | 'error' | 'runId'>>): void {
    const current = this.task(id);
    if (!current) return;
    this.db.prepare('UPDATE tasks SET status = ?, result = ?, error = ?, runId = ?, updatedAt = ? WHERE id = ?')
      .run(patch.status ?? current.status, patch.result ?? current.result, patch.error ?? current.error,
        patch.runId ?? current.runId, Date.now(), id);
  }

  tasks(deviceId?: string, limit = 50): TaskRow[] {
    const rows = deviceId
      ? this.db.prepare('SELECT * FROM tasks WHERE deviceId = ? ORDER BY createdAt DESC LIMIT ?').all(deviceId, limit)
      : this.db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC LIMIT ?').all(limit);
    return rows as unknown as TaskRow[];
  }

  addRun(run: RunRow): void {
    this.db.prepare('INSERT OR REPLACE INTO runs (id, deviceId, deviceName, tool, status, durationMs, startedAt, recordedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, run.deviceId, run.deviceName, run.tool, run.status, run.durationMs, run.startedAt, run.recordedAt);
  }

  runs(limit = 50): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY recordedAt DESC LIMIT ?').all(limit) as unknown as RunRow[];
  }
}
