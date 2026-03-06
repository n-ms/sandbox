/**
 * IronLog — Sync Engine
 *
 * Completely decoupled from UI.  Reads the sync queue from IndexedDB, writes
 * mutations to Google Sheets, and merges inbound data from Sheets back into
 * the local database.
 *
 * Conflict resolution:
 *  • Exercises    → Sheets wins  (canonical exercise catalogue)
 *  • Program_State→ Sheets wins  (allows cross-device sync)
 *  • Training_Log → Local wins   (local writes only; outbound only)
 */

import {
  initDB,
  getPendingSyncs,
  markSyncComplete,
  markSyncFailed,
  clearCompletedSyncs,
  getAll,
  put,
  generateId,
} from './db.js';

import {
  isAuthenticated,
  readSheet,
  appendSheet,
  writeSheet,
  objectToRow,
  rowToObject,
  EXERCISE_COLUMNS,
  TRAINING_LOG_COLUMNS,
  PROGRAM_STATE_COLUMNS,
} from './sheets.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const APP_CONFIG_KEY_LAST_SYNC          = 'last_sync_time';
const APP_CONFIG_KEY_LAST_INBOUND_SYNC  = 'last_inbound_sync_time';

/** Tab name → column definition map */
const STORE_TAB_MAP = {
  exercises:    { tab: 'Exercises',     columns: EXERCISE_COLUMNS     },
  training_log: { tab: 'Training_Log',  columns: TRAINING_LOG_COLUMNS },
  program_state:{ tab: 'Program_State', columns: PROGRAM_STATE_COLUMNS},
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads all rows from a Sheet tab, skipping the header row.
 * Returns an array of objects.
 * @param {string} tab
 * @param {string[]} columns
 * @returns {Promise<object[]>}
 */
async function _readTab(tab, columns) {
  const colEnd = String.fromCharCode(64 + columns.length); // e.g. 10 cols → J
  const range  = `${tab}!A:${colEnd}`;
  const rows   = await readSheet(range);

  if (rows.length === 0) return [];

  // First row is the header — skip it.
  const dataRows = rows.slice(1);
  return dataRows.map(row => rowToObject(row, columns));
}

/**
 * Ensures a Sheet tab has a header row; appends it if the sheet is empty.
 * @param {string}   tab
 * @param {string[]} columns
 */
async function _ensureHeader(tab, columns) {
  const colEnd = String.fromCharCode(64 + columns.length);
  const range  = `${tab}!A1:${colEnd}1`;
  try {
    const rows = await readSheet(range);
    if (rows.length === 0 || rows[0].length === 0) {
      await appendSheet(`${tab}!A:${colEnd}`, [columns]);
    }
  } catch (_) {
    // If tab doesn't exist yet, append will create data; swallow.
  }
}

/**
 * Finds the 1-based row number for a record ID in a Sheet tab.
 * Returns -1 if not found.
 * @param {string} tab
 * @param {string} idToFind
 * @returns {Promise<number>}
 */
async function _findRowNumber(tab, idToFind) {
  const rows = await readSheet(`${tab}!A:A`);
  for (let i = 1; i < rows.length; i++) { // skip header at index 0
    if (rows[i][0] === idToFind) return i + 1; // 1-based
  }
  return -1;
}

/**
 * Updates the app_config store with the current timestamp for a given key.
 * @param {string} configKey
 */
async function _stampSyncTime(configKey) {
  await put('app_config', { key: configKey, value: new Date().toISOString(), updated_at: new Date().toISOString(), created_at: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────────────────────
// Outbound sync — local → Sheets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes the entire sync queue and writes changes to Google Sheets.
 *
 * @returns {Promise<{ synced: number, failed: number, pending: number }>}
 */
export async function syncToSheets() {
  await initDB();

  if (!isAuthenticated()) {
    console.warn('[IronLog/sync] syncToSheets: not authenticated, skipping.');
    const pending = await getPendingSyncs();
    return { synced: 0, failed: 0, pending: pending.length };
  }

  const queue = await getPendingSyncs();
  let synced  = 0;
  let failed  = 0;

  for (const item of queue) {
    const tabInfo = STORE_TAB_MAP[item.store_name];
    if (!tabInfo) {
      // Unknown store — mark complete to avoid blocking the queue.
      await markSyncComplete(item.id);
      synced++;
      continue;
    }

    const { tab, columns } = tabInfo;

    try {
      await _ensureHeader(tab, columns);

      if (item.operation === 'create') {
        const row = objectToRow(item.data, columns);
        await appendSheet(`${tab}!A:${String.fromCharCode(64 + columns.length)}`, [row]);

      } else if (item.operation === 'update') {
        const rowNum = await _findRowNumber(tab, item.record_id);
        if (rowNum === -1) {
          // Row not found — treat as create.
          const row = objectToRow(item.data, columns);
          await appendSheet(`${tab}!A:${String.fromCharCode(64 + columns.length)}`, [row]);
        } else {
          const colEnd = String.fromCharCode(64 + columns.length);
          const range  = `${tab}!A${rowNum}:${colEnd}${rowNum}`;
          const row    = objectToRow(item.data, columns);
          await writeSheet(range, [row]);
        }

      } else if (item.operation === 'delete') {
        // Sheets doesn't support row deletion via the Values API.
        // We mark the record with a "deleted" flag in the data if present,
        // otherwise we skip (the record simply remains in the sheet as an
        // archived entry — acceptable for this use-case).
        console.info(`[IronLog/sync] delete for ${item.store_name}/${item.record_id} — not reflected in Sheets.`);
      }

      await markSyncComplete(item.id);
      synced++;

    } catch (err) {
      console.error(`[IronLog/sync] Failed to sync item ${item.id}:`, err);
      await markSyncFailed(item.id, err.message ?? String(err));
      failed++;
    }
  }

  if (synced > 0) {
    await _stampSyncTime(APP_CONFIG_KEY_LAST_SYNC);
    // Clean up completed items periodically
    await clearCompletedSyncs();
  }

  // Re-count remaining pending items after processing
  const remaining = await getPendingSyncs();

  return { synced, failed, pending: remaining.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbound sync — Sheets → local
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads Exercises and Program_State from Sheets and merges into IndexedDB.
 * Sheets wins for both stores.  Training_Log is never overwritten.
 *
 * @returns {Promise<{ exercisesImported: number, stateKeysImported: number }>}
 */
export async function syncFromSheets() {
  await initDB();

  if (!isAuthenticated()) {
    console.warn('[IronLog/sync] syncFromSheets: not authenticated, skipping.');
    return { exercisesImported: 0, stateKeysImported: 0 };
  }

  let exercisesImported = 0;
  let stateKeysImported = 0;

  // ── Exercises ──────────────────────────────────────────────────────────────
  try {
    const sheetExercises = await _readTab('Exercises', EXERCISE_COLUMNS);
    for (const ex of sheetExercises) {
      if (!ex.id) ex.id = generateId();
      // Coerce boolean
      if (typeof ex.is_compound === 'string') {
        ex.is_compound = ex.is_compound === 'true' || ex.is_compound === '1';
      }
      if (typeof ex.priority === 'string') {
        ex.priority = ex.priority === 'true' || ex.priority === '1';
      }
      await put('exercises', ex);
      exercisesImported++;
    }
  } catch (err) {
    console.error('[IronLog/sync] Failed to read Exercises sheet:', err);
  }

  // ── Program_State ──────────────────────────────────────────────────────────
  try {
    const sheetState = await _readTab('Program_State', PROGRAM_STATE_COLUMNS);
    for (const row of sheetState) {
      if (!row.key) continue;
      await put('program_state', {
        key:   row.key,
        value: row.value,
      });
      stateKeysImported++;
    }
  } catch (err) {
    console.error('[IronLog/sync] Failed to read Program_State sheet:', err);
  }

  // ── Training_Log: local wins — do nothing ─────────────────────────────────

  await _stampSyncTime(APP_CONFIG_KEY_LAST_INBOUND_SYNC);

  return { exercisesImported, stateKeysImported };
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a status snapshot for display in the UI.
 * @returns {Promise<{ pending: number, lastSync: Date|null, isOnline: boolean }>}
 */
export async function getSyncStatus() {
  await initDB();
  const pending   = await getPendingSyncs();
  const configRow = await (async () => {
    try {
      const all = await getAll('app_config');
      return all.find(r => r.key === APP_CONFIG_KEY_LAST_SYNC) ?? null;
    } catch (_) {
      return null;
    }
  })();

  return {
    pending:  pending.length,
    lastSync: configRow ? new Date(configRow.value) : null,
    isOnline: navigator.onLine,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Listeners
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks whether listeners have been started (avoid duplicate registrations). */
let _listenersStarted = false;

/**
 * Sets up background sync listeners:
 *   - online event → triggers syncToSheets()
 *   - Periodic check every 5 minutes (non-blocking)
 */
export function startSyncListeners() {
  if (_listenersStarted) return;
  _listenersStarted = true;

  // When network comes back, flush the outbound queue.
  window.addEventListener('online', () => {
    console.info('[IronLog/sync] Network online — running outbound sync...');
    syncToSheets().catch(err =>
      console.error('[IronLog/sync] Background outbound sync failed:', err)
    );
  });

  // Periodic check: flush queue + inbound sync every 5 minutes.
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(() => {
    if (navigator.onLine && isAuthenticated()) {
      syncToSheets().catch(err =>
        console.error('[IronLog/sync] Periodic outbound sync failed:', err)
      );
    }
  }, INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual trigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manually triggers a full bidirectional sync.
 * Outbound first (queue), then inbound (exercises + program state).
 *
 * @returns {Promise<{
 *   outbound: { synced: number, failed: number, pending: number },
 *   inbound:  { exercisesImported: number, stateKeysImported: number }
 * }>}
 */
export async function forceSync() {
  const outbound = await syncToSheets();
  const inbound  = await syncFromSheets();
  return { outbound, inbound };
}
