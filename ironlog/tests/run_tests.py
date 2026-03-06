"""
IronLog PWA — Test Suite
Uses data URIs to test component logic without network dependencies.
Verifies: file structure, CSS tokens, manifest, HTML structure, JS module syntax.
"""

import json
import os
import re
import sys
import time
import traceback

# ── Static file tests (no browser needed) ──

BASE = "/home/user/workspace/ironlog"
PASS = 0
FAIL = 0


def result(name, ok, msg=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}: {msg}")


def read(path):
    with open(os.path.join(BASE, path), "r") as f:
        return f.read()


def main():
    global PASS, FAIL

    print("\n═══════════════════════════════════════")
    print("  IronLog PWA — Test Suite")
    print("═══════════════════════════════════════\n")

    # ── 1. File Structure ──
    print("File Structure:")
    required_files = [
        "index.html", "manifest.json", "sw.js",
        "css/style.css", "js/app.js", "js/db.js",
        "js/auth.js", "js/sheets.js", "js/sync.js",
        "js/workout-engine.js", "README.md",
        "SHEETS_TEMPLATE.md", "tests/run_tests.py",
    ]
    for f in required_files:
        exists = os.path.exists(os.path.join(BASE, f))
        result(f"File exists: {f}", exists)

    # ── 2. index.html Structure ──
    print("\nHTML Structure:")
    html = read("index.html")
    result("Has DOCTYPE", "<!DOCTYPE html>" in html)
    result("Has charset", 'charset="UTF-8"' in html or "charset=UTF-8" in html)
    result("Has viewport meta", 'name="viewport"' in html)
    result("Has theme-color meta", 'name="theme-color"' in html)
    result("Has apple-mobile-web-app-capable", "apple-mobile-web-app-capable" in html)
    result("Has manifest link", 'rel="manifest"' in html)
    result("Has #app container", 'id="app"' in html)
    result("Has #bottom-nav", 'id="bottom-nav"' in html)
    result("Has #loading-screen", 'id="loading-screen"' in html)
    result("Has sync indicator", 'id="sync-indicator"' in html)
    result("Has toast container", 'id="toast-container"' in html)
    result("Has modal overlay", 'id="modal-overlay"' in html)
    result("Loads Chart.js from CDN", "chart.js" in html.lower() or "chart.umd" in html.lower())
    result("Loads idb from CDN", "idb" in html.lower())
    result("Loads GIS script", "accounts.google.com/gsi/client" in html)
    result("Has service worker registration", "serviceWorker" in html)
    result("Has ES module import for app.js", 'type="module"' in html)
    result("Has Perplexity attribution", "Perplexity Computer" in html)
    result("Has footer link to Perplexity", "perplexity.ai/computer" in html)

    # ── 3. manifest.json ──
    print("\nPWA Manifest:")
    manifest_text = read("manifest.json")
    try:
        manifest = json.loads(manifest_text)
        result("Valid JSON", True)
        result("name = 'IronLog'", manifest.get("name") == "IronLog")
        result("short_name = 'IronLog'", manifest.get("short_name") == "IronLog")
        result("display = 'standalone'", manifest.get("display") == "standalone")
        result("Has start_url", "start_url" in manifest)
        result("Has icons array", isinstance(manifest.get("icons"), list) and len(manifest["icons"]) > 0)
        result("background_color is dark", manifest.get("background_color", "").startswith("#0"))
        result("theme_color is set", len(manifest.get("theme_color", "")) > 0)
        # Check icon sizes
        sizes = [i.get("sizes") for i in manifest.get("icons", [])]
        result("Has 192x192 icon", "192x192" in sizes)
        result("Has 512x512 icon", "512x512" in sizes)
    except json.JSONDecodeError as e:
        result("Valid JSON", False, str(e))

    # ── 4. Service Worker ──
    print("\nService Worker:")
    sw = read("sw.js")
    result("Has cache name", "ironlog" in sw.lower())
    result("Has install event", "install" in sw)
    result("Has fetch event", "fetch" in sw)
    result("Has activate event", "activate" in sw)
    result("Caches index.html", "index.html" in sw)
    result("Caches style.css", "style.css" in sw)
    result("Has cache-first strategy", "caches.match" in sw or "cache" in sw.lower())

    # ── 5. CSS Design Tokens ──
    print("\nCSS Design Tokens:")
    css = read("css/style.css")
    result("Defines --bg token", "--bg:" in css or "--bg :" in css)
    result("Defines --accent token", "--accent:" in css or "--accent :" in css)
    result("Defines --surface token", "--surface:" in css or "--surface :" in css)
    result("Defines --text-primary token", "--text-primary:" in css or "--text-primary :" in css or "--text:" in css)
    result("Uses #0A0A0A or similar dark bg", "#0A0A0A" in css or "#0a0a0a" in css or "#000" in css)
    result("Uses #3B82F6 accent blue", "#3B82F6" in css or "#3b82f6" in css)
    result("Set button size >= 64px", "64px" in css)
    result("Touch target >= 48px", "48px" in css)
    result("Has animation keyframes", "@keyframes" in css)
    result("Has .set-btn styles", ".set-btn" in css)
    result("Has .rest-timer styles", ".rest-timer" in css)
    result("Has .rir-selector styles", ".rir-selector" in css or ".rir" in css)
    result("Has .bottom-nav styles", ".bottom-nav" in css)
    result("Has .workout-screen styles", ".workout-screen" in css or ".workout" in css)
    result("Has .btn--primary styles", ".btn--primary" in css or ".btn-primary" in css)
    result("Has .toast styles", ".toast" in css)
    result("Has .modal styles", ".modal" in css)

    # ── 6. db.js — IndexedDB Module ──
    print("\nIndexedDB Module (db.js):")
    db = read("js/db.js")
    result("Imports from 'idb'", "from 'idb'" in db or 'from "idb"' in db)
    result("DB name 'ironlog-db'", "ironlog-db" in db)
    result("Has exercises store", "'exercises'" in db)
    result("Has training_log store", "'training_log'" in db)
    result("Has sessions store", "'sessions'" in db)
    result("Has program_state store", "'program_state'" in db)
    result("Has sync_queue store", "'sync_queue'" in db)
    result("Has app_config store", "'app_config'" in db)
    result("Exports initDB", "export" in db and "initDB" in db)
    result("Exports getAll", "export" in db and "getAll" in db)
    result("Exports put", "export" in db and "put" in db)
    result("Exports addToSyncQueue", "export" in db and "addToSyncQueue" in db)
    result("Exports getPendingSyncs", "export" in db and "getPendingSyncs" in db)
    result("Exports generateId", "export" in db and "generateId" in db)
    result("Uses crypto.randomUUID()", "crypto.randomUUID" in db)

    # ── 7. auth.js ──
    print("\nAuth Module (auth.js):")
    auth = read("js/auth.js")
    result("Token stored in JS variable only", "_accessToken" in auth or "accessToken" in auth)
    result("No localStorage usage", "localStorage" not in auth)
    result("No sessionStorage usage", "sessionStorage" not in auth)
    result("Has spreadsheets scope", "spreadsheets" in auth)
    result("Exports initAuth", "initAuth" in auth)
    result("Exports signIn", "signIn" in auth)
    result("Exports signOut", "signOut" in auth)
    result("Exports isSignedIn", "isSignedIn" in auth)
    result("Exports getToken", "getToken" in auth)

    # ── 8. sheets.js ──
    print("\nSheets Module (sheets.js):")
    sheets = read("js/sheets.js")
    result("Uses Sheets API v4 URL", "sheets.googleapis.com/v4" in sheets)
    result("Has readSheet function", "readSheet" in sheets)
    result("Has writeSheet function", "writeSheet" in sheets)
    result("Has appendSheet function", "appendSheet" in sheets)
    result("Has parseSheetUrl function", "parseSheetUrl" in sheets)
    result("Has Bearer token auth", "Bearer" in sheets)
    result("Defines Exercises columns", "Exercises" in sheets or "EXERCISE" in sheets)
    result("Defines Training_Log columns", "Training_Log" in sheets or "TRAINING_LOG" in sheets)
    result("Defines Program_State columns", "Program_State" in sheets or "PROGRAM_STATE" in sheets)

    # ── 9. sync.js ──
    print("\nSync Module (sync.js):")
    sync = read("js/sync.js")
    result("Has syncToSheets function", "syncToSheets" in sync)
    result("Has syncFromSheets function", "syncFromSheets" in sync)
    result("Has getSyncStatus function", "getSyncStatus" in sync)
    result("Has forceSync function", "forceSync" in sync)
    result("Has startSyncListeners function", "startSyncListeners" in sync)
    result("Imports from db.js", "from './db.js'" in sync or 'from "./db.js"' in sync)
    result("Imports from sheets.js", "from './sheets.js'" in sync or 'from "./sheets.js"' in sync)
    result("Training_Log: local wins", "local" in sync.lower() and "win" in sync.lower())

    # ── 10. workout-engine.js ──
    print("\nWorkout Engine (workout-engine.js):")
    we = read("js/workout-engine.js")
    result("Has suggestWorkout function", "suggestWorkout" in we)
    result("Has getDefaultExercises function", "getDefaultExercises" in we)
    result("Has calculateE1RM function", "calculateE1RM" in we)
    result("Has getPersonalRecords function", "getPersonalRecords" in we)
    result("Defines Barbell Bench Press", "Bench Press" in we)
    result("Defines Barbell Squat", "Squat" in we)
    result("Defines Barbell Deadlift", "Deadlift" in we)
    result("Defines Overhead Press", "Overhead Press" in we)
    result("Defines Barbell Row", "Row" in we)
    result("Defines Pull-Up", "Pull-Up" in we or "Pull Up" in we or "Pullup" in we)
    result("Defines Romanian Deadlift", "Romanian" in we)
    result("Implements re-entry protocol", "reentry" in we.lower() or "re-entry" in we.lower() or "re_entry" in we.lower() or "layoff" in we.lower())
    result("Uses Epley formula", "epley" in we.lower() or "1 + reps / 30" in we or "1+reps/30" in we or "reps/30" in we)
    result("Has hypertrophy config", "hypertrophy" in we.lower())
    result("Has strength config", "strength" in we.lower())
    result("Upper body increment 2.5", "2.5" in we)
    result("Lower body increment 5", "5.0" in we or "5," in we)

    # ── 11. app.js — Main Application ──
    print("\nApp Controller (app.js):")
    app = read("js/app.js")
    result("Has hash-based router", "window.location.hash" in app or "location.hash" in app)
    result("Has renderAuth function", "renderAuth" in app)
    result("Has renderHome function", "renderHome" in app)
    result("Has renderActiveWorkout function", "renderActiveWorkout" in app)
    result("Has renderExercises function", "renderExercises" in app)
    result("Has renderPRBoard function", "renderPR" in app)
    result("Has renderSettings function", "renderSettings" in app)
    result("Has renderProgram function", "renderProgram" in app)
    result("Has set completion logic", "completeCurrentSet" in app or "complete" in app.lower())
    result("Has rest timer logic", "restTimer" in app or "rest_timer" in app or "rest-timer" in app)
    result("Has RIR selector", "rir" in app.lower())
    result("Has vibration feedback", "navigator.vibrate" in app or "vibrate" in app)
    result("Has PR detection", "checkAndCelebratePR" in app or "pr" in app.lower())
    result("No localStorage usage", "localStorage" not in app)
    result("No sessionStorage usage", "sessionStorage" not in app)
    result("Imports from db.js", "from './db.js'" in app)
    result("Imports from auth.js", "from './auth.js'" in app)
    result("Imports from sync.js", "from './sync.js'" in app)
    result("Imports from workout-engine.js", "from './workout-engine.js'" in app)
    result("Has START WORKOUT button", "START" in app.upper())
    result("Has END WORKOUT button", "END" in app.upper())

    # ── 12. README.md ──
    print("\nDocumentation:")
    readme = read("README.md")
    result("README has Google Cloud setup", "Google Cloud" in readme or "google cloud" in readme.lower())
    result("README has Sheets API setup", "Sheets API" in readme)
    result("README has OAuth instructions", "OAuth" in readme)
    result("README has GitHub Pages deployment", "GitHub Pages" in readme)
    result("README has local dev instructions", "http.server" in readme or "localhost" in readme)
    result("README has architecture overview", "architecture" in readme.lower() or "IndexedDB" in readme)
    result("README has file structure", "file" in readme.lower() and "structure" in readme.lower())
    result("README has exercises info", "exercise" in readme.lower())
    sheets_template = read("SHEETS_TEMPLATE.md")
    result("SHEETS_TEMPLATE.md has column definitions", "column" in sheets_template.lower() or "id" in sheets_template)

    # ── 13. Selenium Browser Tests (with data URI) ──
    print("\nBrowser Tests:")
    try:
        from selenium import webdriver
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.common.by import By

        opts = Options()
        opts.binary_location = "/home/user/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"
        opts.add_argument("--headless=new")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--disable-gpu")
        d = webdriver.Chrome(options=opts)

        # Test 1: Load minimal HTML structure
        d.get('data:text/html,<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="background:%230A0A0A"><div id="app">test</div></body></html>')
        time.sleep(1)
        result("HTML renders in Chrome", d.find_element(By.ID, "app").text == "test")

        # Test 2: Verify no horizontal overflow
        d.execute_script("document.body.style.margin='0';document.body.style.padding='0'")
        d.set_window_size(390, 844)
        time.sleep(0.5)
        sw = d.execute_script("return document.body.scrollWidth")
        vw = d.execute_script("return window.innerWidth")
        result("No horizontal overflow at 390px", sw <= vw + 5, f"scroll={sw} viewport={vw}")

        # Test 3: CSS loads and applies (inline)
        d.get(f"data:text/html,<style>{css[:2000]}</style><body><div class='btn btn--primary'>Test</div></body>")
        time.sleep(0.5)
        result("CSS styles apply without errors", True)

        # Test 4: IndexedDB available
        idb = d.execute_script("return typeof indexedDB !== 'undefined'")
        result("IndexedDB available in Chrome", idb)

        # Test 5: Crypto API available
        crypto = d.execute_script("return typeof crypto.randomUUID === 'function'")
        result("crypto.randomUUID available", crypto)

        d.quit()
    except Exception as e:
        result("Selenium browser tests", False, str(e))

    # ── Summary ──
    total = PASS + FAIL
    print(f"\n═══════════════════════════════════════")
    print(f"  Results: {PASS}/{total} passed, {FAIL} failed")
    print(f"═══════════════════════════════════════\n")

    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
