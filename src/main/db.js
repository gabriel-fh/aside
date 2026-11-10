// Historico local em SQLite, usando o modulo embutido do Node (sem dependencia nativa).

const { app } = require('electron');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db = null;

function open() {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath('userData'), 'aside.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      title TEXT,
      summary TEXT,
      assistant TEXT,
      model TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      speaker TEXT,
      text TEXT NOT NULL,
      extra TEXT,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS entries_session ON entries(session_id, ts);
  `);
  return db;
}

function createSession({ assistant, model }) {
  const r = open()
    .prepare('INSERT INTO sessions (started_at, assistant, model) VALUES (?, ?, ?)')
    .run(Date.now(), assistant || null, model || null);
  return Number(r.lastInsertRowid);
}

function endSession(id) {
  open().prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);
}

function closeDangling() {
  open().prepare('UPDATE sessions SET ended_at = started_at WHERE ended_at IS NULL').run();
}

function addEntry(sessionId, { kind, speaker = null, text, extra = null, ts = Date.now() }) {
  if (!sessionId || !text) return;
  open()
    .prepare('INSERT INTO entries (session_id, kind, speaker, text, extra, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, kind, speaker, text, extra, ts);
}

function setSummary(id, title, summary) {
  open().prepare('UPDATE sessions SET title = ?, summary = ? WHERE id = ?').run(title, summary, id);
}

function listSessions(query) {
  const q = String(query || '').trim();
  const base = `
    SELECT s.*, (SELECT COUNT(*) FROM entries e WHERE e.session_id = s.id) AS entry_count
    FROM sessions s`;
  if (!q) return open().prepare(`${base} ORDER BY s.started_at DESC LIMIT 200`).all();
  const like = `%${q}%`;
  return open()
    .prepare(
      `${base}
       WHERE s.title LIKE ? OR s.summary LIKE ?
          OR EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.text LIKE ?)
       ORDER BY s.started_at DESC LIMIT 200`
    )
    .all(like, like, like);
}

function getSession(id) {
  const session = open().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return null;
  const entries = open().prepare('SELECT * FROM entries WHERE session_id = ? ORDER BY ts, id').all(id);
  return { session, entries };
}

function deleteSession(id) {
  open().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

module.exports = {
  open,
  createSession,
  endSession,
  closeDangling,
  addEntry,
  setSummary,
  listSessions,
  getSession,
  deleteSession,
};
