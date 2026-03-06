# IronLog

```
██╗██████╗  ██████╗ ███╗   ██╗██╗      ██████╗  ██████╗
██║██╔══██╗██╔═══██╗████╗  ██║██║     ██╔═══██╗██╔════╝
██║██████╔╝██║   ██║██╔██╗ ██║██║     ██║   ██║██║  ███╗
██║██╔══██╗██║   ██║██║╚██╗██║██║     ██║   ██║██║   ██║
██║██║  ██║╚██████╔╝██║ ╚████║███████╗╚██████╔╝╚██████╔╝
╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝ ╚═════╝  ╚═════╝
```

**Research-backed intelligent gym training**

IronLog is an offline-first Progressive Web App (PWA) for structured gym training. It runs entirely in your browser with no backend server — your training data lives in IndexedDB on your device first, and is asynchronously backed up to a Google Sheet you own and control.

---

## Table of Contents

1. [Features][1]
2. [Architecture Overview][2]
3. [Google Cloud Console Setup][3]
4. [Google Sheets Template Setup][4]
5. [Deployment to GitHub Pages][5]
6. [Local Development][6]
7. [How the Programming Logic Works][7]
8. [How to Add New Exercises][8]
9. [File Structure][9]
10. [Technology Stack][10]
11. [Research References][11]

---

## Features

### Offline-First
- All data is written to **IndexedDB** on your device first — no network required to log a set
- Google Sheets serves as an asynchronous backup and cross-device sync layer
- A sync queue buffers outbound writes and flushes them when connectivity is available
- Inbound sync pulls the latest Sheet state on app open (when online)

### Smart Workout Suggestions
- Evidence-based programming engine generates your next session automatically
- Suggests exercises, sets, rep targets, and load based on your training history and current mesocycle
- Accounts for your last session's RIR feedback to auto-regulate intensity

### Block Periodization
- Structured mesocycles alternate between **Hypertrophy** (4–8 weeks) and **Strength** (3–6 weeks) phases
- Volume and intensity landmarks shift automatically at mesocycle boundaries
- Scheduled deloads every 4–6 weeks at -30 to -50% volume

### Progressive Overload with Auto-Regulation (RIR-Based)
- Load progression guided by Reps in Reserve (RIR) feedback logged after each set
- Upper body: +2.5 kg increments; Lower body: +5 kg increments
- If last set RIR was 0–1, weight increases next session; if RIR ≥ 4, weight holds or volume adjusts

### Active Workout Tracking
- Rest timer with configurable duration (default: 120 s for compound, 90 s for isolation)
- Haptic feedback (vibration API) at rest timer completion
- Set-by-set logging with actual reps, weight, and RIR

### PR Detection and Celebration
- Detects one-rep-max equivalents and per-rep PRs automatically
- In-app celebration animation on PR lifts

### Exercise History with Charts
- Per-exercise volume and estimated 1RM charts (Chart.js)
- Session history log with set-level detail

### Installable PWA
- Add to Home Screen on iOS and Android — works like a native app
- Full offline operation after first load; Service Worker caches all assets

### No Backend Required
- Pure client-side JavaScript — host on GitHub Pages, Netlify, or any static file server
- All compute and storage is on your device

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser / PWA                        │
│                                                             │
│  ┌──────────────┐    ┌─────────────────────────────────┐   │
│  │   UI Layer   │    │         App Logic               │   │
│  │  (HTML/CSS/  │◄──►│  • Workout Generator            │   │
│  │   Vanilla JS)│    │  • Progressive Overload Engine  │   │
│  └──────────────┘    │  • PR Detector                  │   │
│                      └────────────┬────────────────────┘   │
│                                   │                         │
│                      ┌────────────▼────────────────────┐   │
│                      │        Data Layer (idb)          │   │
│                      │                                  │   │
│                      │  exercises       (master list)   │   │
│                      │  training_log    (all sets)      │   │
│                      │  sessions        (session meta)  │   │
│                      │  program_state   (meso/week/etc) │   │
│                      │  sync_queue      (pending writes)│   │
│                      │  app_config      (prefs/OAuth)   │   │
│                      └────────────┬────────────────────┘   │
│                                   │                         │
│                      ┌────────────▼────────────────────┐   │
│                      │        Sync Engine               │   │
│                      │                                  │   │
│                      │  Outbound: queue → Sheets API    │   │
│                      │  Inbound:  Sheets API → IDB      │   │
│                      │  Conflict: see rules below       │   │
│                      └────────────┬────────────────────┘   │
│                                   │                         │
└───────────────────────────────────┼─────────────────────────┘
                                    │ (HTTPS / OAuth2)
                       ┌────────────▼────────────────────┐
                       │      Google Sheets API v4        │
                       │                                  │
                       │  Tab: Exercises                  │
                       │  Tab: Training_Log               │
                       │  Tab: Program_State              │
                       └─────────────────────────────────┘
```

### IndexedDB Stores

| Store           | Description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `exercises`     | Master list of exercises (name, category, muscle group, rep ranges) |
| `training_log`  | Every logged set — the core training record                         |
| `sessions`      | Session-level metadata (date, split day, notes, duration)           |
| `program_state` | Current mesocycle, week number, split day, deload flag              |
| `sync_queue`    | Outbound write queue: rows pending upload to Sheets                 |
| `app_config`    | OAuth tokens, spreadsheet ID, user preferences                      |

### Sync Engine

**Outbound (IDB → Sheets)**
1. Every write to `training_log`, `exercises`, or `program_state` appends an entry to `sync_queue`
2. When online, the sync engine processes the queue in FIFO order via Sheets API batch updates
3. Successfully synced entries are removed from the queue

**Inbound (Sheets → IDB)**
1. On app open (when authenticated and online), the sync engine fetches all three tabs
2. Remote rows are upserted into IDB by primary key (`id` or `key`)

**Conflict Resolution Rules**

| Store           | Winner                                                             |
| --------------- | ------------------------------------------------------------------ |
| `training_log`  | **Local wins** — your device's log is authoritative                |
| `exercises`     | **Sheets wins** — add exercises in the Sheet for them to propagate |
| `program_state` | **Sheets wins** — edit the Sheet to override meso/week settings    |

### Service Worker

The Service Worker (`sw.js`) uses a **Cache-First** strategy for all app shell assets (HTML, CSS, JS, icons). Network requests to the Sheets API bypass the cache.

---

## Google Cloud Console Setup

Follow these steps exactly to obtain an OAuth 2.0 Client ID for Google Sheets access.

### Step 1 — Create a Google Cloud Project

1. Open [https://console.cloud.google.com/][12] and sign in with your Google account.
2. In the top bar, click **"Select a project"** (or the name of any existing project).
3. In the modal that appears, click **"NEW PROJECT"** (top-right).
4. Set the **Project name** to something like `IronLog`.
5. Leave **Organization** and **Location** at their defaults unless you have a specific org.
6. Click **"Create"**.
7. Wait a few seconds for the project to provision, then make sure it is selected in the top bar.

### Step 2 — Enable the Google Sheets API

1. Navigate directly to:
   [https://console.cloud.google.com/apis/library/sheets.googleapis.com][13]
   (Make sure your IronLog project is selected in the top bar.)
2. Click the blue **"ENABLE"** button.
3. Wait for the confirmation screen — you should see "Google Sheets API" listed under "Enabled APIs".

### Step 3 — Create OAuth 2.0 Credentials

#### 3a — Configure the OAuth Consent Screen (first-time only)

1. Go to [https://console.cloud.google.com/apis/credentials/consent][14]
2. Select **"External"** as the user type → click **"CREATE"**.
3. Fill in the **App information** form:
   4. **App name**: `IronLog`
   5. **User support email**: your Gmail address
   6. **App logo**: optional
   7. **Developer contact information → Email addresses**: your Gmail address
4. Click **"SAVE AND CONTINUE"**.
5. On the **Scopes** screen, do not add any scopes here — click **"SAVE AND CONTINUE"**.
6. On the **Test users** screen:
   11. Click **"+ ADD USERS"**
   12. Enter your own Gmail address
   13. Click **"ADD"**
   14. Click **"SAVE AND CONTINUE"**
7. Review the summary and click **"BACK TO DASHBOARD"**.

#### 3b — Create the OAuth Client ID

1. Go to [https://console.cloud.google.com/apis/credentials][15]
2. Click **"+ CREATE CREDENTIALS"** → **"OAuth client ID"**.
3. Set **Application type** to **"Web application"**.
4. Set **Name** to `IronLog Web Client`.
5. Under **Authorized JavaScript origins**, click **"+ ADD URI"** and add:
   6. `https://<your-github-username>.github.io` — for production on GitHub Pages
   7. `http://localhost:8000` — for local development
   \> Replace `<your-github-username>` with your actual GitHub username. Do **not** include a trailing slash.
6. Leave **Authorized redirect URIs** empty — Google Identity Services (GIS) uses a popup flow that does not require a redirect URI.
7. Click **"CREATE"**.
8. A dialog will show your credentials:
   4. **Client ID**: looks like `123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com`
   5. **Client secret**: not needed for this app (PKCE/implicit flow)
9. Copy the **Client ID** and paste it into `js/config.js` in the app (see [File Structure][16]).

### Step 4 — OAuth Consent Screen "Testing" Mode

While your app is in **Testing** mode (the default), only the Google accounts you added as test users can sign in. This is fine for personal use.

If you want to allow any Google account to sign in:
1. Go to the [OAuth consent screen][17]
2. Click **"PUBLISH APP"** to move to production
3. Note: apps requesting sensitive scopes require Google verification. The `spreadsheets` scope is not sensitive, so verification is typically not required for basic Sheets access.

---

## Google Sheets Template Setup

### Step 1 — Create a New Spreadsheet

1. Open [https://sheets.google.com][18] and click the **+** (Blank) button to create a new spreadsheet.
2. Rename it to `IronLog` (click the title at the top).

### Step 2 — Create the Three Tabs

You need exactly **three tabs** with these names (case-sensitive):

#### Tab 1: `Exercises`

Rename "Sheet1" to `Exercises`. Add the following column headers in **Row 1**:

| A   | B    | C        | D             | E            | F         | G                        | H                        | I            | J     |
| --- | ---- | -------- | ------------- | ------------ | --------- | ------------------------ | ------------------------ | ------------ | ----- |
| id  | name | category | muscle\_group | is\_compound | equipment | default\_rep\_range\_min | default\_rep\_range\_max | utility\_for | notes |

#### Tab 2: `Training_Log`

Add a new tab and name it `Training_Log`. Add these column headers in **Row 1**:

| A   | B           | C            | D              | E    | F           | G         | H            | I            | J          | K   | L             | M     |
| --- | ----------- | ------------ | -------------- | ---- | ----------- | --------- | ------------ | ------------ | ---------- | --- | ------------- | ----- |
| id  | session\_id | exercise\_id | exercise\_name | date | set\_number | set\_type | target\_reps | actual\_reps | weight\_kg | rir | rest\_seconds | notes |

#### Tab 3: `Program_State`

Add a new tab and name it `Program_State`. Add these column headers in **Row 1**:

| A   | B     |
| --- | ----- |
| key | value |

### Step 3 — Pre-populate the Exercises Tab

Add the following 7 rows (starting at Row 2) in the `Exercises` tab:

| id      | name                | category | muscle\_group                    | is\_compound | equipment       | default\_rep\_range\_min | default\_rep\_range\_max | utility\_for         | notes                                        |
| ------- | ------------------- | -------- | -------------------------------- | ------------ | --------------- | ------------------------ | ------------------------ | -------------------- | -------------------------------------------- |
| ex\_001 | Barbell Back Squat  | Lower    | Quads, Glutes, Hamstrings        | TRUE         | Barbell         | 5                        | 8                        | strength,hypertrophy | Primary lower body compound                  |
| ex\_002 | Romanian Deadlift   | Lower    | Hamstrings, Glutes               | TRUE         | Barbell         | 8                        | 12                       | hypertrophy          | Hip-hinge pattern; keep back neutral         |
| ex\_003 | Barbell Bench Press | Upper    | Chest, Triceps, Anterior Deltoid | TRUE         | Barbell         | 5                        | 8                        | strength,hypertrophy | Primary horizontal push                      |
| ex\_004 | Barbell Row         | Upper    | Lats, Rhomboids, Biceps          | TRUE         | Barbell         | 6                        | 10                       | strength,hypertrophy | Primary horizontal pull                      |
| ex\_005 | Overhead Press      | Upper    | Deltoids, Triceps, Upper Traps   | TRUE         | Barbell         | 6                        | 10                       | strength,hypertrophy | Primary vertical push                        |
| ex\_006 | Pull-Up             | Upper    | Lats, Biceps, Rear Deltoid       | TRUE         | Bodyweight/Band | 6                        | 12                       | hypertrophy          | Add load via belt if bodyweight too easy     |
| ex\_007 | Leg Press           | Lower    | Quads, Glutes                    | FALSE        | Machine         | 10                       | 15                       | hypertrophy          | Accessory lower; easier to push near failure |

### Step 4 — Pre-populate the Program\_State Tab

Add the following rows (starting at Row 2) in the `Program_State` tab:

| key                    | value           |
| ---------------------- | --------------- |
| current\_mesocycle     | hypertrophy     |
| mesocycle\_week        | 1               |
| training\_split        | upper\_lower\_4 |
| deload\_scheduled      | false           |
| last\_session\_date    |                 |
| last\_split\_day       |                 |
| priority\_exercise\_id |                 |
| bodyweight\_kg         | 75              |

### Step 5 — Copy the Spreadsheet URL

Copy the full URL from your browser's address bar — it looks like:
```
https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
```

The long string between `/d/` and `/edit` is your **Spreadsheet ID**. You will paste the full URL (or just the ID) into the app's Settings screen.

---

## Deployment to GitHub Pages

### Step 1 — Create a GitHub Repository

1. Go to [https://github.com/new][19]
2. Set the repository name to `ironlog` (all lowercase)
3. Set visibility to **Public** (required for free GitHub Pages)
4. Do **not** initialize with a README (you already have one)
5. Click **"Create repository"**

### Step 2 — Push the App Files

```bash
# Clone the empty repo
git clone https://github.com/<your-username>/ironlog.git
cd ironlog

# Copy all IronLog files into this directory
# (or copy them manually in your file manager)
cp -r /path/to/ironlog/* .

# Push to GitHub
git add .
git commit -m "Initial commit"
git push origin main
```

### Step 3 — Enable GitHub Pages

1. In your repository, go to **Settings** → **Pages** (left sidebar)
2. Under **Source**, select **"Deploy from a branch"**
3. Set **Branch** to `main` and folder to `/ (root)`
4. Click **"Save"**
5. Wait 1–2 minutes, then visit:
```
https://<your-username>.github.io/ironlog/
```

### Step 4 — Verify Your Authorized Origin

Make sure `https://<your-username>.github.io` (without the `/ironlog/` path) is listed as an **Authorized JavaScript origin** in your Google Cloud OAuth client. The origin is just the scheme + hostname, not the full path.

If you see a `redirect_uri_mismatch` or `origin_mismatch` error when signing in, go back to [Credentials][20], edit your OAuth client, and add or correct the origin.

---

## Local Development

No build step required. IronLog is plain HTML + ES modules.

```bash
cd ironlog

# Python 3 (recommended)
python -m http.server 8000

# OR Node.js
npx serve . -p 8000
```

Open [http://localhost:8000][21] in your browser.

> **Important:** `http://localhost:8000` must be listed as an **Authorized JavaScript origin** in your Google Cloud OAuth client, or the Google Sign-In button will fail.

### First-Time Setup in the App

1. Open the app → tap the **Settings** (gear) icon
2. Paste your **Client ID** into the "Google Client ID" field
3. Paste your **Spreadsheet URL** into the "Google Sheets URL" field
4. Tap **Save**
5. Tap **Sign in with Google** — authenticate in the popup
6. Tap **Sync Now** to perform the initial inbound sync (this loads your Exercises and Program\_State from the Sheet)

---

## How the Programming Logic Works

### Block Periodization Model

IronLog uses linear block periodization alternating two phases:

| Phase           | Duration  | Rep Range | Intensity                |
| --------------- | --------- | --------- | ------------------------ |
| **Hypertrophy** | 4–8 weeks | 6–15 reps | RPE 6–8 / RIR 2–4        |
| **Strength**    | 3–6 weeks | 3–6 reps  | RPE 8–9 / RIR 1–2        |
| **Deload**      | 1 week    | 8–12 reps | 50–60% of working weight |

The app automatically advances the mesocycle when:
- The programmed number of weeks is complete, **and**
- Average RIR across the last session's working sets is ≤ 2 (indicating accumulated fatigue)

### Progressive Overload Rules (RIR-Based)

After each set the user logs their **RIR (Reps in Reserve)**. The overload engine applies the following rules to determine the next session's load:

| Last Set RIR | Action                                           |
| ------------ | ------------------------------------------------ |
| 0–1          | Increase weight (+2.5 kg upper / +5 kg lower)    |
| 2–3          | Keep weight; attempt one additional rep or set   |
| ≥ 4          | Keep weight; flag for review (possibly too easy) |

Weight increases are applied conservatively — if the user fails to hit the target rep range, the weight is held for the next session regardless of RIR.

### Re-Entry Protocols After Layoffs

If the app detects no training sessions in the past **14+ days**:
- Volume is reduced to 60% of the last logged volume
- Intensity is reduced by one RIR step (target RIR + 1)
- Normal progression resumes after two consecutive sessions at target RIR

### Upper/Lower 4-Day Split

The default training split is **Upper/Lower, 4 days/week**:

| Day     | Focus                | Primary Movements              |
| ------- | -------------------- | ------------------------------ |
| Upper A | Horizontal Push/Pull | Bench Press, Barbell Row       |
| Lower A | Quad-Dominant        | Back Squat, Leg Press          |
| Upper B | Vertical Push/Pull   | Overhead Press, Pull-Up        |
| Lower B | Hip-Dominant         | Romanian Deadlift, accessories |

The `last_split_day` key in Program\_State tracks the last completed day; the next session rotates to the following day automatically.

### Deload Protocol

A deload is triggered every **4–6 weeks** (configurable) or when average session RIR falls below 1 for two consecutive sessions:
- Volume drops **30–50%** (sets reduced, frequency maintained)
- Load stays the same (do not reduce weight during deload)
- RIR target increases to 3–4
- After deload, the mesocycle advances and volume resets to the MEV (Minimum Effective Volume) landmark

### Warm-Up Set Calculation

Before each working set block, the app suggests three warm-up sets:

| Warm-Up Set | Load                  | Reps |
| ----------- | --------------------- | ---- |
| Set 1       | 50% of working weight | 8    |
| Set 2       | 70% of working weight | 5    |
| Set 3       | 85% of working weight | 3    |

Weights are rounded to the nearest 2.5 kg.

---

## How to Add New Exercises

### Via Google Sheets (recommended for syncing across devices)

1. Open your IronLog Google Sheet
2. Go to the `Exercises` tab
3. Add a new row with all column values filled in (see column reference in [Sheets Template Setup][22])
4. Give the exercise a unique `id` (e.g., `ex_008`, `ex_009`, …)
5. Save — the next time the app performs an inbound sync, the new exercise will appear

### Via the App UI

1. Open IronLog → tap **Exercises** in the bottom nav
2. Tap **"+ Add Exercise"**
3. Fill in the form and tap **Save**
4. The exercise is saved to IndexedDB immediately and queued for outbound sync to Sheets

---

## File Structure

```
ironlog/
├── index.html              # App shell — single-page application entry point
├── manifest.json           # PWA manifest (name, icons, display mode)
├── sw.js                   # Service Worker — cache-first offline strategy
├── README.md               # This file
├── SHEETS_TEMPLATE.md      # Google Sheets template reference
│
├── css/
│   ├── app.css             # Global styles, CSS custom properties, layout
│   ├── components.css      # Reusable UI components (cards, buttons, timers)
│   └── themes.css          # Dark/light theme variables
│
├── js/
│   ├── config.js           # OAuth Client ID, Spreadsheet ID — edit this file
│   ├── db.js               # IndexedDB setup and CRUD helpers (idb wrapper)
│   ├── sync.js             # Sync engine: outbound queue, inbound fetch, conflict resolution
│   ├── auth.js             # Google Identity Services OAuth2 flow
│   ├── sheets.js           # Google Sheets API v4 REST calls
│   ├── program.js          # Workout generation, periodization, overload logic
│   ├── tracker.js          # Active workout UI: sets, rest timer, haptic feedback
│   ├── history.js          # Session history view and Chart.js graphs
│   ├── exercises.js        # Exercise browser and add/edit form
│   ├── settings.js         # Settings screen: credentials, sync controls, preferences
│   └── app.js              # App bootstrap, routing, SW registration
│
└── icons/
    ├── icon-192.png        # PWA icon (192×192)
    └── icon-512.png        # PWA icon (512×512)
```

---

## Technology Stack

| Technology                          | Role                                           |
| ----------------------------------- | ---------------------------------------------- |
| **Vanilla JavaScript (ES Modules)** | All app logic — no framework, no build step    |
| **IndexedDB via [idb][23]**         | Primary local storage, structured data         |
| **Google Sheets API v4 (REST)**     | Cloud backup and cross-device sync store       |
| **Google Identity Services (GIS)**  | OAuth2 sign-in via popup (no redirect needed)  |
| **[Chart.js][24]**                  | Exercise history volume and 1RM charts         |
| **Service Worker**                  | Asset caching, offline-first app shell         |
| **Web App Manifest**                | Installability on iOS and Android home screens |
| **Vibration API**                   | Haptic feedback on rest timer completion       |

All dependencies are loaded from CDN — no `npm install` or build toolchain required.

---

## Research References

The programming logic in IronLog is informed by the following peer-reviewed research:

- **Schoenfeld, B.J., Pope, Z.K., Benik, F.M., et al. (2016).** "Longer Interset Rest Periods Enhance Muscle Strength and Hypertrophy in Resistance-Trained Men." *Journal of Strength and Conditioning Research*, 30(7), 1805–1812. — Basis for the default rest period recommendations (120 s compound, 90 s isolation).

- **Zourdos, M.C., Klemp, A., Dolan, C., et al. (2016).** "Novel Resistance Training–Specific Rating of Perceived Exertion Scale Measuring Repetitions in Reserve." *Journal of Strength and Conditioning Research*, 30(1), 267–275. — Foundation of the RIR-based auto-regulation system.

- **Grgic, J., Homolak, J., Mikulic, P., et al. (2017).** "Inducing Hypertrophic Effects of Type I Skeletal Muscle Fibers: A Hypothetical Role of Time Under Load in Resistance Training Aimed at Muscle Hypertrophy." *Medical Hypotheses*, 112, 40–42.

- **Ralston, G.W., Kilgore, L., Wyatt, F.B., et al. (2017).** "The Effect of Weekly Set Volume on Strength Gain: A Meta-Analysis." *Sports Medicine*, 47(12), 2585–2601. — Informs the per-session set volume ranges and MEV/MAV/MRV landmarks.

- **PubMed PMID 35044672** — Systematic review and meta-analysis on periodization models in resistance training. Supports the block periodization (hypertrophy → strength → deload) structure used in IronLog.

---

*IronLog is a personal training tool. Always consult a qualified coach or medical professional before beginning a new training program.*

[1]:	#features
[2]:	#architecture-overview
[3]:	#google-cloud-console-setup
[4]:	#google-sheets-template-setup
[5]:	#deployment-to-github-pages
[6]:	#local-development
[7]:	#how-the-programming-logic-works
[8]:	#how-to-add-new-exercises
[9]:	#file-structure
[10]:	#technology-stack
[11]:	#research-references
[12]:	https://console.cloud.google.com/
[13]:	https://console.cloud.google.com/apis/library/sheets.googleapis.com
[14]:	https://console.cloud.google.com/apis/credentials/consent
[15]:	https://console.cloud.google.com/apis/credentials
[16]:	#file-structure
[17]:	https://console.cloud.google.com/apis/credentials/consent
[18]:	https://sheets.google.com
[19]:	https://github.com/new
[20]:	https://console.cloud.google.com/apis/credentials
[21]:	http://localhost:8000
[22]:	#google-sheets-template-setup
[23]:	https://github.com/jakearchibald/idb
[24]:	https://www.chartjs.org/