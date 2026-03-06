/**
 * IronLog — Google Sheets API Module
 *
 * Wraps the Sheets REST API v4.  Access token is stored ONLY in a JS closure
 * variable — never persisted to storage.
 *
 * Tab layout expected in the user's Google Sheet:
 *   Sheet1 "Exercises"      — id, name, category, muscle_group, is_compound,
 *                              equipment, default_rep_range_min,
 *                              default_rep_range_max, utility_for, notes
 *   Sheet2 "Training_Log"   — id, session_id, exercise_id, exercise_name,
 *                              date, set_number, set_type, target_reps,
 *                              actual_reps, weight_kg, rir, rest_seconds, notes
 *   Sheet3 "Program_State"  — key, value
 */

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state  (never written to any storage)
// ─────────────────────────────────────────────────────────────────────────────

/** @type {string | null} */
let _accessToken = null;

/** @type {string | null} */
let _sheetId = null;

// ─────────────────────────────────────────────────────────────────────────────
// Configuration setters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stores the OAuth2 access token in memory only.
 * @param {string} token
 */
export function setAccessToken(token) {
  _accessToken = token || null;
}

/**
 * Stores the target Sheet ID in memory.
 * @param {string} id
 */
export function setSheetId(id) {
  _sheetId = id || null;
}

/**
 * Returns true if an access token is currently held in memory.
 * @returns {boolean}
 */
export function isAuthenticated() {
  return Boolean(_accessToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the common Authorization header.
 * Throws if no token is present.
 * @returns {{ Authorization: string, 'Content-Type': string }}
 */
function _authHeaders() {
  if (!_accessToken) {
    throw new Error('SheetsAPI: not authenticated — call setAccessToken() first.');
  }
  return {
    Authorization: `Bearer ${_accessToken}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Asserts that a sheet ID has been configured.
 */
function _assertSheetId() {
  if (!_sheetId) {
    throw new Error('SheetsAPI: no sheet ID configured — call setSheetId() first.');
  }
}

/**
 * Handles a Sheets API response, throwing on HTTP error.
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function _handleResponse(response) {
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch (_) {
      // ignore
    }
    throw new Error(
      `SheetsAPI: HTTP ${response.status} ${response.statusText} — ${body}`
    );
  }
  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core API wrappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads values from a range.
 * @param {string} range  e.g. "Exercises!A:J" or "Training_Log!A1:M"
 * @returns {Promise<any[][]>} 2-D array of cell values (empty if no data).
 */
export async function readSheet(range) {
  _assertSheetId();
  const url      = `${SHEETS_BASE}/${_sheetId}/values/${encodeURIComponent(range)}`;
  const response = await fetch(url, { headers: _authHeaders() });
  const json     = await _handleResponse(response);
  return json.values ?? [];
}

/**
 * Updates (overwrites) a range with the supplied values.
 * Uses RAW value input — callers supply final string/number representations.
 * @param {string}   range   e.g. "Training_Log!A2:M2"
 * @param {any[][]}  values  2-D array matching the range dimensions.
 * @returns {Promise<object>} Sheets API update response.
 */
export async function writeSheet(range, values) {
  _assertSheetId();
  const url = `${SHEETS_BASE}/${_sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const response = await fetch(url, {
    method:  'PUT',
    headers: _authHeaders(),
    body:    JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
  return _handleResponse(response);
}

/**
 * Appends rows after the last row of data in a range.
 * @param {string}   range   e.g. "Training_Log!A:M"
 * @param {any[][]}  values  Rows to append.
 * @returns {Promise<object>} Sheets API append response.
 */
export async function appendSheet(range, values) {
  _assertSheetId();
  const url = `${SHEETS_BASE}/${_sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const response = await fetch(url, {
    method:  'POST',
    headers: _authHeaders(),
    body:    JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
  return _handleResponse(response);
}

/**
 * Performs a batchUpdate — multiple value ranges in a single request.
 * @param {{ range: string, values: any[][] }[]} data  Array of range/values pairs.
 * @returns {Promise<object>} Sheets API batchUpdate response.
 */
export async function batchUpdate(data) {
  _assertSheetId();
  const url = `${SHEETS_BASE}/${_sheetId}/values:batchUpdate`;
  const body = {
    valueInputOption: 'RAW',
    data: data.map(({ range, values }) => ({
      range,
      majorDimension: 'ROWS',
      values,
    })),
  };
  const response = await fetch(url, {
    method:  'POST',
    headers: _authHeaders(),
    body:    JSON.stringify(body),
  });
  return _handleResponse(response);
}

// ─────────────────────────────────────────────────────────────────────────────
// URL / ID utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the spreadsheet ID from a full Google Sheets URL.
 *
 * Handles formats like:
 *   https://docs.google.com/spreadsheets/d/SHEET_ID/edit#gid=0
 *   https://docs.google.com/spreadsheets/d/SHEET_ID/
 *
 * @param {string} url
 * @returns {string | null} The sheet ID, or null if not found.
 */
export function parseSheetUrl(url) {
  if (!url) return null;
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Column layout constants (used by sync.js for row serialisation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column order for the "Exercises" tab (row index 0 = header).
 * @type {string[]}
 */
export const EXERCISE_COLUMNS = [
  'id', 'name', 'category', 'muscle_group', 'is_compound', 'equipment',
  'default_rep_range_min', 'default_rep_range_max', 'utility_for', 'notes',
];

/**
 * Column order for the "Training_Log" tab.
 * @type {string[]}
 */
export const TRAINING_LOG_COLUMNS = [
  'id', 'session_id', 'exercise_id', 'exercise_name', 'date', 'set_number',
  'set_type', 'target_reps', 'actual_reps', 'weight_kg', 'rir',
  'rest_seconds', 'notes',
];

/**
 * Column order for the "Program_State" tab.
 * @type {string[]}
 */
export const PROGRAM_STATE_COLUMNS = ['key', 'value'];

// ─────────────────────────────────────────────────────────────────────────────
// Row serialisation / deserialisation helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a flat object to a row array in the given column order.
 * Arrays are serialised as JSON strings.
 * @param {object}   obj
 * @param {string[]} columns
 * @returns {any[]}
 */
export function objectToRow(obj, columns) {
  return columns.map(col => {
    const val = obj[col];
    if (Array.isArray(val)) return JSON.stringify(val);
    if (val === undefined || val === null) return '';
    return val;
  });
}

/**
 * Converts a row array back to an object using the given column order.
 * JSON strings that parse as arrays are automatically deserialised.
 * @param {any[]}    row
 * @param {string[]} columns
 * @returns {object}
 */
export function rowToObject(row, columns) {
  const obj = {};
  columns.forEach((col, i) => {
    const raw = row[i] ?? '';
    // Attempt JSON parse for array fields
    if (typeof raw === 'string' && raw.startsWith('[')) {
      try {
        obj[col] = JSON.parse(raw);
        return;
      } catch (_) {
        // fall through
      }
    }
    // Coerce booleans
    if (raw === 'true')  { obj[col] = true;  return; }
    if (raw === 'false') { obj[col] = false; return; }
    obj[col] = raw;
  });
  return obj;
}
