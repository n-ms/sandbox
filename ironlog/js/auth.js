/**
 * IronLog — Google OAuth Module
 *
 * Uses Google Identity Services (GIS) to obtain OAuth2 access tokens.
 * All token state lives in JS module-scope variables only — never persisted.
 *
 * GIS script must be loaded before calling initAuth():
 *   <script src="https://accounts.google.com/gsi/client" async defer></script>
 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// ─────────────────────────────────────────────────────────────────────────────
// In-memory state
// ─────────────────────────────────────────────────────────────────────────────

/** @type {string | null} */
let _accessToken = null;

/** @type {number | null} Timestamp (ms) when the current token expires */
let _tokenExpiry = null;

/** @type {any | null} GIS TokenClient instance */
let _tokenClient = null;

/** @type {((isSignedIn: boolean) => void)[]} */
const _authCallbacks = [];

/** @type {string | null} Stored client ID */
let _clientId = null;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notifies all registered auth-change callbacks.
 * @param {boolean} signedIn
 */
function _notifyCallbacks(signedIn) {
  _authCallbacks.forEach(cb => {
    try {
      cb(signedIn);
    } catch (err) {
      console.error('[IronLog/auth] callback error', err);
    }
  });
}

/**
 * Waits for the GIS `google` global to be available.
 * The GIS script is async — there can be a short delay before `window.google`
 * is populated.
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function _waitForGIS(timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (typeof window.google !== 'undefined' && window.google.accounts) {
      return resolve();
    }

    const start    = Date.now();
    const interval = setInterval(() => {
      if (typeof window.google !== 'undefined' && window.google.accounts) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error('[IronLog/auth] Timed out waiting for GIS library.'));
      }
    }, 100);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialises the GIS Token Client.
 * Must be called once before signIn().
 * Safe to call multiple times with the same clientId.
 *
 * @param {string} clientId  Google OAuth2 client ID (public, from GCP console).
 * @returns {Promise<void>}
 */
export async function initAuth(clientId) {
  if (!clientId) throw new Error('[IronLog/auth] clientId is required.');

  _clientId = clientId;

  await _waitForGIS();

  _tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope:     SCOPE,
    callback:  (tokenResponse) => {
      if (tokenResponse.error) {
        console.error('[IronLog/auth] Token error:', tokenResponse.error);
        _accessToken = null;
        _tokenExpiry  = null;
        _notifyCallbacks(false);
        return;
      }

      _accessToken = tokenResponse.access_token;
      // GIS provides expires_in in seconds
      const expiresIn = parseInt(tokenResponse.expires_in, 10) || 3600;
      _tokenExpiry    = Date.now() + expiresIn * 1000;

      // Forward the token to sheets.js consumers via the import chain.
      // (sync.js / app.js should call setAccessToken on their own side.)
      _notifyCallbacks(true);
    },
  });
}

/**
 * Triggers the OAuth2 popup and resolves once a token is obtained.
 * Rejects if the user cancels or an error occurs.
 *
 * @returns {Promise<string>} The access token.
 */
export function signIn() {
  return new Promise((resolve, reject) => {
    if (!_tokenClient) {
      return reject(new Error('[IronLog/auth] initAuth() must be called first.'));
    }

    // Temporarily register a one-shot resolve/reject callback.
    const unsubscribe = onAuthChange((signedIn) => {
      unsubscribe();
      if (signedIn && _accessToken) {
        resolve(_accessToken);
      } else {
        reject(new Error('[IronLog/auth] Sign-in failed or was cancelled.'));
      }
    });

    // Request a fresh token.  Pass prompt:'select_account' only on first call;
    // subsequent calls skip the consent screen if scopes haven't changed.
    _tokenClient.requestAccessToken({ prompt: '' });
  });
}

/**
 * Clears the access token from memory and notifies listeners.
 * Also revokes the token via the GIS API.
 */
export function signOut() {
  if (_accessToken && typeof window.google !== 'undefined') {
    try {
      window.google.accounts.oauth2.revoke(_accessToken, () => {});
    } catch (_) {
      // Best-effort
    }
  }
  _accessToken = null;
  _tokenExpiry  = null;
  _notifyCallbacks(false);
}

/**
 * Returns the current access token, or null if not signed in / expired.
 * @returns {string | null}
 */
export function getToken() {
  if (!_accessToken) return null;
  if (_tokenExpiry !== null && Date.now() > _tokenExpiry) {
    // Token has expired — clear silently
    _accessToken = null;
    _tokenExpiry  = null;
    _notifyCallbacks(false);
    return null;
  }
  return _accessToken;
}

/**
 * Returns true if a valid, non-expired token is present.
 * @returns {boolean}
 */
export function isSignedIn() {
  return getToken() !== null;
}

/**
 * Registers a callback that fires whenever auth state changes.
 * The callback receives a single boolean: `true` = signed in, `false` = signed out.
 *
 * Returns an unsubscribe function.
 *
 * @param {(isSignedIn: boolean) => void} callback
 * @returns {() => void} Call to stop listening.
 */
export function onAuthChange(callback) {
  _authCallbacks.push(callback);
  return () => {
    const idx = _authCallbacks.indexOf(callback);
    if (idx !== -1) _authCallbacks.splice(idx, 1);
  };
}
