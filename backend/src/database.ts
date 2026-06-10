import Database, { Database as DB } from 'better-sqlite3';
import { EventEmitter } from 'events';
import { config } from './config';
import { Task, TaskStatus } from './types';

const db: DB = new Database(config.databasePath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    progress REAL DEFAULT 0,
    speed TEXT,
    eta TEXT,
    filesize TEXT,
    thumbnail TEXT,
    uploader TEXT,
    format TEXT,
    path TEXT,
    error TEXT,
    note TEXT,
    options TEXT,
    createdAt INTEGER,
    updatedAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

// Migrate older databases that predate newer columns.
const existingCols = new Set(
  db.prepare('PRAGMA table_info(tasks)').all().map((c: any) => c.name),
);
for (const col of ['note', 'options']) {
  if (!existingCols.has(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
}

export const taskEvents = new EventEmitter();

const ALLOWED_TASK_KEYS = new Set([
  'title', 'status', 'progress', 'speed', 'eta', 'filesize',
  'thumbnail', 'uploader', 'format', 'path', 'error', 'note', 'options',
]);

export const tasks = {
  create: (task: Partial<Task>) => {
    const stmt = db.prepare(`
      INSERT INTO tasks (id, url, title, status, progress, format, options, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    stmt.run(
      task.id, task.url, task.title, task.status, task.progress || 0,
      task.format ?? null, task.options ?? null, now, now,
    );
    const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task;
    taskEvents.emit('task:created', created);
  },

  update: (id: string, updates: Partial<Task>) => {
    const safeUpdates = Object.fromEntries(
      Object.entries(updates).filter(([k]) => ALLOWED_TASK_KEYS.has(k))
    );
    if (Object.keys(safeUpdates).length === 0) return;

    const keys = Object.keys(safeUpdates);
    const sets = keys.map(k => `"${k}" = ?`).join(', ');
    const values = keys.map(k => (safeUpdates as any)[k]);
    db.prepare(`UPDATE tasks SET ${sets}, updatedAt = ? WHERE id = ?`).run(...values, Date.now(), id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (updated) taskEvents.emit('task:updated', updated);
  },

  getById: (id: string): Task | undefined => {
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
  },

  getAll: (): Task[] => {
    return db.prepare('SELECT * FROM tasks ORDER BY createdAt DESC').all() as Task[];
  },

  delete: (id: string) => {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  },

  getPending: (): Task[] => {
    return db.prepare(
      "SELECT * FROM tasks WHERE status IN ('queued', 'extracting', 'downloading', 'processing')"
    ).all() as Task[];
  },

  claimNext: (): Task | null => {
    return (db.transaction(() => {
      const task = db.prepare(
        "SELECT * FROM tasks WHERE status = 'queued' ORDER BY createdAt ASC LIMIT 1"
      ).get() as Task | undefined;
      if (!task) return null;
      const now = Date.now();
      db.prepare("UPDATE tasks SET status = 'downloading', updatedAt = ? WHERE id = ?").run(now, task.id);
      const claimed = { ...task, status: 'downloading' as TaskStatus, updatedAt: now };
      taskEvents.emit('task:updated', claimed);
      return claimed;
    }))();
  },

  resetStaleTasks: (): number => {
    const result = db.prepare(
      "UPDATE tasks SET status = 'queued', progress = 0, updatedAt = ? WHERE status IN ('downloading', 'extracting', 'processing')"
    ).run(Date.now());
    return result.changes;
  },
};

export function closeDatabase() {
  db.close();
}

export default db;
