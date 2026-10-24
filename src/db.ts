import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Database } from "bun:sqlite"

export interface FileRow {
  id: string
  session_id: string
  file_name: string
  content_type: string
  size: number
  storage_key: string
  uploader: string
  created_at: number
  expires_at: number
}

export interface FileIndex {
  insert(row: FileRow): void
  get(sessionId: string, fileId: string): FileRow | null
  list(sessionId: string, limit: number, offset: number): FileRow[]
  delete(sessionId: string, fileId: string): FileRow | null
  /** Delete every row for a session. Returns the removed rows (for blob cleanup). */
  deleteSession(sessionId: string): FileRow[]
  /** Delete rows with expires_at <= now. Returns the removed rows (for blob cleanup). */
  deleteExpired(now: number): FileRow[]
  /** Total stored bytes across ALL sessions (basis for the global storage quota). */
  totalBytes(): number
  close(): void
}

/**
 * Persistent SQLite index. The upstream demo kept this state in memory, so a
 * restart orphaned every blob; here the index lives in a file next to the
 * blobs and survives restarts.
 */
export function openFileIndex(path: string): FileIndex {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    uploader TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`)
  db.exec("CREATE INDEX IF NOT EXISTS idx_files_session ON files (session_id, created_at)")

  const insertStmt = db.prepare(
    "INSERT INTO files (id, session_id, file_name, content_type, size, storage_key, uploader, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  const getStmt = db.prepare("SELECT * FROM files WHERE session_id = ? AND id = ?")
  const listStmt = db.prepare("SELECT * FROM files WHERE session_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?")
  const deleteGetStmt = db.prepare("SELECT * FROM files WHERE session_id = ? AND id = ?")
  const deleteStmt = db.prepare("DELETE FROM files WHERE session_id = ? AND id = ?")
  const sessionRowsStmt = db.prepare("SELECT * FROM files WHERE session_id = ?")
  const sessionDeleteStmt = db.prepare("DELETE FROM files WHERE session_id = ?")
  const expiredRowsStmt = db.prepare("SELECT * FROM files WHERE expires_at <= ?")
  const totalBytesStmt = db.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files")
  const expiredDeleteStmt = db.prepare("DELETE FROM files WHERE expires_at <= ?")

  return {
    insert(row) {
      insertStmt.run(
        row.id,
        row.session_id,
        row.file_name,
        row.content_type,
        row.size,
        row.storage_key,
        row.uploader,
        row.created_at,
        row.expires_at,
      )
    },
    get: (sessionId, fileId) => (getStmt.get(sessionId, fileId) as FileRow | null) ?? null,
    list: (sessionId, limit, offset) => listStmt.all(sessionId, limit, offset) as FileRow[],
    delete(sessionId, fileId) {
      const row = (deleteGetStmt.get(sessionId, fileId) as FileRow | null) ?? null
      if (row) deleteStmt.run(sessionId, fileId)
      return row
    },
    deleteSession(sessionId) {
      const rows = sessionRowsStmt.all(sessionId) as FileRow[]
      if (rows.length > 0) sessionDeleteStmt.run(sessionId)
      return rows
    },
    totalBytes() {
      return (totalBytesStmt.get() as { total: number }).total
    },
    deleteExpired(now) {
      const rows = expiredRowsStmt.all(now) as FileRow[]
      if (rows.length > 0) expiredDeleteStmt.run(now)
      return rows
    },
    close() {
      db.close()
    },
  }
}
