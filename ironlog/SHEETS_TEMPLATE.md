# IronLog — Google Sheets Template Reference

This document is the canonical reference for the Google Sheet structure used by IronLog. Use it to manually recreate the sheet from scratch, verify an existing sheet's structure, or understand what the sync engine expects.

---

## Overview

The IronLog Google Sheet must contain exactly **three tabs** with the names below (case-sensitive):

| Tab Name | Purpose |
|---|---|
| `Exercises` | Master exercise library |
| `Training_Log` | Every logged set from every session |
| `Program_State` | Key-value pairs for mesocycle and split state |

---

## Tab 1: `Exercises`

### Column Headers (Row 1)

Place these headers in columns A–J of the `Exercises` tab:

```
A: id
B: name
C: category
D: muscle_group
E: is_compound
F: equipment
G: default_rep_range_min
H: default_rep_range_max
I: utility_for
J: notes
```

### Column Descriptions

| Column | Type | Description |
|---|---|---|
| `id` | String | Unique identifier. Format: `ex_001`, `ex_002`, … Do not reuse IDs. |
| `name` | String | Full display name of the exercise |
| `category` | String | `Upper` or `Lower` |
| `muscle_group` | String | Primary and secondary muscles, comma-separated |
| `is_compound` | Boolean | `TRUE` for multi-joint movements, `FALSE` for isolation |
| `equipment` | String | Equipment required (e.g., `Barbell`, `Dumbbell`, `Machine`, `Bodyweight/Band`) |
| `default_rep_range_min` | Integer | Minimum reps for a working set |
| `default_rep_range_max` | Integer | Maximum reps for a working set |
| `utility_for` | String | Comma-separated phase tags: `strength`, `hypertrophy`, or both |
| `notes` | String | Optional coaching notes or form cues |

### Pre-Populated Data Rows (Rows 2–8)

Copy this data exactly into the `Exercises` tab starting at Row 2:

| id | name | category | muscle_group | is_compound | equipment | default_rep_range_min | default_rep_range_max | utility_for | notes |
|---|---|---|---|---|---|---|---|---|---|
| ex_001 | Barbell Back Squat | Lower | Quads, Glutes, Hamstrings | TRUE | Barbell | 5 | 8 | strength,hypertrophy | Primary lower body compound |
| ex_002 | Romanian Deadlift | Lower | Hamstrings, Glutes | TRUE | Barbell | 8 | 12 | hypertrophy | Hip-hinge pattern; keep back neutral |
| ex_003 | Barbell Bench Press | Upper | Chest, Triceps, Anterior Deltoid | TRUE | Barbell | 5 | 8 | strength,hypertrophy | Primary horizontal push |
| ex_004 | Barbell Row | Upper | Lats, Rhomboids, Biceps | TRUE | Barbell | 6 | 10 | strength,hypertrophy | Primary horizontal pull |
| ex_005 | Overhead Press | Upper | Deltoids, Triceps, Upper Traps | TRUE | Barbell | 6 | 10 | strength,hypertrophy | Primary vertical push |
| ex_006 | Pull-Up | Upper | Lats, Biceps, Rear Deltoid | TRUE | Bodyweight/Band | 6 | 12 | hypertrophy | Add load via belt if bodyweight too easy |
| ex_007 | Leg Press | Lower | Quads, Glutes | FALSE | Machine | 10 | 15 | hypertrophy | Accessory lower; easier to push near failure |

### Adding More Exercises

To add a custom exercise, append a new row after Row 8:
- Assign the next sequential `id` (e.g., `ex_008`)
- Fill all 10 columns
- The app will pick up the new exercise on its next inbound sync

---

## Tab 2: `Training_Log`

### Column Headers (Row 1)

Place these headers in columns A–M of the `Training_Log` tab:

```
A: id
B: session_id
C: exercise_id
D: exercise_name
E: date
F: set_number
G: set_type
H: target_reps
I: actual_reps
J: weight_kg
K: rir
L: rest_seconds
M: notes
```

### Column Descriptions

| Column | Type | Description |
|---|---|---|
| `id` | String | Unique set record ID. Format: UUID or `log_<timestamp>_<set>` |
| `session_id` | String | Groups all sets from one session. Format: `sess_<timestamp>` |
| `exercise_id` | String | References `id` in the `Exercises` tab |
| `exercise_name` | String | Denormalized name (for readability in the Sheet) |
| `date` | String | ISO 8601 date: `YYYY-MM-DD` |
| `set_number` | Integer | 1-indexed set number within the exercise block |
| `set_type` | String | `warmup`, `working`, or `backoff` |
| `target_reps` | Integer | Programmed rep target for this set |
| `actual_reps` | Integer | Reps actually completed |
| `weight_kg` | Number | Load in kilograms (use `0` for bodyweight sets) |
| `rir` | Integer | Reps in Reserve logged after the set (0–5+) |
| `rest_seconds` | Integer | Rest taken before this set, in seconds |
| `notes` | String | Optional per-set notes (e.g., "form breakdown on last rep") |

### Initial State

Leave the `Training_Log` tab **empty** below the header row. The app will populate it as you log sessions.

---

## Tab 3: `Program_State`

### Column Headers (Row 1)

Place these headers in columns A–B of the `Program_State` tab:

```
A: key
B: value
```

### Pre-Populated Data Rows (Rows 2–9)

Copy this data exactly into the `Program_State` tab starting at Row 2:

| key | value |
|---|---|
| current_mesocycle | hypertrophy |
| mesocycle_week | 1 |
| training_split | upper_lower_4 |
| deload_scheduled | false |
| last_session_date | *(leave empty)* |
| last_split_day | *(leave empty)* |
| priority_exercise_id | *(leave empty)* |
| bodyweight_kg | 75 |

### Key Descriptions

| Key | Allowed Values | Description |
|---|---|---|
| `current_mesocycle` | `hypertrophy`, `strength`, `deload` | The active training phase |
| `mesocycle_week` | Integer (1–8) | Current week within the mesocycle |
| `training_split` | `upper_lower_4` | Training split template. (Only one split currently supported) |
| `deload_scheduled` | `true`, `false` | When `true`, the next session will be a deload session |
| `last_session_date` | `YYYY-MM-DD` or empty | Date of the most recently completed session |
| `last_split_day` | `upper_a`, `lower_a`, `upper_b`, `lower_b` or empty | Last completed day in the rotation |
| `priority_exercise_id` | Exercise `id` or empty | If set, the app prioritises this exercise for additional volume |
| `bodyweight_kg` | Number | Your current bodyweight, used for bodyweight exercise load calculations |

### Editing Program State Manually

You can edit any value in the `Program_State` tab directly in the Sheet. On the next inbound sync, the app will apply the new values (Sheets wins for `Program_State`). For example:
- To restart at Week 1: set `mesocycle_week` to `1`
- To force a deload: set `deload_scheduled` to `true`
- To switch phase early: set `current_mesocycle` to `strength`

---

## Spreadsheet Sharing & Permissions

The sheet only needs to be accessible to your own Google account. Do **not** share it publicly. The OAuth flow grants the app permission to read and write to your own sheets on your behalf — no sharing required.

If you want to access IronLog from multiple devices (e.g., phone and tablet), sign in with the same Google account on each device and use the same Spreadsheet URL in Settings.

---

## Quick Checklist

Before configuring the app, verify:

- [ ] Three tabs exist: `Exercises`, `Training_Log`, `Program_State` (exact case)
- [ ] `Exercises` tab has headers in Row 1, columns A–J
- [ ] `Exercises` tab has 7 data rows (Rows 2–8)
- [ ] `Training_Log` tab has headers in Row 1, columns A–M
- [ ] `Training_Log` tab has no data rows yet
- [ ] `Program_State` tab has headers in Row 1, columns A–B
- [ ] `Program_State` tab has 8 data rows (Rows 2–9)
- [ ] `current_mesocycle` is set to `hypertrophy`
- [ ] `mesocycle_week` is set to `1`
- [ ] `bodyweight_kg` is updated to your actual bodyweight
- [ ] Spreadsheet URL is copied and pasted into the app's Settings screen

---

*For setup instructions and full documentation, see [README.md](README.md).*
