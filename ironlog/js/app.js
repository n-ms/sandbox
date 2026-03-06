/**
 * IronLog — Main Application Controller
 *
 * Single Page Application with hash-based routing.
 * All persistence via IndexedDB only — zero network calls in the hot path.
 * All sync is background.
 *
 * Created with Perplexity Computer — https://www.perplexity.ai/computer
 */

import {
  initDB, get, put, getAll, deleteRecord,
  addToSyncQueue, getPendingSyncs,
  getAllSessions, getExerciseHistory,
  generateId,
} from './db.js';

import {
  initAuth, signIn, signOut, isSignedIn, onAuthChange, getToken,
} from './auth.js';

import {
  setAccessToken, setSheetId, parseSheetUrl,
} from './sheets.js';

import {
  getSyncStatus, syncToSheets, syncFromSheets, forceSync, startSyncListeners,
} from './sync.js';

import {
  suggestWorkout, getDefaultExercises, calculateE1RM, getPersonalRecords,
} from './workout-engine.js';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime State — all in plain JS variables, persisted via IndexedDB
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  currentRoute: '',
  activeWorkout: null,   // { sessionId, exercises[], currentExerciseIdx, startTime, sets[] }
  suggestion: null,      // cached suggestWorkout() result
  syncStatusInterval: null,
  chartInstances: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function qs(sel, root = document) { return root.querySelector(sel); }

function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function fmt(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

function fmtKg(n) { return `${fmt(n)} kg`; }

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function daysSince(dateStr) {
  if (!dateStr) return 0;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

function vibrate(pattern = [50]) {
  if ('vibrate' in navigator) {
    try { navigator.vibrate(pattern); } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast notifications
// ─────────────────────────────────────────────────────────────────────────────

function showToast(message, type = '', duration = 3000) {
  const container = el('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast${type ? ' toast--' + type : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal system
// ─────────────────────────────────────────────────────────────────────────────

function showModal(html) {
  const overlay = el('modal-overlay');
  const body = el('modal-body');
  if (!overlay || !body) return;
  body.innerHTML = html;
  overlay.classList.remove('hidden');

  const close = () => {
    overlay.classList.add('hidden');
    body.innerHTML = '';
    overlay.removeEventListener('click', onOverlayClick);
  };

  const onOverlayClick = (e) => {
    if (e.target === overlay) close();
  };

  overlay.addEventListener('click', onOverlayClick);

  // Bind close button if present
  const closeBtn = body.querySelector('[data-close-modal]');
  if (closeBtn) closeBtn.addEventListener('click', close);

  return close;
}

function closeModal() {
  const overlay = el('modal-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync status indicator
// ─────────────────────────────────────────────────────────────────────────────

async function refreshSyncIndicator() {
  const dot = el('sync-dot');
  const label = el('sync-label');
  if (!dot || !label) return;

  try {
    const status = await getSyncStatus();
    if (!navigator.onLine) {
      dot.className = 'sync-dot sync-dot--red';
      label.textContent = 'Offline';
    } else if (status.pending > 0) {
      dot.className = 'sync-dot sync-dot--yellow';
      label.textContent = `${status.pending} pending`;
    } else {
      dot.className = 'sync-dot sync-dot--green';
      label.textContent = status.lastSync
        ? `Synced ${fmtDate(status.lastSync.toISOString())}`
        : 'Synced';
    }
  } catch (_) {
    dot.className = 'sync-dot sync-dot--red';
    label.textContent = 'Error';
  }
}

async function showSyncModal() {
  let status;
  try {
    status = await getSyncStatus();
  } catch (e) {
    showToast('Could not read sync status', 'error');
    return;
  }

  const lastSyncText = status.lastSync ? fmtDate(status.lastSync.toISOString()) : 'Never';

  showModal(`
    <h2 class="modal-title">Sync Status</h2>
    <div class="sync-detail-row">
      <span class="sync-detail-label">Network</span>
      <span class="sync-detail-value" style="color: ${navigator.onLine ? 'var(--success)' : 'var(--danger)'}">
        ${navigator.onLine ? 'Online' : 'Offline'}
      </span>
    </div>
    <div class="sync-detail-row">
      <span class="sync-detail-label">Pending operations</span>
      <span class="sync-detail-value">${status.pending}</span>
    </div>
    <div class="sync-detail-row">
      <span class="sync-detail-label">Last sync</span>
      <span class="sync-detail-value">${lastSyncText}</span>
    </div>
    <div style="margin-top: var(--s-5); display: flex; gap: var(--s-3);">
      <button class="btn btn--primary btn--full" id="modal-force-sync">Force Sync Now</button>
    </div>
    <div style="margin-top: var(--s-3);">
      <button class="btn btn--ghost btn--full" data-close-modal>Close</button>
    </div>
  `);

  const syncBtn = el('modal-force-sync');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.textContent = 'Syncing…';
      syncBtn.disabled = true;
      try {
        const result = await forceSync();
        showToast(`Sync complete: ${result.outbound.synced} records synced`, 'success');
        closeModal();
        refreshSyncIndicator();
      } catch (e) {
        showToast('Sync failed: ' + e.message, 'error');
        syncBtn.textContent = 'Force Sync Now';
        syncBtn.disabled = false;
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

function navigate(route) {
  window.location.hash = route;
}

async function router() {
  const hash = window.location.hash || '#/';
  const route = hash.slice(1); // remove '#'
  state.currentRoute = route;

  // Destroy existing charts
  Object.values(state.chartInstances).forEach(c => { try { c.destroy(); } catch (_) {} });
  state.chartInstances = {};

  // Check auth
  const authConfig = await get('app_config', 'google_client_id').catch(() => null);
  const clientIdValue = authConfig?.value || '';

  const sheetConfig = await get('app_config', 'sheet_id').catch(() => null);
  const sheetId = sheetConfig?.value || '';

  const setupDone = await get('app_config', 'setup_complete').catch(() => null);

  const appEl = el('app');
  const header = el('app-header');
  const nav = el('bottom-nav');

  // Show auth screen if setup not done
  if (!setupDone?.value && route !== '/auth') {
    window.location.hash = '#/auth';
    return;
  }

  // If active workout, only allow /workout route
  if (state.activeWorkout && route !== '/workout' && route !== '/auth') {
    renderActiveWorkout();
    return;
  }

  // Route matching
  if (route === '/auth') {
    header.classList.add('hidden');
    nav.classList.add('hidden');
    renderAuth();
  } else if (route === '/' || route === '/home') {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
    updateNavActive('nav-home');
    renderHome();
  } else if (route === '/workout') {
    header.classList.add('hidden');
    nav.classList.add('hidden');
    appEl.classList.add('workout-active');
    renderActiveWorkout();
  } else if (route === '/exercises') {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
    updateNavActive('nav-exercises');
    renderExercises();
  } else if (route.startsWith('/exercise/')) {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
    updateNavActive('nav-exercises');
    const id = route.replace('/exercise/', '');
    renderExerciseDetail(id);
  } else if (route === '/prs') {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
    updateNavActive('nav-prs');
    renderPRBoard();
  } else if (route === '/settings') {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
    updateNavActive('nav-settings');
    renderSettings();
  } else if (route === '/program') {
    header.classList.remove('hidden');
    nav.classList.remove('hidden');
    updateNavActive('nav-settings');
    renderProgram();
  } else {
    // Fallback to home
    navigate('/');
  }

  // Remove workout-active class if not in workout
  if (route !== '/workout') {
    appEl.classList.remove('workout-active');
  }

  await refreshSyncIndicator();
}

function updateNavActive(activeId) {
  qsa('.nav-tab').forEach(t => t.classList.remove('active'));
  const tab = el(activeId);
  if (tab) tab.classList.add('active');
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH SCREEN
// ─────────────────────────────────────────────────────────────────────────────

function renderAuth() {
  const appEl = el('app');
  appEl.innerHTML = `
    <div class="auth-screen">
      <div class="auth-logo">
        <div class="auth-logo-icon">
          <svg width="48" height="48" viewBox="0 0 64 64" fill="none" aria-label="IronLog">
            <rect x="8" y="28" width="48" height="8" rx="4" fill="#3B82F6"/>
            <rect x="8" y="22" width="12" height="20" rx="6" fill="#3B82F6"/>
            <rect x="44" y="22" width="12" height="20" rx="6" fill="#3B82F6"/>
            <rect x="2" y="26" width="8" height="12" rx="3" fill="#3B82F6"/>
            <rect x="54" y="26" width="8" height="12" rx="3" fill="#3B82F6"/>
          </svg>
        </div>
        <div class="auth-logo-name">Iron<span>Log</span></div>
        <p class="auth-tagline">Research-backed intelligent gym training</p>
      </div>

      <div class="auth-card" id="auth-card">
        <div class="auth-step-indicator">
          <div class="auth-step-dot active" id="step-dot-1"></div>
          <div class="auth-step-dot" id="step-dot-2"></div>
          <div class="auth-step-dot" id="step-dot-3"></div>
        </div>

        <!-- Step 1: Client ID -->
        <div id="auth-step-1">
          <p style="font-size:var(--text-sm); color:var(--text-secondary); margin-bottom:var(--s-4);">
            IronLog syncs with your Google Sheet. Enter your Google OAuth Client ID to continue.
          </p>
          <div class="input-group">
            <label class="input-label" for="client-id-input">Google OAuth Client ID</label>
            <input class="input" type="text" id="client-id-input" placeholder="xxxxx.apps.googleusercontent.com"
              autocomplete="off" autocorrect="off" spellcheck="false">
          </div>
          <p style="font-size:var(--text-xs); color:var(--text-muted); margin-top:var(--s-2);">
            Create one in the <a href="https://console.cloud.google.com" target="_blank" rel="noopener">Google Cloud Console</a>.
          </p>
          <button class="btn btn--primary btn--full" style="margin-top:var(--s-4);" id="save-client-id-btn">
            Continue
          </button>
        </div>

        <!-- Step 2: Sign in with Google -->
        <div id="auth-step-2" class="hidden">
          <p style="font-size:var(--text-sm); color:var(--text-secondary); margin-bottom:var(--s-5);">
            Sign in with Google to authorize access to your Sheets.
          </p>
          <button class="google-signin-btn" id="google-signin-btn">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Sign in with Google
          </button>
          <p id="signin-status" style="font-size:var(--text-xs);color:var(--text-muted);text-align:center;margin-top:var(--s-3);"></p>
        </div>

        <!-- Step 3: Google Sheet URL -->
        <div id="auth-step-3" class="hidden">
          <p style="font-size:var(--text-sm); color:var(--text-secondary); margin-bottom:var(--s-4);">
            Paste your Google Sheet URL. IronLog will read and write your training data there.
          </p>
          <div class="input-group">
            <label class="input-label" for="sheet-url-input">Google Sheet URL</label>
            <input class="input" type="url" id="sheet-url-input" placeholder="https://docs.google.com/spreadsheets/d/..."
              autocomplete="off" autocorrect="off" spellcheck="false">
          </div>
          <p id="sheet-url-error" style="font-size:var(--text-xs);color:var(--danger);margin-top:var(--s-2);display:none;">
            Invalid URL — make sure it's a Google Sheets link.
          </p>
          <button class="btn btn--primary btn--full" style="margin-top:var(--s-4);" id="save-sheet-btn">
            Save &amp; Continue
          </button>
          <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" id="skip-sheet-btn">
            Skip for now (offline only)
          </button>
        </div>
      </div>

      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  // ── Step 1: Save Client ID ──
  const step1 = el('auth-step-1');
  const step2 = el('auth-step-2');
  const step3 = el('auth-step-3');

  // Pre-fill client ID if exists
  get('app_config', 'google_client_id').then(cfg => {
    if (cfg?.value) {
      el('client-id-input').value = cfg.value;
    }
  }).catch(() => {});

  el('save-client-id-btn').addEventListener('click', async () => {
    const clientId = el('client-id-input').value.trim();
    if (!clientId) {
      showToast('Enter a Google OAuth Client ID', 'warning');
      return;
    }
    await put('app_config', { key: 'google_client_id', value: clientId });
    try {
      await initAuth(clientId);
    } catch (e) {
      showToast('Could not initialize auth: ' + e.message, 'error');
      return;
    }
    step1.classList.add('hidden');
    step2.classList.remove('hidden');
    el('step-dot-1').className = 'auth-step-dot done';
    el('step-dot-2').className = 'auth-step-dot active';
  });

  // ── Step 2: Sign In ──
  el('google-signin-btn').addEventListener('click', async () => {
    const statusEl = el('signin-status');
    statusEl.textContent = 'Opening sign-in…';
    const btn = el('google-signin-btn');
    btn.disabled = true;

    try {
      // Ensure auth is initialized
      const cfg = await get('app_config', 'google_client_id');
      if (cfg?.value) {
        try { await initAuth(cfg.value); } catch (_) {}
      }
      const token = await signIn();
      setAccessToken(token);
      statusEl.textContent = 'Signed in successfully!';
      statusEl.style.color = 'var(--success)';
      step2.classList.add('hidden');
      step3.classList.remove('hidden');
      el('step-dot-2').className = 'auth-step-dot done';
      el('step-dot-3').className = 'auth-step-dot active';
    } catch (e) {
      statusEl.textContent = 'Sign-in failed. Try again.';
      statusEl.style.color = 'var(--danger)';
      btn.disabled = false;
    }
  });

  // ── Step 3: Sheet URL ──
  el('save-sheet-btn').addEventListener('click', async () => {
    const url = el('sheet-url-input').value.trim();
    const errEl = el('sheet-url-error');
    const sheetId = parseSheetUrl(url);
    if (!sheetId) {
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    await put('app_config', { key: 'sheet_id', value: sheetId });
    setSheetId(sheetId);
    await finishSetup();
  });

  el('skip-sheet-btn').addEventListener('click', async () => {
    await finishSetup();
  });
}

async function finishSetup() {
  // Seed default exercises if DB is empty
  const existing = await getAll('exercises');
  if (existing.length === 0) {
    const defaults = getDefaultExercises();
    for (const ex of defaults) {
      await put('exercises', ex);
    }
    showToast('Seeded default exercises', 'success');
  }

  // Mark setup complete
  await put('app_config', { key: 'setup_complete', value: 'true' });

  // Attempt initial inbound sync in background
  const sheetCfg = await get('app_config', 'sheet_id').catch(() => null);
  if (sheetCfg?.value && isSignedIn()) {
    setSheetId(sheetCfg.value);
    syncFromSheets().catch(() => {});
  }

  showToast('Welcome to IronLog!', 'success');
  navigate('/');
}

// ─────────────────────────────────────────────────────────────────────────────
// HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────────

async function renderHome() {
  const appEl = el('app');
  appEl.innerHTML = `
    <div class="screen" id="home-screen">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s-5);">
        <p class="home-greeting">Today's Plan</p>
      </div>
      <div id="home-loading" style="display:flex;flex-direction:column;gap:var(--s-3);">
        <div class="skeleton" style="height:24px;width:60%;"></div>
        <div class="skeleton" style="height:80px;"></div>
        <div class="skeleton" style="height:80px;"></div>
        <div class="skeleton" style="height:80px;"></div>
      </div>
      <div id="home-content" class="hidden"></div>
      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  try {
    // Check for active session
    const allSessions = await getAllSessions();
    const activeSession = allSessions.find(s => s.status === 'active');

    const suggestion = await suggestWorkout();
    state.suggestion = suggestion;

    const contentEl = el('home-content');
    el('home-loading').style.display = 'none';
    contentEl.classList.remove('hidden');

    // Build exercise cards HTML
    const exerciseCardsHtml = suggestion.exercises.map((ex, i) => {
      const repRangeText = `${ex.workingSets} × ${ex.targetReps} reps @ ${fmtKg(ex.suggestedWeight)}`;
      const badges = [];
      if (ex.isPriority) badges.push(`<span class="badge badge--gold">⭐ Priority</span>`);
      if (ex.isAccessory) badges.push(`<span class="badge badge--muted">Accessory</span>`);

      return `
        <div class="exercise-card" id="ex-card-${i}">
          <div class="exercise-card-header" data-card-idx="${i}">
            <div class="exercise-card-info">
              <div class="exercise-card-name">${escHtml(ex.exerciseName)}</div>
              <div class="exercise-card-detail">${escHtml(repRangeText)}</div>
              <div class="exercise-card-badges">${badges.join('')}</div>
            </div>
            <svg class="exercise-card-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="exercise-card-expand" id="ex-expand-${i}">
            <div class="adjust-row">
              <span class="adjust-label">Weight</span>
              <div class="adjust-controls">
                <button class="adjust-btn" data-adjust="weight" data-idx="${i}" data-delta="-2.5">−</button>
                <span class="adjust-value" id="ex-weight-${i}">${fmtKg(ex.suggestedWeight)}</span>
                <button class="adjust-btn" data-adjust="weight" data-idx="${i}" data-delta="2.5">+</button>
              </div>
            </div>
            <div class="adjust-row">
              <span class="adjust-label">Working Sets</span>
              <div class="adjust-controls">
                <button class="adjust-btn" data-adjust="sets" data-idx="${i}" data-delta="-1">−</button>
                <span class="adjust-value" id="ex-sets-${i}">${ex.workingSets}</span>
                <button class="adjust-btn" data-adjust="sets" data-idx="${i}" data-delta="1">+</button>
              </div>
            </div>
            <div class="adjust-row">
              <span class="adjust-label">Target Reps</span>
              <div class="adjust-controls">
                <button class="adjust-btn" data-adjust="reps" data-idx="${i}" data-delta="-1">−</button>
                <span class="adjust-value" id="ex-reps-${i}">${ex.targetReps}</span>
                <button class="adjust-btn" data-adjust="reps" data-idx="${i}" data-delta="1">+</button>
              </div>
            </div>
            <div class="exercise-card-actions">
              <button class="btn btn--danger btn--sm" data-remove-ex="${i}">Remove</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    const reentryHtml = suggestion.reentryProtocol ? `
      <div class="reentry-banner">
        <svg class="reentry-banner-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div>
          <div class="reentry-banner-title">Re-entry Protocol: ${suggestion.reentryProtocol.toUpperCase()}</div>
          <div class="reentry-banner-body">
            ${suggestion.daysSinceLastSession} days since last session.
            Working weight reduced to ${Math.round(getReetryPct(suggestion.reentryProtocol) * 100)}%.
          </div>
        </div>
      </div>
    ` : '';

    const ctaText = activeSession ? 'RESUME WORKOUT' : 'START WORKOUT';
    const ctaClass = activeSession ? 'btn--success' : 'btn--primary';

    contentEl.innerHTML = `
      <p class="suggested-workout-label">Today's Suggested Workout</p>
      <div class="workout-meta">
        <span class="badge badge--blue">${suggestion.splitDay.toUpperCase()} Day</span>
        <span class="badge badge--muted">${suggestion.phase.charAt(0).toUpperCase() + suggestion.phase.slice(1)}</span>
        ${suggestion.daysSinceLastSession > 0
          ? `<span class="badge badge--muted">${suggestion.daysSinceLastSession}d since last</span>`
          : `<span class="badge badge--green">First Session</span>`
        }
      </div>
      ${reentryHtml}
      <div class="exercise-suggestion-list" id="exercise-suggestion-list">
        ${exerciseCardsHtml}
        <button class="btn btn--ghost btn--full" id="add-exercise-btn" style="margin-top:var(--s-2);">
          + Add Exercise
        </button>
      </div>
      <div class="sticky-cta">
        <button class="btn ${ctaClass} btn--full" id="start-workout-btn">${ctaText}</button>
      </div>
    `;

    // ── Event: Expand exercise cards ──
    qsa('.exercise-card-header').forEach(header => {
      header.addEventListener('click', () => {
        const idx = header.dataset.cardIdx;
        const card = el(`ex-card-${idx}`);
        card.classList.toggle('expanded');
      });
    });

    // ── Event: Adjust controls ──
    qsa('[data-adjust]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = btn.dataset.adjust;
        const idx = parseInt(btn.dataset.idx);
        const delta = parseFloat(btn.dataset.delta);
        const ex = suggestion.exercises[idx];
        if (!ex) return;
        if (type === 'weight') {
          ex.suggestedWeight = Math.max(0, ex.suggestedWeight + delta);
          el(`ex-weight-${idx}`).textContent = fmtKg(ex.suggestedWeight);
        } else if (type === 'sets') {
          ex.workingSets = Math.max(1, Math.min(10, ex.workingSets + delta));
          el(`ex-sets-${idx}`).textContent = ex.workingSets;
        } else if (type === 'reps') {
          ex.targetReps = Math.max(1, Math.min(30, ex.targetReps + delta));
          el(`ex-reps-${idx}`).textContent = ex.targetReps;
        }
        // Update card subtitle
        const header = qs(`#ex-card-${idx} .exercise-card-detail`);
        if (header) {
          header.textContent = `${ex.workingSets} × ${ex.targetReps} reps @ ${fmtKg(ex.suggestedWeight)}`;
        }
        vibrate([10]);
      });
    });

    // ── Event: Remove exercise ──
    qsa('[data-remove-ex]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.removeEx);
        suggestion.exercises.splice(idx, 1);
        renderHome(); // re-render
      });
    });

    // ── Event: Add exercise ──
    el('add-exercise-btn').addEventListener('click', async () => {
      const exercises = await getAll('exercises');
      const options = exercises.map(ex => `<option value="${ex.id}">${escHtml(ex.name)}</option>`).join('');
      showModal(`
        <h2 class="modal-title">Add Exercise</h2>
        <div class="input-group" style="margin-bottom:var(--s-4);">
          <label class="input-label" for="add-ex-select">Exercise</label>
          <select class="input" id="add-ex-select">
            ${options}
          </select>
        </div>
        <button class="btn btn--primary btn--full" id="confirm-add-ex">Add</button>
        <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
      `);
      el('confirm-add-ex').addEventListener('click', async () => {
        const exId = el('add-ex-select').value;
        const exObj = exercises.find(e => e.id === exId);
        if (!exObj) return;
        suggestion.exercises.push({
          exerciseId: exObj.id,
          exerciseName: exObj.name,
          warmupSets: [],
          workingSets: 3,
          targetReps: exObj.default_rep_range_min || 8,
          suggestedWeight: 40,
          restSeconds: 120,
          isPriority: false,
          isAccessory: !exObj.is_compound,
        });
        closeModal();
        renderHome();
      });
    });

    // ── Event: Start/Resume Workout ──
    el('start-workout-btn').addEventListener('click', async () => {
      if (activeSession) {
        await loadActiveWorkout(activeSession.id);
      } else {
        await startNewWorkout(suggestion);
      }
    });

  } catch (e) {
    el('home-loading').style.display = 'none';
    el('home-content').classList.remove('hidden');
    el('home-content').innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div class="empty-state-title">Could not load workout</div>
        <p class="empty-state-body">${escHtml(e.message)}</p>
      </div>
    `;
  }
}

function getReetryPct(protocol) {
  const map = { moderate: 0.55, deep: 0.45, restart: 0.30 };
  return map[protocol] || 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKOUT — start / load
// ─────────────────────────────────────────────────────────────────────────────

async function startNewWorkout(suggestion) {
  const sessionId = generateId();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const session = {
    id: sessionId,
    date: today,
    status: 'active',
    split_day: suggestion.splitDay,
    phase: suggestion.phase,
    start_time: now,
    end_time: null,
    total_volume: 0,
    total_sets: 0,
    notes: '',
  };

  await put('sessions', session);
  await addToSyncQueue('create', 'sessions', sessionId, session);

  // Update program state
  await put('program_state', { key: 'last_session_date', value: today });
  await put('program_state', { key: 'last_split_day', value: suggestion.splitDay });

  state.activeWorkout = {
    sessionId,
    exercises: suggestion.exercises,
    currentExerciseIdx: 0,
    startTime: Date.now(),
    completedSets: [], // { exerciseIdx, setIdx, setType, reps, weight, rir, restSeconds }
  };

  navigate('/workout');
}

async function loadActiveWorkout(sessionId) {
  // Load existing session's data and resume
  const session = await get('sessions', sessionId);
  if (!session) { navigate('/'); return; }

  const suggestion = state.suggestion || await suggestWorkout();

  state.activeWorkout = {
    sessionId,
    exercises: suggestion.exercises,
    currentExerciseIdx: 0,
    startTime: new Date(session.start_time).getTime(),
    completedSets: [],
  };

  navigate('/workout');
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE WORKOUT SCREEN
// ─────────────────────────────────────────────────────────────────────────────

function renderActiveWorkout() {
  if (!state.activeWorkout) {
    navigate('/');
    return;
  }

  const appEl = el('app');
  const aw = state.activeWorkout;
  const exercises = aw.exercises;
  const exIdx = aw.currentExerciseIdx;
  const ex = exercises[exIdx];

  if (!ex) {
    renderWorkoutSummary();
    return;
  }

  // Build set buttons
  const warmupSets = ex.warmupSets || [];
  const workingSets = ex.workingSets || 3;
  const targetReps = ex.targetReps || 10;

  // Build set state array for this exercise
  if (!aw.exerciseSetState) aw.exerciseSetState = {};
  if (!aw.exerciseSetState[exIdx]) {
    const sets = [];
    warmupSets.forEach((ws, i) => {
      sets.push({ type: 'warmup', idx: i, weight: ws.weight, reps: ws.reps, state: 'empty', actualReps: ws.reps, rir: 2 });
    });
    for (let i = 0; i < workingSets; i++) {
      sets.push({ type: 'working', idx: warmupSets.length + i, weight: ex.suggestedWeight, reps: targetReps, state: 'empty', actualReps: targetReps, rir: 2 });
    }
    aw.exerciseSetState[exIdx] = sets;
  }

  const sets = aw.exerciseSetState[exIdx];
  const activeSetIdx = sets.findIndex(s => s.state === 'active');

  // Generate set buttons HTML
  const setBtnsHtml = sets.map((s, i) => {
    let btnClass = 'set-btn';
    btnClass += s.type === 'warmup' ? ' set-btn--warmup' : ' set-btn--working';

    let inner = '';
    if (s.state === 'completed') {
      btnClass += ' set-btn--completed';
      inner = `<span class="set-checkmark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
    } else if (s.state === 'failed') {
      btnClass += ' set-btn--failed';
      inner = `<span>✕</span>`;
    } else if (s.state === 'active') {
      btnClass += ' set-btn--active';
      inner = s.type === 'warmup' ? `W${i + 1}` : `${i - warmupSets.length + 1}`;
    } else {
      inner = s.type === 'warmup' ? `W${i + 1}` : `${i - warmupSets.length + 1}`;
    }

    return `<button class="${btnClass}" data-set-idx="${i}" aria-label="${s.type} set ${i + 1}">${inner}</button>`;
  }).join('');

  // Active set state
  const activeSet = activeSetIdx >= 0 ? sets[activeSetIdx] : null;

  // Exercise progress dots
  const dotsHtml = exercises.map((_, i) => {
    let cls = 'exercise-dot';
    if (i === exIdx) cls += ' active';
    else if (aw.exerciseSetState?.[i]?.every(s => s.state === 'completed')) cls += ' done';
    return `<div class="${cls}"></div>`;
  }).join('');

  const isLastExercise = exIdx >= exercises.length - 1;

  appEl.innerHTML = `
    <div class="workout-screen" id="workout-main">
      <!-- Top bar -->
      <div class="workout-topbar">
        <button class="workout-prev-btn" id="workout-prev-btn" ${exIdx === 0 ? 'disabled style="opacity:0.3"' : ''}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          Prev
        </button>
        <div id="workout-timer-small" style="font-size:var(--text-sm);color:var(--text-muted);font-variant-numeric:tabular-nums;"></div>
        <button class="workout-end-btn" id="workout-end-btn">End</button>
      </div>

      <!-- Exercise progress dots -->
      <div class="exercise-dots">${dotsHtml}</div>

      <!-- Exercise header -->
      <div class="workout-exercise-header">
        <div class="workout-exercise-counter">Exercise ${exIdx + 1} of ${exercises.length}</div>
        <div class="workout-exercise-name">${escHtml(ex.exerciseName)}</div>
      </div>

      <!-- Weight display -->
      <div class="workout-weight-display">
        <span class="workout-weight-number" id="workout-weight-number">${fmt(ex.suggestedWeight)}</span>
        <span class="workout-weight-unit">kg</span>
        <button class="btn btn--ghost btn--sm" id="adjust-weight-btn" style="margin-left:auto;">Adjust</button>
      </div>

      <!-- Set buttons row -->
      <div class="set-row" id="set-row">${setBtnsHtml}</div>

      <!-- Rep adjuster (visible when a set is active) -->
      <div class="rep-adjuster${activeSet ? ' visible' : ''}" id="rep-adjuster">
        <p class="rep-target-label">Adjust reps for ${activeSet ? (activeSet.type === 'warmup' ? 'warmup' : 'working') : ''} set</p>
        <div class="rep-counter-row">
          <button class="rep-btn" id="rep-minus">−</button>
          <div class="rep-count" id="rep-count">${activeSet ? activeSet.actualReps : targetReps}</div>
          <button class="rep-btn" id="rep-plus">+</button>
        </div>
        <button class="complete-set-btn" id="complete-set-btn">Complete Set</button>
      </div>

      <!-- RIR selector -->
      <div class="rir-selector" id="rir-selector">
        <span class="rir-label">Reps In Reserve</span>
        <div class="rir-buttons">
          ${[0,1,2,3,'4+'].map(v => `<button class="rir-btn${v === 2 ? ' selected' : ''}" data-rir="${v}">${v}</button>`).join('')}
        </div>
        <span class="rir-countdown" id="rir-countdown">Auto-saving in 3s…</span>
      </div>

      <!-- Rest timer -->
      <div class="rest-timer" id="rest-timer">
        <div class="rest-timer-display" id="rest-timer-display">0:00</div>
        <div class="rest-timer-meta" id="rest-timer-meta">Rest: ${Math.floor(ex.restSeconds / 60)}:00 recommended</div>
        <div class="rest-timer-bar">
          <div class="rest-timer-bar-fill" id="rest-timer-bar-fill" style="width:0%"></div>
        </div>
      </div>

      <!-- Bottom nav -->
      <div class="workout-nav-footer">
        <button class="next-exercise-btn${isLastExercise ? ' last-exercise' : ''}" id="next-exercise-btn">
          ${isLastExercise ? 'Finish Workout ✓' : 'Next Exercise →'}
        </button>
      </div>
    </div>
  `;

  // ── Workout elapsed timer ──
  const timerEl = el('workout-timer-small');
  const timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - aw.startTime) / 1000);
    timerEl.textContent = fmtTime(elapsed);
  }, 1000);
  aw._timerInterval = timerInterval;

  // ── Rest timer state ──
  aw._restTimerStart = null;
  aw._restTimerRAF = null;
  aw._rirTimeout = null;
  aw._currentSetIdx = activeSetIdx >= 0 ? activeSetIdx : null;

  // ── Event: Set button taps ──
  qsa('[data-set-idx]', appEl).forEach(btn => {
    btn.addEventListener('click', () => {
      const sIdx = parseInt(btn.dataset.setIdx);
      const setObj = sets[sIdx];
      if (!setObj) return;

      // Stop any running rest timer
      stopRestTimer();

      // If completed, allow re-tapping to see set (but don't re-activate for RIR)
      if (setObj.state === 'completed') return;

      // Deactivate any other active set
      sets.forEach((s, i) => { if (s.state === 'active') s.state = 'empty'; });

      setObj.state = 'active';
      aw._currentSetIdx = sIdx;
      vibrate([20]);
      renderActiveWorkout();
    });
  });

  // ── Event: Rep adjust ──
  const repCountEl = el('rep-count');
  if (activeSet && repCountEl) {
    el('rep-minus').addEventListener('click', () => {
      if (activeSet.actualReps > 1) {
        activeSet.actualReps--;
        repCountEl.textContent = activeSet.actualReps;
        repCountEl.classList.add('bumped');
        setTimeout(() => repCountEl.classList.remove('bumped'), 200);
        vibrate([10]);
      }
    });
    el('rep-plus').addEventListener('click', () => {
      activeSet.actualReps++;
      repCountEl.textContent = activeSet.actualReps;
      repCountEl.classList.add('bumped');
      setTimeout(() => repCountEl.classList.remove('bumped'), 200);
      vibrate([10]);
    });
  }

  // ── Event: Complete set ──
  const completeBtn = el('complete-set-btn');
  if (completeBtn && activeSet) {
    completeBtn.addEventListener('click', async () => {
      await completeCurrentSet(activeSet, exIdx, ex, sets);
    });
  }

  // ── Event: RIR selector ──
  qsa('.rir-btn', appEl).forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.rir-btn', appEl).forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const rir = btn.dataset.rir === '4+' ? 4 : parseInt(btn.dataset.rir);
      const lastCompletedIdx = [...sets].reverse().findIndex(s => s.state === 'completed');
      if (lastCompletedIdx >= 0) {
        const actualIdx = sets.length - 1 - lastCompletedIdx;
        sets[actualIdx].rir = rir;
        // Update the stored record
        updateSetRIR(aw.sessionId, sets[actualIdx], rir);
      }
      clearRIRTimeout();
    });
  });

  // ── Event: Adjust weight ──
  el('adjust-weight-btn').addEventListener('click', () => {
    showWeightAdjustModal(ex, exIdx, sets);
  });

  // ── Event: Prev exercise ──
  if (!el('workout-prev-btn').disabled) {
    el('workout-prev-btn').addEventListener('click', () => {
      clearInterval(aw._timerInterval);
      stopRestTimer();
      clearRIRTimeout();
      aw.currentExerciseIdx = Math.max(0, exIdx - 1);
      renderActiveWorkout();
    });
  }

  // ── Event: Next exercise ──
  el('next-exercise-btn').addEventListener('click', () => {
    clearInterval(aw._timerInterval);
    stopRestTimer();
    clearRIRTimeout();
    if (isLastExercise) {
      renderWorkoutSummary();
    } else {
      aw.currentExerciseIdx = exIdx + 1;
      renderActiveWorkout();
    }
  });

  // ── Event: End workout ──
  el('workout-end-btn').addEventListener('click', () => {
    showModal(`
      <h2 class="modal-title">End Workout?</h2>
      <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--s-5);">
        Your progress will be saved. You can view the summary before finishing.
      </p>
      <button class="btn btn--primary btn--full" id="confirm-end-btn">View Summary</button>
      <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Keep Going</button>
    `);
    el('confirm-end-btn').addEventListener('click', () => {
      clearInterval(aw._timerInterval);
      stopRestTimer();
      clearRIRTimeout();
      closeModal();
      renderWorkoutSummary();
    });
  });

  // Restore rest timer if coming back to screen mid-rest
  // (not implemented for re-renders — rest resets on re-render)
}

// ── Complete a set ──────────────────────────────────────────────────────────

async function completeCurrentSet(setObj, exIdx, ex, sets) {
  const aw = state.activeWorkout;
  setObj.state = 'completed';
  setObj.restStart = Date.now();

  vibrate([50]);

  const logId = generateId();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const setNumber = sets.filter(s => s.state === 'completed').length;

  const logRecord = {
    id: logId,
    session_id: aw.sessionId,
    exercise_id: ex.exerciseId,
    exercise_name: ex.exerciseName,
    date: today,
    set_number: setNumber,
    set_type: setObj.type,
    target_reps: setObj.reps,
    actual_reps: setObj.actualReps,
    weight_kg: setObj.weight,
    rir: setObj.rir,
    rest_seconds: 0,
    notes: '',
  };

  await put('training_log', logRecord);
  await addToSyncQueue('create', 'training_log', logId, logRecord);
  setObj._logId = logId;

  // Check for PR
  if (setObj.type === 'working') {
    checkAndCelebratePR(ex.exerciseId, ex.exerciseName, setObj.weight, setObj.actualReps);
  }

  // Re-render to show completed state
  renderActiveWorkout();

  // After render, start RIR countdown and rest timer
  const rirSel = el('rir-selector');
  const restTimer = el('rest-timer');
  if (rirSel) rirSel.classList.add('visible');
  if (restTimer) restTimer.classList.add('visible');

  startRestTimer(ex.restSeconds);

  // RIR auto-dismiss after 3s
  startRIRCountdown();
}

// ── Rest timer ──────────────────────────────────────────────────────────────

function startRestTimer(targetSeconds) {
  const aw = state.activeWorkout;
  aw._restTimerStart = Date.now();
  const displayEl = el('rest-timer-display');
  const fillEl = el('rest-timer-bar-fill');

  function tick() {
    const elapsed = Math.floor((Date.now() - aw._restTimerStart) / 1000);
    if (displayEl) {
      displayEl.textContent = fmtTime(elapsed);
      if (elapsed >= targetSeconds) {
        displayEl.classList.add('rested');
        if (!aw._restVibratedOnce) {
          vibrate([100, 50, 100]);
          aw._restVibratedOnce = true;
        }
      } else {
        displayEl.classList.remove('rested');
      }
    }
    if (fillEl) {
      const pct = Math.min(100, (elapsed / targetSeconds) * 100);
      fillEl.style.width = pct + '%';
      if (elapsed >= targetSeconds) fillEl.classList.add('rested');
    }
    aw._restTimerRAF = requestAnimationFrame(tick);
  }

  aw._restVibratedOnce = false;
  aw._restTimerRAF = requestAnimationFrame(tick);
}

function stopRestTimer() {
  const aw = state.activeWorkout;
  if (!aw) return;
  if (aw._restTimerRAF) {
    cancelAnimationFrame(aw._restTimerRAF);
    aw._restTimerRAF = null;
  }
  // Record rest duration on the last completed set
  if (aw._restTimerStart) {
    const elapsed = Math.floor((Date.now() - aw._restTimerStart) / 1000);
    const sets = aw.exerciseSetState?.[aw.currentExerciseIdx] || [];
    const lastDone = [...sets].reverse().find(s => s.state === 'completed' && s._logId);
    if (lastDone?._logId) {
      get('training_log', lastDone._logId).then(rec => {
        if (rec) {
          rec.rest_seconds = elapsed;
          put('training_log', rec);
          addToSyncQueue('update', 'training_log', rec.id, rec);
        }
      }).catch(() => {});
    }
    aw._restTimerStart = null;
  }
}

function startRIRCountdown() {
  const aw = state.activeWorkout;
  clearRIRTimeout();
  let count = 3;
  const countdownEl = el('rir-countdown');
  const update = () => {
    if (countdownEl) countdownEl.textContent = `Auto-saving in ${count}s…`;
  };
  update();
  aw._rirTimeout = setInterval(() => {
    count--;
    update();
    if (count <= 0) {
      clearRIRTimeout();
      // RIR selector fades away naturally — handled by next render
      const rirSel = el('rir-selector');
      if (rirSel) {
        rirSel.style.opacity = '0.5';
        rirSel.style.pointerEvents = 'none';
      }
    }
  }, 1000);
}

function clearRIRTimeout() {
  const aw = state.activeWorkout;
  if (aw?._rirTimeout) {
    clearInterval(aw._rirTimeout);
    aw._rirTimeout = null;
  }
}

async function updateSetRIR(sessionId, setObj, rir) {
  if (!setObj._logId) return;
  try {
    const rec = await get('training_log', setObj._logId);
    if (rec) {
      rec.rir = rir;
      await put('training_log', rec);
      await addToSyncQueue('update', 'training_log', rec.id, rec);
    }
  } catch (_) {}
}

function showWeightAdjustModal(ex, exIdx, sets) {
  showModal(`
    <h2 class="modal-title">Adjust Weight</h2>
    <div style="display:flex;align-items:center;justify-content:center;gap:var(--s-4);padding:var(--s-5) 0;">
      <button class="rep-btn" id="modal-weight-minus">−</button>
      <div style="font-size:var(--text-2xl);font-weight:900;min-width:80px;text-align:center;" id="modal-weight-val">${fmt(ex.suggestedWeight)} kg</div>
      <button class="rep-btn" id="modal-weight-plus">+</button>
    </div>
    <button class="btn btn--primary btn--full" id="modal-weight-save">Apply to Remaining Sets</button>
    <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
  `);

  let w = ex.suggestedWeight;

  const render = () => {
    el('modal-weight-val').textContent = `${fmt(w)} kg`;
  };

  el('modal-weight-minus').addEventListener('click', () => { w = Math.max(0, w - 2.5); render(); vibrate([10]); });
  el('modal-weight-plus').addEventListener('click', () => { w += 2.5; render(); vibrate([10]); });

  el('modal-weight-save').addEventListener('click', () => {
    ex.suggestedWeight = w;
    // Update empty/active sets with new weight
    sets.forEach(s => {
      if (s.state === 'empty' || s.state === 'active') {
        s.weight = w;
      }
    });
    closeModal();
    renderActiveWorkout();
  });
}

// ── PR check and celebration ─────────────────────────────────────────────────

async function checkAndCelebratePR(exerciseId, exerciseName, weight, reps) {
  try {
    const pr = await getPersonalRecords(exerciseId);
    const e1rm = calculateE1RM(weight, reps);
    const isPR = !pr.bestE1RM || e1rm > pr.bestE1RM.value;

    if (isPR && weight > 0 && reps > 0) {
      // Show PR celebration overlay
      showPRCelebration(exerciseName, weight, reps, e1rm);
    }
  } catch (_) {}
}

function showPRCelebration(name, weight, reps, e1rm) {
  const particles = el('pr-particles');
  if (!particles) return;

  // Create confetti particles
  const colors = ['#F59E0B', '#3B82F6', '#22C55E', '#EF4444', '#A855F7'];
  for (let i = 0; i < 20; i++) {
    const p = document.createElement('div');
    p.className = 'pr-particle';
    p.style.cssText = `
      left: ${Math.random() * 100}%;
      top: ${Math.random() * 30}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      animation-delay: ${Math.random() * 0.5}s;
      animation-duration: ${1 + Math.random()}s;
    `;
    particles.appendChild(p);
  }

  // Show toast
  showToast(`🏆 NEW PR! ${name}: ${weight}kg × ${reps} reps (e1RM: ${fmt(e1rm)}kg)`, 'warning', 5000);
  vibrate([100, 50, 100, 50, 200]);

  setTimeout(() => { particles.innerHTML = ''; }, 3000);
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKOUT SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

async function renderWorkoutSummary() {
  const aw = state.activeWorkout;
  if (!aw) { navigate('/'); return; }

  const appEl = el('app');
  const duration = Date.now() - aw.startTime;

  // Calculate total volume from all completed sets
  let totalVolume = 0;
  let totalSets = 0;
  const exerciseSummaries = [];

  for (const [eIdx, sets] of Object.entries(aw.exerciseSetState || {})) {
    const ex = aw.exercises[parseInt(eIdx)];
    if (!ex) continue;
    const completedWorkingSets = sets.filter(s => s.state === 'completed' && s.type === 'working');
    if (completedWorkingSets.length === 0) continue;

    const volume = completedWorkingSets.reduce((sum, s) => sum + (s.weight * s.actualReps), 0);
    totalVolume += volume;
    totalSets += completedWorkingSets.length;

    const bestSet = completedWorkingSets.reduce((best, s) => {
      const e1rm = calculateE1RM(s.weight, s.actualReps);
      return (!best || e1rm > calculateE1RM(best.weight, best.actualReps)) ? s : best;
    }, null);

    exerciseSummaries.push({
      name: ex.exerciseName,
      sets: completedWorkingSets.length,
      bestSet,
      volume,
    });
  }

  // Check for new PRs across all exercises
  const prList = [];
  for (const [eIdx, sets] of Object.entries(aw.exerciseSetState || {})) {
    const ex = aw.exercises[parseInt(eIdx)];
    if (!ex) continue;
    const workingSets = sets.filter(s => s.state === 'completed' && s.type === 'working');
    for (const s of workingSets) {
      const pr = await getPersonalRecords(ex.exerciseId).catch(() => ({ bestE1RM: null }));
      const e1rm = calculateE1RM(s.weight, s.actualReps);
      if (!pr.bestE1RM || e1rm > pr.bestE1RM.value) {
        prList.push({ name: ex.exerciseName, weight: s.weight, reps: s.actualReps, e1rm });
      }
    }
  }

  const prHtml = prList.length > 0 ? `
    <p class="section-label" style="padding-top:0;">New PRs 🏆</p>
    <div class="summary-pr-list">
      ${prList.map(pr => `
        <div class="pr-celebration">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--pr-gold)" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          <span>${escHtml(pr.name)}: ${fmt(pr.weight)}kg × ${pr.reps} reps (e1RM: ${fmt(pr.e1rm)}kg)</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  const exerciseSummaryHtml = exerciseSummaries.map(es => `
    <div class="card" style="margin-bottom:var(--s-2);">
      <div style="font-size:var(--text-sm);font-weight:700;color:var(--text-primary);margin-bottom:var(--s-1);">${escHtml(es.name)}</div>
      <div style="font-size:var(--text-sm);color:var(--text-muted);">
        ${es.sets} working sets · Best: ${es.bestSet ? `${fmt(es.bestSet.weight)}kg × ${es.bestSet.actualReps}` : '—'} · Vol: ${fmt(es.volume)}kg
      </div>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="summary-screen">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s-4);">
        <div style="font-size:var(--text-xl);font-weight:900;letter-spacing:-0.02em;">Workout Complete</div>
        <div style="font-size:var(--text-sm);color:var(--text-muted);">${fmtDuration(duration)}</div>
      </div>

      <div class="summary-stats">
        <div class="stat-card">
          <div class="stat-value">${totalSets}</div>
          <div class="stat-label">Sets Done</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalVolume >= 1000 ? (totalVolume / 1000).toFixed(1) + 't' : fmt(totalVolume)}</div>
          <div class="stat-label">Total Volume</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${exerciseSummaries.length}</div>
          <div class="stat-label">Exercises</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${fmtDuration(duration)}</div>
          <div class="stat-label">Duration</div>
        </div>
      </div>

      ${prHtml}

      <p class="section-label" style="padding-top:0;margin-top:var(--s-2);">Exercise Summary</p>
      ${exerciseSummaryHtml}

      <p class="section-label">Notes</p>
      <textarea class="input" id="session-notes" placeholder="How did it go? Anything to note for next time…" rows="3"></textarea>

      <div style="margin-top:var(--s-5);display:flex;flex-direction:column;gap:var(--s-3);padding-bottom:calc(var(--s-8) + env(safe-area-inset-bottom,0px));">
        <button class="btn btn--success btn--full" id="save-finish-btn">Save &amp; Finish</button>
        <button class="btn btn--ghost btn--full" id="discard-workout-btn">Discard Workout</button>
      </div>

      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  el('save-finish-btn').addEventListener('click', async () => {
    const notes = el('session-notes').value.trim();
    const now = new Date().toISOString();

    const session = await get('sessions', aw.sessionId);
    if (session) {
      session.status = 'completed';
      session.end_time = now;
      session.total_volume = totalVolume;
      session.total_sets = totalSets;
      session.notes = notes;
      await put('sessions', session);
      await addToSyncQueue('update', 'sessions', session.id, session);
    }

    state.activeWorkout = null;

    // Background sync
    if (isSignedIn()) syncToSheets().catch(() => {});

    showToast('Workout saved!', 'success');
    navigate('/');
  });

  el('discard-workout-btn').addEventListener('click', () => {
    showModal(`
      <h2 class="modal-title">Discard Workout?</h2>
      <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--s-5);">
        All logged sets will be deleted and this session removed.
      </p>
      <button class="btn btn--danger btn--full" id="confirm-discard">Discard</button>
      <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Keep</button>
    `);
    el('confirm-discard').addEventListener('click', async () => {
      // Delete session
      await deleteRecord('sessions', aw.sessionId).catch(() => {});
      state.activeWorkout = null;
      closeModal();
      navigate('/');
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISES SCREEN
// ─────────────────────────────────────────────────────────────────────────────

async function renderExercises() {
  const appEl = el('app');
  appEl.innerHTML = `
    <div class="screen">
      <div class="search-bar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="search-input" id="exercise-search" type="search" placeholder="Search exercises…" autocorrect="off" spellcheck="false">
      </div>
      <div class="exercise-list" id="exercise-list">
        <div class="skeleton" style="height:68px;"></div>
        <div class="skeleton" style="height:68px;"></div>
        <div class="skeleton" style="height:68px;"></div>
      </div>
      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
    <button class="fab" id="add-exercise-fab" aria-label="Add exercise">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    </button>
  `;

  let exercises = await getAll('exercises');

  const renderList = (items) => {
    const listEl = el('exercise-list');
    if (!listEl) return;
    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="10" width="20" height="4" rx="2"/></svg>
          <div class="empty-state-title">No exercises found</div>
        </div>
      `;
      return;
    }
    listEl.innerHTML = items.map(ex => `
      <div class="exercise-list-item" data-ex-id="${ex.id}" role="button" tabindex="0">
        <div class="exercise-list-icon${ex.priority ? ' priority-icon' : ''}">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <rect x="2" y="10" width="20" height="4" rx="2"/><rect x="2" y="8" width="4" height="8" rx="2"/><rect x="18" y="8" width="4" height="8" rx="2"/>
          </svg>
        </div>
        <div class="exercise-list-info">
          <div class="exercise-list-name">${escHtml(ex.name)}${ex.priority ? ' ⭐' : ''}</div>
          <div class="exercise-list-meta">
            <span class="badge badge--muted">${escHtml(ex.category || 'general')}</span>
            <span style="color:var(--text-muted);">${ex.default_rep_range_min}–${ex.default_rep_range_max} reps</span>
            ${ex.equipment ? `<span style="color:var(--text-muted);">${escHtml(ex.equipment)}</span>` : ''}
          </div>
        </div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-ex-id]').forEach(item => {
      item.addEventListener('click', () => navigate(`/exercise/${item.dataset.exId}`));
    });
  };

  renderList(exercises);

  el('exercise-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = exercises.filter(ex =>
      ex.name.toLowerCase().includes(q) ||
      (ex.category || '').toLowerCase().includes(q) ||
      (ex.muscle_group || '').toLowerCase().includes(q)
    );
    renderList(filtered);
  });

  el('add-exercise-fab').addEventListener('click', () => showAddExerciseModal(async () => {
    exercises = await getAll('exercises');
    renderList(exercises);
  }));
}

function showAddExerciseModal(onSave) {
  showModal(`
    <h2 class="modal-title">Add Exercise</h2>
    <div style="display:flex;flex-direction:column;gap:var(--s-3);">
      <div class="input-group">
        <label class="input-label" for="new-ex-name">Name *</label>
        <input class="input" id="new-ex-name" type="text" placeholder="e.g. Barbell Bench Press">
      </div>
      <div class="input-group">
        <label class="input-label" for="new-ex-category">Category</label>
        <select class="input" id="new-ex-category">
          <option value="chest">Chest</option>
          <option value="back">Back</option>
          <option value="legs">Legs</option>
          <option value="shoulders">Shoulders</option>
          <option value="arms">Arms</option>
          <option value="core">Core</option>
          <option value="cardio">Cardio</option>
        </select>
      </div>
      <div class="input-group">
        <label class="input-label" for="new-ex-muscle">Muscle Group</label>
        <input class="input" id="new-ex-muscle" type="text" placeholder="e.g. Chest, Triceps">
      </div>
      <div class="input-group">
        <label class="input-label" for="new-ex-equipment">Equipment</label>
        <select class="input" id="new-ex-equipment">
          <option value="barbell">Barbell</option>
          <option value="dumbbell">Dumbbell</option>
          <option value="cable">Cable</option>
          <option value="machine">Machine</option>
          <option value="bodyweight">Bodyweight</option>
          <option value="kettlebell">Kettlebell</option>
          <option value="band">Band</option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3);">
        <div class="input-group">
          <label class="input-label" for="new-ex-min-reps">Min Reps</label>
          <input class="input" id="new-ex-min-reps" type="number" min="1" max="50" value="8">
        </div>
        <div class="input-group">
          <label class="input-label" for="new-ex-max-reps">Max Reps</label>
          <input class="input" id="new-ex-max-reps" type="number" min="1" max="50" value="12">
        </div>
      </div>
      <div class="input-group">
        <label class="input-label" for="new-ex-split">Split Day</label>
        <select class="input" id="new-ex-split">
          <option value="upper">Upper</option>
          <option value="lower">Lower</option>
          <option value="">Both / Any</option>
        </select>
      </div>
    </div>
    <div style="margin-top:var(--s-5);display:flex;gap:var(--s-3);">
      <button class="btn btn--primary btn--full" id="save-new-exercise-btn">Add Exercise</button>
    </div>
    <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
  `);

  el('save-new-exercise-btn').addEventListener('click', async () => {
    const name = el('new-ex-name').value.trim();
    if (!name) { showToast('Enter an exercise name', 'warning'); return; }
    const now = new Date().toISOString();
    const ex = {
      id: generateId(),
      name,
      category: el('new-ex-category').value,
      muscle_group: el('new-ex-muscle').value.trim(),
      is_compound: true,
      equipment: el('new-ex-equipment').value,
      default_rep_range_min: parseInt(el('new-ex-min-reps').value) || 8,
      default_rep_range_max: parseInt(el('new-ex-max-reps').value) || 12,
      split_day: el('new-ex-split').value,
      utility_for: [],
      notes: '',
      priority: false,
      created_at: now,
      updated_at: now,
    };
    await put('exercises', ex);
    await addToSyncQueue('create', 'exercises', ex.id, ex);
    closeModal();
    showToast(`Added "${name}"`, 'success');
    if (onSave) onSave();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXERCISE DETAIL SCREEN
// ─────────────────────────────────────────────────────────────────────────────

async function renderExerciseDetail(id) {
  const appEl = el('app');
  appEl.innerHTML = `
    <div class="screen">
      <div style="margin-bottom:var(--s-4);">
        <button class="btn btn--ghost btn--sm" id="back-to-exercises-btn">← Back</button>
      </div>
      <div id="exercise-detail-content">
        <div class="skeleton" style="height:100px;margin-bottom:var(--s-4);"></div>
        <div class="skeleton" style="height:220px;margin-bottom:var(--s-4);"></div>
        <div class="skeleton" style="height:120px;"></div>
      </div>
      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  el('back-to-exercises-btn').addEventListener('click', () => navigate('/exercises'));

  try {
    const ex = await get('exercises', id);
    if (!ex) {
      el('exercise-detail-content').innerHTML = `<div class="empty-state"><div class="empty-state-title">Exercise not found</div></div>`;
      return;
    }

    const history = await getExerciseHistory(id);
    const pr = await getPersonalRecords(id);

    // Group history by session
    const sessionMap = {};
    history.forEach(h => {
      const sid = h.session_id;
      if (!sessionMap[sid]) sessionMap[sid] = { date: h.date, sets: [] };
      sessionMap[sid].sets.push(h);
    });
    const sessions = Object.values(sessionMap).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);

    // Chart data: e1RM over time
    const chartData = sessions.slice().reverse().map(s => {
      const workSets = s.sets.filter(h => h.set_type === 'working');
      if (!workSets.length) return null;
      const bestE1RM = Math.max(...workSets.map(h => calculateE1RM(parseFloat(h.weight_kg) || 0, parseInt(h.actual_reps) || 0)));
      return { x: s.date, y: bestE1RM };
    }).filter(Boolean);

    const historyRows = sessions.slice(0, 8).map(s => {
      const workSets = s.sets.filter(h => h.set_type === 'working');
      const bestSet = workSets.reduce((best, h) => {
        const e1 = calculateE1RM(parseFloat(h.weight_kg), parseInt(h.actual_reps));
        return (!best || e1 > best.e1) ? { ...h, e1 } : best;
      }, null);
      return `
        <tr>
          <td>${fmtDate(s.date)}</td>
          <td>${workSets.length} sets</td>
          <td>${bestSet ? `${fmt(bestSet.weight_kg)}kg × ${bestSet.actual_reps}` : '—'}</td>
          <td>${bestSet ? fmt(bestSet.e1) : '—'}kg</td>
        </tr>
      `;
    }).join('');

    el('exercise-detail-content').innerHTML = `
      <div class="exercise-detail-header">
        <div class="exercise-detail-name">${escHtml(ex.name)}</div>
        <div class="exercise-detail-meta">
          <span class="badge badge--blue">${escHtml(ex.category || 'general')}</span>
          ${ex.equipment ? `<span class="badge badge--muted">${escHtml(ex.equipment)}</span>` : ''}
          ${ex.muscle_group ? `<span class="badge badge--muted">${escHtml(ex.muscle_group)}</span>` : ''}
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;padding:var(--s-3) 0;margin-bottom:var(--s-4);">
        <div>
          <div style="font-size:var(--text-xs);font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;">Priority Exercise</div>
          <div style="font-size:var(--text-sm);color:var(--text-secondary);margin-top:2px;">Included every session</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="priority-toggle" ${ex.priority ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>

      ${pr.bestSet ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3);margin-bottom:var(--s-5);">
          <div class="stat-card">
            <div class="stat-value text-gold">${fmt(pr.bestSet.weight)}kg × ${pr.bestSet.reps}</div>
            <div class="stat-label">Best Set</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${fmt(pr.bestE1RM?.value || 0)}kg</div>
            <div class="stat-label">Est. 1RM</div>
          </div>
        </div>
      ` : ''}

      <p class="section-label" style="padding-top:0;">Progress</p>
      <div class="chart-container">
        <canvas id="exercise-chart"></canvas>
      </div>

      ${sessions.length > 0 ? `
        <p class="section-label">Recent Sessions</p>
        <div class="card" style="padding:0;overflow:hidden;margin-bottom:var(--s-4);">
          <table class="history-table">
            <thead><tr>
              <th>Date</th><th>Sets</th><th>Best Set</th><th>e1RM</th>
            </tr></thead>
            <tbody>${historyRows}</tbody>
          </table>
        </div>
      ` : `
        <div class="empty-state" style="padding:var(--s-8) 0;">
          <div class="empty-state-title">No history yet</div>
          <p class="empty-state-body">Complete a workout with this exercise to see your progress.</p>
        </div>
      `}

      <div style="display:flex;gap:var(--s-3);padding-bottom:var(--s-6);">
        <button class="btn btn--secondary btn--full" id="edit-exercise-btn">Edit Exercise</button>
        <button class="btn btn--danger" id="delete-exercise-btn" style="flex-shrink:0;">Delete</button>
      </div>
    `;

    // Priority toggle
    el('priority-toggle').addEventListener('change', async (e) => {
      ex.priority = e.target.checked;
      await put('exercises', ex);
      await addToSyncQueue('update', 'exercises', ex.id, ex);
      if (ex.priority) {
        await put('program_state', { key: 'priority_exercise_id', value: ex.id });
      }
      showToast(ex.priority ? `${ex.name} set as priority` : `${ex.name} removed from priority`, 'success');
    });

    // Edit exercise
    el('edit-exercise-btn').addEventListener('click', () => showEditExerciseModal(ex, async (updated) => {
      await renderExerciseDetail(id);
    }));

    // Delete exercise
    el('delete-exercise-btn').addEventListener('click', () => {
      showModal(`
        <h2 class="modal-title">Delete Exercise?</h2>
        <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--s-5);">
          This will remove "${escHtml(ex.name)}" from your exercise list. History is preserved.
        </p>
        <button class="btn btn--danger btn--full" id="confirm-delete-ex">Delete</button>
        <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
      `);
      el('confirm-delete-ex').addEventListener('click', async () => {
        await deleteRecord('exercises', ex.id);
        await addToSyncQueue('delete', 'exercises', ex.id, { id: ex.id });
        closeModal();
        showToast(`Deleted "${ex.name}"`, 'success');
        navigate('/exercises');
      });
    });

    // Chart
    if (typeof Chart !== 'undefined' && chartData.length > 0) {
      const canvas = el('exercise-chart');
      const ctx = canvas.getContext('2d');
      const chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: chartData.map(d => d.x),
          datasets: [{
            label: 'Estimated 1RM (kg)',
            data: chartData.map(d => d.y),
            borderColor: '#3B82F6',
            backgroundColor: 'rgba(59,130,246,0.1)',
            borderWidth: 2,
            pointBackgroundColor: '#3B82F6',
            pointRadius: 5,
            tension: 0.3,
            fill: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#1E1E1E',
              borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1,
              titleColor: '#F5F5F5',
              bodyColor: '#A0A0A0',
            },
          },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#666', maxRotation: 30 },
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.05)' },
              ticks: { color: '#666', callback: v => v + 'kg' },
            },
          },
        },
      });
      state.chartInstances['exercise'] = chart;
    }

  } catch (e) {
    el('exercise-detail-content').innerHTML = `
      <div class="empty-state"><div class="empty-state-title">Error loading exercise</div><p class="empty-state-body">${escHtml(e.message)}</p></div>
    `;
  }
}

function showEditExerciseModal(ex, onSave) {
  showModal(`
    <h2 class="modal-title">Edit Exercise</h2>
    <div style="display:flex;flex-direction:column;gap:var(--s-3);">
      <div class="input-group">
        <label class="input-label">Name</label>
        <input class="input" id="edit-ex-name" type="text" value="${escHtml(ex.name)}">
      </div>
      <div class="input-group">
        <label class="input-label">Category</label>
        <select class="input" id="edit-ex-cat">
          ${['chest','back','legs','shoulders','arms','core','cardio'].map(c =>
            `<option value="${c}" ${ex.category === c ? 'selected' : ''}>${c.charAt(0).toUpperCase() + c.slice(1)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="input-group">
        <label class="input-label">Muscle Group</label>
        <input class="input" id="edit-ex-muscle" type="text" value="${escHtml(ex.muscle_group || '')}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s-3);">
        <div class="input-group">
          <label class="input-label">Min Reps</label>
          <input class="input" id="edit-ex-min" type="number" min="1" max="50" value="${ex.default_rep_range_min || 8}">
        </div>
        <div class="input-group">
          <label class="input-label">Max Reps</label>
          <input class="input" id="edit-ex-max" type="number" min="1" max="50" value="${ex.default_rep_range_max || 12}">
        </div>
      </div>
      <div class="input-group">
        <label class="input-label">Notes</label>
        <textarea class="input" id="edit-ex-notes" rows="2">${escHtml(ex.notes || '')}</textarea>
      </div>
    </div>
    <button class="btn btn--primary btn--full" style="margin-top:var(--s-5);" id="save-edit-ex-btn">Save Changes</button>
    <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
  `);

  el('save-edit-ex-btn').addEventListener('click', async () => {
    ex.name = el('edit-ex-name').value.trim() || ex.name;
    ex.category = el('edit-ex-cat').value;
    ex.muscle_group = el('edit-ex-muscle').value.trim();
    ex.default_rep_range_min = parseInt(el('edit-ex-min').value) || ex.default_rep_range_min;
    ex.default_rep_range_max = parseInt(el('edit-ex-max').value) || ex.default_rep_range_max;
    ex.notes = el('edit-ex-notes').value.trim();
    await put('exercises', ex);
    await addToSyncQueue('update', 'exercises', ex.id, ex);
    closeModal();
    showToast('Exercise updated', 'success');
    if (onSave) onSave(ex);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PR BOARD
// ─────────────────────────────────────────────────────────────────────────────

async function renderPRBoard() {
  const appEl = el('app');
  appEl.innerHTML = `
    <div class="screen">
      <h2 style="font-size:var(--text-xl);font-weight:900;margin-bottom:var(--s-4);">Personal Records</h2>
      <div class="pr-sort-bar" id="pr-sort-bar">
        <button class="sort-btn active" data-sort="e1rm">Highest e1RM</button>
        <button class="sort-btn" data-sort="recent">Most Recent</button>
        <button class="sort-btn" data-sort="alpha">A–Z</button>
      </div>
      <div id="pr-list-container">
        <div class="skeleton" style="height:80px;margin-bottom:var(--s-2);"></div>
        <div class="skeleton" style="height:80px;margin-bottom:var(--s-2);"></div>
        <div class="skeleton" style="height:80px;"></div>
      </div>
      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  const exercises = await getAll('exercises');
  const prData = [];

  for (const ex of exercises) {
    const pr = await getPersonalRecords(ex.id);
    if (pr.bestSet) {
      prData.push({ ex, ...pr });
    }
  }

  let sortMode = 'e1rm';

  const getSorted = () => {
    let sorted = [...prData];
    if (sortMode === 'e1rm') {
      sorted.sort((a, b) => (b.bestE1RM?.value || 0) - (a.bestE1RM?.value || 0));
    } else if (sortMode === 'recent') {
      sorted.sort((a, b) => (b.bestSet?.date || '').localeCompare(a.bestSet?.date || ''));
    } else {
      sorted.sort((a, b) => a.ex.name.localeCompare(b.ex.name));
    }
    return sorted;
  };

  const renderPRs = () => {
    const sorted = getSorted();
    const container = el('pr-list-container');
    if (!container) return;

    if (sorted.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>
          <div class="empty-state-title">No PRs yet</div>
          <p class="empty-state-body">Complete workouts to build your PR board.</p>
        </div>
      `;
      return;
    }

    const rankClass = (i) => i === 0 ? 'top-1' : i === 1 ? 'top-2' : i === 2 ? 'top-3' : '';

    container.innerHTML = `
      <div class="pr-list">
        ${sorted.map((d, i) => `
          <div class="pr-card" data-ex-id="${d.ex.id}" style="cursor:pointer;">
            <div class="pr-rank ${rankClass(i)}">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i + 1)}</div>
            <div class="pr-info">
              <div class="pr-exercise-name">${escHtml(d.ex.name)}</div>
              <div class="pr-date">${fmtDate(d.bestSet?.date || '')}</div>
            </div>
            <div class="pr-values">
              <div class="pr-best-set">${fmt(d.bestSet?.weight || 0)}kg × ${d.bestSet?.reps || 0}</div>
              <div class="pr-e1rm">e1RM: ${fmt(d.bestE1RM?.value || 0)}kg</div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    container.querySelectorAll('[data-ex-id]').forEach(card => {
      card.addEventListener('click', () => navigate(`/exercise/${card.dataset.exId}`));
    });
  };

  renderPRs();

  qsa('.sort-btn', appEl).forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.sort-btn', appEl).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      sortMode = btn.dataset.sort;
      renderPRs();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS SCREEN
// ─────────────────────────────────────────────────────────────────────────────

async function renderSettings() {
  const appEl = el('app');

  const sheetCfg = await get('app_config', 'sheet_id').catch(() => null);
  const clientCfg = await get('app_config', 'google_client_id').catch(() => null);
  const bwCfg = await get('app_config', 'bodyweight_kg').catch(() => null);
  const status = await getSyncStatus().catch(() => ({ pending: 0, lastSync: null, isOnline: navigator.onLine }));

  const exercises = await getAll('exercises');
  const priorityCfg = await get('program_state', 'priority_exercise_id').catch(() => null);
  const mesoCfg = await get('program_state', 'current_mesocycle').catch(() => null);
  const mesoPhase = mesoCfg?.value || 'hypertrophy';

  const exerciseOptions = exercises.map(ex =>
    `<option value="${ex.id}" ${ex.id === priorityCfg?.value ? 'selected' : ''}>${escHtml(ex.name)}</option>`
  ).join('');

  const sheetUrl = sheetCfg?.value ? `https://docs.google.com/spreadsheets/d/${sheetCfg.value}` : '';
  const signedIn = isSignedIn();

  const appVersion = '1.0.0';

  appEl.innerHTML = `
    <div class="screen">
      <h2 style="font-size:var(--text-xl);font-weight:900;margin-bottom:var(--s-5);">Settings</h2>

      <!-- Account -->
      <p class="section-label" style="padding-top:0;">Account</p>
      <div class="settings-section">
        <div class="settings-row no-tap">
          <span class="settings-row-label">Google Account</span>
          <span class="settings-row-value">${signedIn ? 'Signed in' : 'Not signed in'}</span>
        </div>
        <div class="settings-row" id="settings-reauth-row">
          <span class="settings-row-label">${signedIn ? 'Re-authorize' : 'Sign in with Google'}</span>
          <svg class="settings-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        ${signedIn ? `
        <div class="settings-row" id="settings-signout-row">
          <span class="settings-row-label" style="color:var(--danger);">Sign Out</span>
        </div>` : ''}
      </div>

      <!-- Training -->
      <p class="section-label">Training</p>
      <div class="settings-section">
        <div class="settings-row no-tap">
          <span class="settings-row-label">Bodyweight</span>
          <div style="display:flex;align-items:center;gap:var(--s-2);">
            <input class="input" id="bw-input" type="number" step="0.5" min="30" max="300"
              value="${bwCfg?.value || ''}" placeholder="kg"
              style="width:80px;height:38px;text-align:right;padding:0 var(--s-2);">
            <span style="font-size:var(--text-sm);color:var(--text-muted);">kg</span>
          </div>
        </div>
        <div class="settings-row no-tap">
          <span class="settings-row-label">Priority Exercise</span>
          <select class="input" id="priority-ex-select" style="width:auto;max-width:160px;height:38px;font-size:var(--text-sm);">
            <option value="">None</option>
            ${exerciseOptions}
          </select>
        </div>
        <div class="settings-row no-tap">
          <span class="settings-row-label">Mesocycle Phase</span>
          <select class="input" id="meso-select" style="width:auto;max-width:160px;height:38px;font-size:var(--text-sm);">
            <option value="hypertrophy" ${mesoPhase === 'hypertrophy' ? 'selected' : ''}>Hypertrophy</option>
            <option value="strength" ${mesoPhase === 'strength' ? 'selected' : ''}>Strength</option>
          </select>
        </div>
      </div>

      <!-- Sync -->
      <p class="section-label">Sync</p>
      <div class="settings-section">
        <div class="settings-row no-tap">
          <span class="settings-row-label">Google Sheet</span>
          <span class="settings-row-value" style="font-size:var(--text-xs);">${sheetCfg?.value ? '…' + sheetCfg.value.slice(-8) : 'Not set'}</span>
        </div>
        <div class="settings-row" id="settings-sheet-row">
          <span class="settings-row-label">Change Sheet URL</span>
          <svg class="settings-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <div class="settings-row no-tap">
          <span class="settings-row-label">Last Sync</span>
          <span class="settings-row-value">${status.lastSync ? fmtDate(status.lastSync.toISOString()) : 'Never'}</span>
        </div>
        <div class="settings-row no-tap">
          <span class="settings-row-label">Pending Operations</span>
          <span class="settings-row-value">${status.pending}</span>
        </div>
        <div class="settings-row" id="force-sync-row">
          <span class="settings-row-label" style="color:var(--accent);">Force Sync Now</span>
        </div>
      </div>

      <!-- App -->
      <p class="section-label">App</p>
      <div class="settings-section">
        <div class="settings-row" id="settings-program-row">
          <span class="settings-row-label">Program Logic</span>
          <svg class="settings-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <div class="settings-row" id="settings-export-row">
          <span class="settings-row-label">Export All Data as JSON</span>
          <svg class="settings-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
        <div class="settings-row no-tap">
          <span class="settings-row-label">Version</span>
          <span class="settings-row-value">v${appVersion}</span>
        </div>
      </div>

      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  // ── Bodyweight input ──
  el('bw-input').addEventListener('change', async (e) => {
    const val = parseFloat(e.target.value);
    if (val > 0) {
      await put('app_config', { key: 'bodyweight_kg', value: String(val) });
      showToast('Bodyweight saved', 'success');
    }
  });

  // ── Priority exercise ──
  el('priority-ex-select').addEventListener('change', async (e) => {
    await put('program_state', { key: 'priority_exercise_id', value: e.target.value });
    showToast('Priority exercise updated', 'success');
  });

  // ── Mesocycle ──
  el('meso-select').addEventListener('change', async (e) => {
    await put('program_state', { key: 'current_mesocycle', value: e.target.value });
    showToast(`Phase set to ${e.target.value}`, 'success');
  });

  // ── Re-auth ──
  el('settings-reauth-row').addEventListener('click', async () => {
    try {
      const cfg = await get('app_config', 'google_client_id');
      if (!cfg?.value) {
        showToast('No Client ID configured — go to Auth setup', 'warning');
        return;
      }
      await initAuth(cfg.value);
      const token = await signIn();
      setAccessToken(token);
      const sheetCfg2 = await get('app_config', 'sheet_id');
      if (sheetCfg2?.value) setSheetId(sheetCfg2.value);
      showToast('Re-authorized successfully', 'success');
      renderSettings();
    } catch (e) {
      showToast('Auth failed: ' + e.message, 'error');
    }
  });

  // ── Sign out ──
  const signOutRow = el('settings-signout-row');
  if (signOutRow) {
    signOutRow.addEventListener('click', () => {
      showModal(`
        <h2 class="modal-title">Sign Out?</h2>
        <p style="font-size:var(--text-sm);color:var(--text-secondary);margin-bottom:var(--s-5);">
          Your local data stays intact. You'll need to sign in again to sync.
        </p>
        <button class="btn btn--danger btn--full" id="confirm-signout">Sign Out</button>
        <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
      `);
      el('confirm-signout').addEventListener('click', () => {
        signOut();
        closeModal();
        showToast('Signed out', 'success');
        renderSettings();
      });
    });
  }

  // ── Change Sheet URL ──
  el('settings-sheet-row').addEventListener('click', () => {
    showModal(`
      <h2 class="modal-title">Change Sheet URL</h2>
      <div class="input-group" style="margin-bottom:var(--s-5);">
        <label class="input-label">Google Sheet URL</label>
        <input class="input" id="settings-sheet-input" type="url" value="${escHtml(sheetUrl)}" placeholder="https://docs.google.com/spreadsheets/d/...">
      </div>
      <p id="settings-sheet-err" style="font-size:var(--text-xs);color:var(--danger);display:none;margin-bottom:var(--s-3);">Invalid URL</p>
      <button class="btn btn--primary btn--full" id="settings-save-sheet">Save</button>
      <button class="btn btn--ghost btn--full" style="margin-top:var(--s-2);" data-close-modal>Cancel</button>
    `);
    el('settings-save-sheet').addEventListener('click', async () => {
      const url = el('settings-sheet-input').value.trim();
      const sid = parseSheetUrl(url);
      if (!sid) { el('settings-sheet-err').style.display = 'block'; return; }
      await put('app_config', { key: 'sheet_id', value: sid });
      setSheetId(sid);
      closeModal();
      showToast('Sheet URL saved', 'success');
      renderSettings();
    });
  });

  // ── Force Sync ──
  el('force-sync-row').addEventListener('click', async () => {
    el('force-sync-row').querySelector('.settings-row-label').textContent = 'Syncing…';
    try {
      const result = await forceSync();
      showToast(`Synced ${result.outbound.synced} records`, 'success');
      refreshSyncIndicator();
    } catch (e) {
      showToast('Sync failed: ' + e.message, 'error');
    }
    el('force-sync-row').querySelector('.settings-row-label').textContent = 'Force Sync Now';
    el('force-sync-row').querySelector('.settings-row-label').style.color = 'var(--success)';
  });

  // ── Program Logic ──
  el('settings-program-row').addEventListener('click', () => navigate('/program'));

  // ── Export JSON ──
  el('settings-export-row').addEventListener('click', async () => {
    try {
      const [exercises2, sessions, trainingLog, programState, config] = await Promise.all([
        getAll('exercises'),
        getAllSessions(),
        getAll('training_log'),
        getAll('program_state'),
        getAll('app_config'),
      ]);
      const dump = {
        exported_at: new Date().toISOString(),
        exercises: exercises2,
        sessions,
        training_log: trainingLog,
        program_state: programState,
        app_config: config.filter(c => c.key !== 'google_client_id'),
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ironlog-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Export started', 'success');
    } catch (e) {
      showToast('Export failed: ' + e.message, 'error');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PROGRAM LOGIC SCREEN
// ─────────────────────────────────────────────────────────────────────────────

async function renderProgram() {
  const appEl = el('app');

  const mesoCfg = await get('program_state', 'current_mesocycle').catch(() => null);
  const phase = mesoCfg?.value || 'hypertrophy';
  const lastDateCfg = await get('program_state', 'last_session_date').catch(() => null);

  // Estimate next deload (every 4 weeks)
  const sessions = await getAllSessions({ limit: 50 });
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
  const recentSessions = sessions.filter(s => s.date >= fourWeeksAgo);
  const nextDeload = new Date(Date.now() + (28 - recentSessions.length * 4) * 86400000);

  appEl.innerHTML = `
    <div class="screen">
      <div style="margin-bottom:var(--s-4);">
        <button class="btn btn--ghost btn--sm" id="back-settings-btn">← Settings</button>
      </div>
      <h2 style="font-size:var(--text-xl);font-weight:900;margin-bottom:var(--s-2);">Program Logic</h2>
      <p style="font-size:var(--text-sm);color:var(--text-muted);margin-bottom:var(--s-6);">
        How IronLog builds your training.
      </p>

      <!-- Current State -->
      <div class="program-phase-card">
        <div class="phase-badge phase-badge--${phase}">${phase.charAt(0).toUpperCase() + phase.slice(1)}</div>
        <div class="program-data-row">
          <span class="program-data-label">Last session</span>
          <span class="program-data-value">${fmtDate(lastDateCfg?.value || null)}</span>
        </div>
        <div class="program-data-row">
          <span class="program-data-label">Next deload (estimate)</span>
          <span class="program-data-value">${fmtDate(nextDeload.toISOString())}</span>
        </div>
        <div class="program-data-row">
          <span class="program-data-label">Recent sessions (4 weeks)</span>
          <span class="program-data-value">${recentSessions.length}</span>
        </div>
      </div>

      <!-- Section 1: Periodization -->
      <div class="program-section">
        <div class="program-section-title">Periodization Model</div>
        <p>IronLog uses block periodization with undulating elements. You alternate between two phases: <strong>Hypertrophy</strong> (muscle growth focus, higher volume, moderate loads) and <strong>Strength</strong> (neural adaptation focus, lower reps, heavier loads).</p>
        <p>Within each block, daily undulation means each session's exercise selection rotates between Upper and Lower body splits to ensure balanced development and adequate recovery per muscle group.</p>
        <div class="program-highlight-box">
          <strong style="color:var(--accent);">Research basis:</strong>
          <span style="font-size:var(--text-sm);color:var(--text-secondary);"> Block periodization significantly outperforms linear periodization for long-term strength and hypertrophy gains (Pubmed 35044672).</span>
        </div>
      </div>

      <!-- Section 2: Progressive Overload -->
      <div class="program-section">
        <div class="program-section-title">Progressive Overload Rules</div>
        <p>Weight progression follows these rules after each session:</p>
        <div class="card" style="margin-bottom:var(--s-3);">
          <div class="program-data-row">
            <span class="program-data-label">All sets completed, RIR ≥ 2</span>
            <span class="program-data-value text-success">+2.5kg (upper) / +5kg (lower)</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">RIR consistently 0–1</span>
            <span class="program-data-value text-warning">Hold weight</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">2+ sets failed (reps below target)</span>
            <span class="program-data-value text-danger">−5%</span>
          </div>
        </div>
        <p>These increments reflect real-world plate availability and produce sustainable long-term progress without stalling or overreaching.</p>
      </div>

      <!-- Section 3: Rep Ranges -->
      <div class="program-section">
        <div class="program-section-title">Rep Ranges by Phase</div>
        <div class="card">
          <div class="program-data-row">
            <span class="program-data-label">Hypertrophy — working sets</span>
            <span class="program-data-value">8–12 reps</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">Hypertrophy — default sets</span>
            <span class="program-data-value">3 per exercise</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">Strength — working sets</span>
            <span class="program-data-value">3–5 reps</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">Strength — default sets</span>
            <span class="program-data-value">4 per exercise</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">Warmup sets (all phases)</span>
            <span class="program-data-value">50%×5, 70%×3, 85%×1</span>
          </div>
        </div>
      </div>

      <!-- Section 4: Rest Periods -->
      <div class="program-section">
        <div class="program-section-title">Rest Period Guidelines</div>
        <p>Rest periods are critical for performance and adaptation. IronLog's timer tracks them precisely and notifies you when adequate rest has been achieved.</p>
        <div class="card">
          <div class="program-data-row">
            <span class="program-data-label">Hypertrophy</span>
            <span class="program-data-value">1:30–3:00 (default 2:00)</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">Strength</span>
            <span class="program-data-value">3:00–5:00 (default 4:00)</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">Warmup sets</span>
            <span class="program-data-value">60–90 seconds</span>
          </div>
        </div>
        <p style="margin-top:var(--s-3);">The rest timer counts up from 0 and turns green when your target rest window is reached. Your phone will vibrate to signal readiness — no need to watch the screen.</p>
      </div>

      <!-- Section 5: Deload -->
      <div class="program-section">
        <div class="program-section-title">Deload Protocol</div>
        <p>After approximately 4 weeks of progressive training, a deload week is recommended. During deload, reduce volume by 40–50% (typically 2 sets per exercise instead of 3–4) and use 60–70% of your working weights.</p>
        <p>Deloads prevent accumulative fatigue, allow connective tissue recovery, and often result in performance supercompensation in the following week. IronLog estimates your next deload based on session frequency.</p>
      </div>

      <!-- Section 6: Re-entry Protocol -->
      <div class="program-section">
        <div class="program-section-title">Re-entry Protocol After Layoffs</div>
        <p>Returning to training after a break requires caution. IronLog automatically detects layoffs and adjusts your suggested weights:</p>
        <div class="card">
          <div class="program-data-row">
            <span class="program-data-label">8–14 days off (moderate)</span>
            <span class="program-data-value text-warning">55% of working weight</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">15–21 days off (deep)</span>
            <span class="program-data-value text-warning">45% of working weight</span>
          </div>
          <div class="program-data-row">
            <span class="program-data-label">22+ days off (restart)</span>
            <span class="program-data-value text-danger">30% of working weight</span>
          </div>
        </div>
        <p style="margin-top:var(--s-3);">These percentages reflect muscle memory and neuromuscular readaptation research. You'll return to previous weights within 2–3 weeks in most cases.</p>
      </div>

      <!-- Section 7: Priority Exercise System -->
      <div class="program-section">
        <div class="program-section-title">Priority Exercise System</div>
        <p>You can designate one exercise as a "priority." This exercise will be included in every session regardless of the current split day, placed first in the session order, and given an additional working set.</p>
        <p>This is ideal for athletes with a specific movement goal (powerlifting total, overhead press milestone, etc.) who want that skill to receive maximum frequency and volume within a general program.</p>
        <p>Priority exercises also include their utility accessory movements automatically — exercises that directly support the priority lift (e.g., Tricep Pushdowns for Bench Press).</p>
      </div>

      <!-- Section 8: RIR Autoregulation -->
      <div class="program-section">
        <div class="program-section-title">RIR Autoregulation</div>
        <p>After each set, IronLog asks for your Reps In Reserve — how many more reps you could have done before failure. This metric, developed by Zourdos et al., is a highly valid measure of training intensity and fatigue.</p>
        <p>Your RIR data informs the next session's weight progression decision. Consistently high RIR (3–4) suggests the load is too easy and triggers weight increases. Low RIR (0–1) prevents premature load increases.</p>
        <p>Default RIR is set to 2, representing a good balance between stimulus and recovery for most sessions.</p>
      </div>

      <footer class="app-footer">
        <a href="https://www.perplexity.ai/computer" target="_blank" rel="noopener noreferrer">Created with Perplexity Computer</a>
      </footer>
    </div>
  `;

  el('back-settings-btn').addEventListener('click', () => navigate('/settings'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility: HTML escaping
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  // Boot DB
  try {
    await initDB();
  } catch (e) {
    console.error('[IronLog] DB init failed:', e);
  }

  // Restore auth token if available and client ID configured
  const clientCfg = await get('app_config', 'google_client_id').catch(() => null);
  if (clientCfg?.value) {
    try {
      await initAuth(clientCfg.value);
    } catch (_) {}

    // Set up auth change handler
    onAuthChange(async (signedIn) => {
      if (signedIn) {
        const token = getToken();
        if (token) {
          setAccessToken(token);
          const sheetCfg = await get('app_config', 'sheet_id').catch(() => null);
          if (sheetCfg?.value) setSheetId(sheetCfg.value);
        }
      }
      refreshSyncIndicator();
    });
  }

  // Set up sheet ID if we have one
  const sheetCfg = await get('app_config', 'sheet_id').catch(() => null);
  if (sheetCfg?.value) setSheetId(sheetCfg.value);

  // Start background sync listeners
  startSyncListeners();

  // Set up periodic sync indicator refresh
  state.syncStatusInterval = setInterval(refreshSyncIndicator, 60000);

  // Wire up bottom nav
  qsa('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => navigate(tab.dataset.route.replace('#', '')));
  });

  // Wire up sync indicator
  const syncIndicator = el('sync-indicator');
  if (syncIndicator) {
    syncIndicator.addEventListener('click', showSyncModal);
    syncIndicator.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') showSyncModal(); });
  }

  // Set up router
  window.addEventListener('hashchange', router);

  // Check for active workout in DB
  const allSessions = await getAllSessions().catch(() => []);
  const activeSession = allSessions.find(s => s.status === 'active');
  if (activeSession && !state.activeWorkout) {
    // There's an active session but no state — set up a minimal state for resume
    const suggestion = await suggestWorkout().catch(() => null);
    if (suggestion) {
      state.activeWorkout = {
        sessionId: activeSession.id,
        exercises: suggestion.exercises,
        currentExerciseIdx: 0,
        startTime: new Date(activeSession.start_time).getTime(),
        completedSets: [],
      };
    }
  }

  // Hide loading screen and route
  const loadingScreen = el('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('hidden');
    setTimeout(() => { loadingScreen.style.display = 'none'; }, 300);
  }

  // Initial route
  await router();

  // Background initial sync if authenticated
  const token = getToken();
  if (token && sheetCfg?.value) {
    syncFromSheets().catch(() => {});
  }
}

// Boot
init().catch(err => {
  console.error('[IronLog] Fatal init error:', err);
  const loadingScreen = el('loading-screen');
  if (loadingScreen) {
    loadingScreen.innerHTML = `
      <div style="text-align:center;padding:32px;">
        <div style="color:#EF4444;font-size:18px;font-weight:700;margin-bottom:16px;">App failed to start</div>
        <div style="color:#666;font-size:14px;">${err.message}</div>
        <button onclick="location.reload()" style="margin-top:24px;padding:12px 24px;background:#3B82F6;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">
          Reload
        </button>
      </div>
    `;
  }
});
