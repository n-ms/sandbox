/**
 * IronLog — IndexedDB Module
 * Wraps the `idb` library for all local persistence.
 *
 * CDN: https://cdn.jsdelivr.net/npm/idb@8/build/umd.js
 * Imported via importmap in index.html so we can use bare specifiers.
 */

// idb is loaded globally via CDN UMD build; the importmap in index.html maps
// the "idb" specifier to the CDN URL so this import works with ES modules.
import { openDB } from 'idb';

const DB_NAME    = 'ironlog-db';
const DB_VERSION = 1;

/** @type {import('idb').IDBPDatabase | null} */
let _db = null;

// ─────────────────────────────────────────────────────────────────────────────
// Schema definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opens (and upgrades) the database.
 * Safe to call multiple times — returns the cached handle after first call.
 *
 * @returns {Promise<import('idb').IDBPDatabase>}
 */
export async function initDB() {
  if (_db) return _db;

  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // ── exercises ──────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('exercises')) {
        const exStore = db.createObjectStore('exercises', { keyPath: 'id' });
        exStore.createIndex('name',        'name',        { unique: false });
        exStore.createIndex('category',    'category',    { unique: false });
        exStore.createIndex('is_compound', 'is_compound', { unique: false });
        exStore.createIndex('priority',    'priority',    { unique: false });
      }

      // ── program_state ──────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('program_state')) {
        db.createObjectStore('program_state', { keyPath: 'key' });
      }

      // ── training_log ───────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('training_log')) {
        const logStore = db.createObjectStore('training_log', { keyPath: 'id' });
        logStore.createIndex('session_id',  'session_id',  { unique: false });
        logStore.createIndex('exercise_id', 'exercise_id', { unique: false });
        logStore.createIndex('date',        'date',        { unique: false });
      }

      // ── sessions ───────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('sessions')) {
        const sessStore = db.createObjectStore('sessions', { keyPath: 'id' });
        sessStore.createIndex('date',   'date',   { unique: false });
        sessStore.createIndex('status', 'status', { unique: false });
      }

      // ── sync_queue ─────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('sync_queue')) {
        const syncStore = db.createObjectStore('sync_queue', { keyPath: 'id' });
        syncStore.createIndex('status',     'status',     { unique: false });
        syncStore.createIndex('created_at', 'created_at', { unique: false });
      }

      // ── app_config ─────────────────────────────────────────────────────────
      if (!db.objectStoreNames.contains('app_config')) {
        db.createObjectStore('app_config', { keyPath: 'key' });
      }
    },
  });

  return _db;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic CRUD helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all records from a store.
 * @param {string} storeName
 * @returns {Promise<any[]>}
 */
export async function getAll(storeName) {
  const db = await initDB();
  return db.getAll(storeName);
}

/**
 * Returns a single record by key.
 * @param {string} storeName
 * @param {string|number} key
 * @returns {Promise<any>}
 */
export async function get(storeName, key) {
  const db = await initDB();
  return db.get(storeName, key);
}

/**
 * Creates or replaces a record (put semantics).
 * Automatically stamps `updated_at` and, if missing, `created_at`.
 * @param {string} storeName
 * @param {object} data
 * @returns {Promise<string|number>} The key of the stored record.
 */
export async function put(storeName, data) {
  const db  = await initDB();
  const now = new Date().toISOString();
  const record = {
    ...data,
    updated_at: now,
    created_at: data.created_at ?? now,
  };
  return db.put(storeName, record);
}

/**
 * Deletes a record by key.
 * @param {string} storeName
 * @param {string|number} key
 * @returns {Promise<void>}
 */
export async function deleteRecord(storeName, key) {
  const db = await initDB();
  return db.delete(storeName, key);
}

// Named export alias that avoids shadowing the built-in `delete` keyword.
export { deleteRecord as delete };

// ─────────────────────────────────────────────────────────────────────────────
// Sync queue helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adds an item to the sync queue.
 * @param {'create'|'update'|'delete'} operation
 * @param {string} storeName
 * @param {string} recordId
 * @param {object} data
 * @returns {Promise<string>} The queue entry id.
 */
export async function addToSyncQueue(operation, storeName, recordId, data) {
  const db   = await initDB();
  const now  = new Date().toISOString();
  const entry = {
    id:         generateId(),
    operation,
    store_name: storeName,
    record_id:  recordId,
    data,
    status:     'pending',
    created_at: now,
    updated_at: now,
    attempts:   0,
    last_error: null,
  };
  await db.put('sync_queue', entry);
  return entry.id;
}

/**
 * Returns all items in the sync queue with status 'pending' or 'failed'.
 * @returns {Promise<any[]>}
 */
export async function getPendingSyncs() {
  const db      = await initDB();
  const pending = await db.getAllFromIndex('sync_queue', 'status', 'pending');
  const failed  = await db.getAllFromIndex('sync_queue', 'status', 'failed');
  return [...pending, ...failed].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );
}

/**
 * Marks a sync queue item as completed.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function markSyncComplete(id) {
  const db   = await initDB();
  const item = await db.get('sync_queue', id);
  if (!item) return;
  await db.put('sync_queue', {
    ...item,
    status:     'completed',
    updated_at: new Date().toISOString(),
  });
}

/**
 * Marks a sync queue item as failed, recording the error message.
 * @param {string} id
 * @param {string} error
 * @returns {Promise<void>}
 */
export async function markSyncFailed(id, error) {
  const db   = await initDB();
  const item = await db.get('sync_queue', id);
  if (!item) return;
  await db.put('sync_queue', {
    ...item,
    status:     'failed',
    attempts:   (item.attempts ?? 0) + 1,
    last_error: String(error),
    updated_at: new Date().toISOString(),
  });
}

/**
 * Removes all completed sync queue entries.
 * @returns {Promise<number>} Number of records deleted.
 */
export async function clearCompletedSyncs() {
  const db       = await initDB();
  const completed = await db.getAllFromIndex('sync_queue', 'status', 'completed');
  const tx       = db.transaction('sync_queue', 'readwrite');
  await Promise.all(completed.map(item => tx.store.delete(item.id)));
  await tx.done;
  return completed.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns sessions filtered by optional date range.
 * @param {{ startDate?: string, endDate?: string, limit?: number }} options
 * @returns {Promise<any[]>}
 */
export async function getAllSessions({ startDate, endDate, limit } = {}) {
  const db  = await initDB();
  let rows = await db.getAllFromIndex('sessions', 'date');

  if (startDate) {
    rows = rows.filter(s => s.date >= startDate);
  }
  if (endDate) {
    rows = rows.filter(s => s.date <= endDate);
  }

  // Most recent first
  rows.sort((a, b) => b.date.localeCompare(a.date));

  if (limit && limit > 0) {
    rows = rows.slice(0, limit);
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Training log helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all training_log entries for a given exercise, newest first.
 * @param {string} exerciseId
 * @returns {Promise<any[]>}
 */
export async function getExerciseHistory(exerciseId) {
  const db   = await initDB();
  const rows = await db.getAllFromIndex('training_log', 'exercise_id', exerciseId);
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

/**
 * Returns the most recent training_log entries for an exercise (one session's worth).
 * @param {string} exerciseId
 * @returns {Promise<any[]>} Array of set records from the latest session.
 */
export async function getLatestSessionForExercise(exerciseId) {
  const history = await getExerciseHistory(exerciseId);
  if (history.length === 0) return [];

  const latestDate      = history[0].date;
  const latestSessionId = history[0].session_id;

  // Return all sets from that session
  return history.filter(
    r => r.session_id === latestSessionId || r.date === latestDate
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a new UUID using the Web Crypto API.
 * @returns {string}
 */
export function generateId() {
  return crypto.randomUUID();
}
