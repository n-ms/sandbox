"""
IronLog PWA — Selenium Tests
Tests verify the app loads, renders screens correctly, and key interactions work.
"""

import http.server
import json
import os
import socketserver
import threading
import time
import unittest

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

PORT = 8234
BASE_URL = f"http://127.0.0.1:{PORT}"
CHROME_BINARY = "/home/user/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass


# ── Shared driver and server ──
_driver = None
_server = None


def get_driver():
    global _driver
    if _driver is None:
        options = Options()
        if os.path.exists(CHROME_BINARY):
            options.binary_location = CHROME_BINARY
        options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--window-size=390,844")
        _driver = webdriver.Chrome(options=options)
        _driver.set_page_load_timeout(15)
        _driver.implicitly_wait(2)
    return _driver


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def start_server():
    global _server
    if _server is None:
        os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
        _server = ReusableTCPServer(("127.0.0.1", PORT), QuietHandler)
        t = threading.Thread(target=_server.serve_forever, daemon=True)
        t.start()
        time.sleep(1)


def seed_db(driver):
    """Seed IndexedDB to bypass auth."""
    driver.execute_script("""
        return new Promise((resolve) => {
            const req = indexedDB.open('ironlog-db', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('exercises')) {
                    const s = db.createObjectStore('exercises', {keyPath:'id'});
                    s.createIndex('name','name',{unique:false});
                    s.createIndex('category','category',{unique:false});
                    s.createIndex('is_compound','is_compound',{unique:false});
                    s.createIndex('priority','priority',{unique:false});
                }
                if (!db.objectStoreNames.contains('program_state'))
                    db.createObjectStore('program_state', {keyPath:'key'});
                if (!db.objectStoreNames.contains('training_log')) {
                    const s = db.createObjectStore('training_log', {keyPath:'id'});
                    s.createIndex('session_id','session_id',{unique:false});
                    s.createIndex('exercise_id','exercise_id',{unique:false});
                    s.createIndex('date','date',{unique:false});
                }
                if (!db.objectStoreNames.contains('sessions')) {
                    const s = db.createObjectStore('sessions', {keyPath:'id'});
                    s.createIndex('date','date',{unique:false});
                    s.createIndex('status','status',{unique:false});
                }
                if (!db.objectStoreNames.contains('sync_queue')) {
                    const s = db.createObjectStore('sync_queue', {keyPath:'id'});
                    s.createIndex('status','status',{unique:false});
                    s.createIndex('created_at','created_at',{unique:false});
                }
                if (!db.objectStoreNames.contains('app_config'))
                    db.createObjectStore('app_config', {keyPath:'key'});
            };
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction(['app_config','exercises','program_state'], 'readwrite');
                tx.objectStore('app_config').put({key:'setup_complete', value:true});
                const now = new Date().toISOString();
                const exs = [
                    {id:'ex-bench',name:'Barbell Bench Press',category:'chest',muscle_group:'chest,triceps',is_compound:true,equipment:'barbell',default_rep_range_min:5,default_rep_range_max:12,utility_for:[],notes:'',priority:false,created_at:now,updated_at:now},
                    {id:'ex-squat',name:'Barbell Squat',category:'legs',muscle_group:'quads,glutes',is_compound:true,equipment:'barbell',default_rep_range_min:5,default_rep_range_max:12,utility_for:[],notes:'',priority:false,created_at:now,updated_at:now},
                    {id:'ex-dead',name:'Barbell Deadlift',category:'back',muscle_group:'hamstrings,back',is_compound:true,equipment:'barbell',default_rep_range_min:3,default_rep_range_max:8,utility_for:[],notes:'',priority:false,created_at:now,updated_at:now},
                    {id:'ex-ohp',name:'Overhead Press',category:'shoulders',muscle_group:'delts,triceps',is_compound:true,equipment:'barbell',default_rep_range_min:5,default_rep_range_max:12,utility_for:[],notes:'',priority:false,created_at:now,updated_at:now},
                    {id:'ex-row',name:'Barbell Row',category:'back',muscle_group:'lats,biceps',is_compound:true,equipment:'barbell',default_rep_range_min:5,default_rep_range_max:12,utility_for:[],notes:'',priority:false,created_at:now,updated_at:now},
                ];
                exs.forEach(ex => tx.objectStore('exercises').put(ex));
                [{key:'current_mesocycle',value:'hypertrophy'},{key:'mesocycle_week',value:1},{key:'training_split',value:'upper_lower_4'},{key:'deload_scheduled',value:false},{key:'last_session_date',value:''},{key:'last_split_day',value:''},{key:'bodyweight_kg',value:75}].forEach(s => tx.objectStore('program_state').put(s));
                tx.oncomplete = () => { db.close(); resolve(true); };
            };
        });
    """)
    time.sleep(0.5)


class TestIronLog(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        start_server()
        cls.driver = get_driver()
        cls.driver.get(BASE_URL)
        time.sleep(3)

    @classmethod
    def tearDownClass(cls):
        if cls.driver:
            cls.driver.quit()

    # ── App Load Tests ──

    def test_01_html_loads(self):
        """Page title should be IronLog."""
        self.assertEqual("IronLog", self.driver.title)

    def test_02_app_container_exists(self):
        """The #app container should exist."""
        app_el = self.driver.find_element(By.ID, "app")
        self.assertIsNotNone(app_el)

    def test_03_dark_background(self):
        """Body should have a dark background."""
        import re
        bg = self.driver.execute_script("return getComputedStyle(document.body).backgroundColor")
        match = re.search(r"rgb\((\d+),\s*(\d+),\s*(\d+)\)", bg)
        if match:
            r, g, b = int(match.group(1)), int(match.group(2)), int(match.group(3))
            self.assertLess(max(r, g, b), 30, f"Background too bright: {bg}")

    def test_04_auth_screen_on_first_load(self):
        """Should redirect to auth screen on first load."""
        self.assertIn("#/auth", self.driver.current_url)

    def test_05_auth_has_input(self):
        """Auth screen should have an input field."""
        inputs = self.driver.find_elements(By.CSS_SELECTOR, "#app input")
        self.assertGreater(len(inputs), 0)

    def test_06_nav_hidden_on_auth(self):
        """Bottom nav should be hidden on auth."""
        nav = self.driver.find_element(By.ID, "bottom-nav")
        self.assertIn("hidden", nav.get_attribute("class") or "")

    # ── Post-Auth Tests ──

    def test_07_seed_db_and_navigate_home(self):
        """After seeding DB, home screen should load."""
        seed_db(self.driver)
        self.driver.get(BASE_URL + "/#/")
        time.sleep(3)
        content = self.driver.find_element(By.ID, "app").get_attribute("innerHTML")
        self.assertTrue(len(content) > 100, "Home screen content too short")

    def test_08_home_shows_workout_suggestion(self):
        """Home screen should show workout suggestion."""
        content = self.driver.find_element(By.ID, "app").get_attribute("innerHTML").upper()
        self.assertTrue(
            "WORKOUT" in content or "EXERCISE" in content or "SESSION" in content,
            "No workout content on home screen"
        )

    def test_09_bottom_nav_visible(self):
        """Bottom nav should be visible on home screen."""
        nav = self.driver.find_element(By.ID, "bottom-nav")
        self.assertNotIn("hidden", nav.get_attribute("class") or "")

    def test_10_exercises_screen(self):
        """Exercises screen should list exercises."""
        self.driver.get(BASE_URL + "/#/exercises")
        time.sleep(3)
        content = self.driver.find_element(By.ID, "app").get_attribute("innerHTML")
        self.assertIn("Bench Press", content)

    def test_11_settings_screen(self):
        """Settings screen should render."""
        self.driver.get(BASE_URL + "/#/settings")
        time.sleep(3)
        content = self.driver.find_element(By.ID, "app").get_attribute("innerHTML").upper()
        self.assertTrue("SETTING" in content or "SYNC" in content or "BODYWEIGHT" in content)

    def test_12_program_screen(self):
        """Program logic screen should show methodology."""
        self.driver.get(BASE_URL + "/#/program")
        time.sleep(3)
        content = self.driver.find_element(By.ID, "app").get_attribute("innerHTML").upper()
        self.assertTrue("PERIODIZATION" in content or "MESOCYCLE" in content or "PROGRAM" in content)

    def test_13_pr_board_screen(self):
        """PR board should render."""
        self.driver.get(BASE_URL + "/#/prs")
        time.sleep(3)
        content = self.driver.find_element(By.ID, "app").get_attribute("innerHTML").upper()
        self.assertTrue("RECORD" in content or "PR" in content or "PERSONAL" in content)

    # ── IndexedDB Tests ──

    def test_14_indexeddb_stores_created(self):
        """All 6 object stores should exist."""
        stores = self.driver.execute_script("""
            return new Promise(r => {
                const req = indexedDB.open('ironlog-db');
                req.onsuccess = () => { const db=req.result; r(Array.from(db.objectStoreNames)); db.close(); };
                req.onerror = () => r([]);
            });
        """)
        for s in ["exercises", "training_log", "sessions", "program_state", "sync_queue", "app_config"]:
            self.assertIn(s, stores, f"Missing store: {s}")

    # ── PWA Tests ──

    def test_15_manifest_exists(self):
        """Manifest link should be in HTML."""
        links = self.driver.find_elements(By.CSS_SELECTOR, 'link[rel="manifest"]')
        self.assertGreater(len(links), 0)

    def test_16_manifest_valid(self):
        """manifest.json should have required fields."""
        self.driver.get(BASE_URL + "/manifest.json")
        time.sleep(1)
        try:
            text = self.driver.find_element(By.TAG_NAME, "pre").text
        except Exception:
            text = self.driver.find_element(By.TAG_NAME, "body").text
        manifest = json.loads(text)
        self.assertEqual(manifest.get("name"), "IronLog")
        self.assertEqual(manifest.get("display"), "standalone")

    def test_17_service_worker_exists(self):
        """sw.js should be servable."""
        self.driver.get(BASE_URL + "/sw.js")
        time.sleep(1)
        body = self.driver.find_element(By.TAG_NAME, "body").text
        self.assertIn("ironlog", body.lower())

    # ── Responsive Tests ──

    def test_18_no_horizontal_overflow(self):
        """No horizontal overflow at mobile width."""
        self.driver.get(BASE_URL + "/#/")
        time.sleep(2)
        self.driver.set_window_size(390, 844)
        time.sleep(1)
        sw = self.driver.execute_script("return document.body.scrollWidth")
        vw = self.driver.execute_script("return window.innerWidth")
        self.assertLessEqual(sw, vw + 10, f"Horizontal overflow: scroll={sw}, viewport={vw}")

    # ── Design Token Tests ──

    def test_19_css_custom_properties(self):
        """Key CSS custom properties should be defined."""
        self.driver.get(BASE_URL + "/#/")
        time.sleep(2)
        for prop in ["--accent", "--bg", "--surface"]:
            val = self.driver.execute_script(
                f"return getComputedStyle(document.documentElement).getPropertyValue('{prop}').trim()"
            )
            self.assertTrue(len(val) > 0, f"CSS property {prop} not defined")


if __name__ == "__main__":
    unittest.main(verbosity=2)
