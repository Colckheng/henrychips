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
  createdAt: number;
  updatedAt: number;
}

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
        status TEXT NOT NULL, result TEXT, error TEXT, runId TEXT,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, deviceName TEXT NOT NULL, tool TEXT NOT NULL,
        status TEXT NOT NULL, durationMs INTEGER, startedAt INTEGER NOT NULL, recordedAt INTEGER NOT NULL
      );
    `);
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
    this.db.prepare('INSERT INTO tasks (id, deviceId, tool, input, status, result, error, runId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.deviceId, task.tool, task.input, task.status, task.result, task.error, task.runId, task.createdAt, task.updatedAt);
  }

  task(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
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
