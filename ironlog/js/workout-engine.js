/**
 * IronLog — Workout Suggestion Engine
 *
 * Implements a research-backed algorithm (values from research-summary.json,
 * hardcoded here so no runtime JSON fetch is needed) to generate the next
 * optimal training session.
 *
 * Research sources baked in:
 *  • Block periodization  (Pubmed 35044672)
 *  • Progressive overload — upper +2.5 kg / lower +5 kg
 *  • Layoff re-entry protocol (50-60%, 40-50%, very-light at 8-14 / 15-21 / 21+ days)
 *  • Warmup: 50% × 5, 70% × 3, 85% × 1
 *  • Epley e1RM: weight × (1 + reps / 30)
 *  • RIR autoregulation (Zourdos et al.)
 */

import {
  initDB,
  getAll,
  get,
  getExerciseHistory,
  getLatestSessionForExercise,
} from './db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Hardcoded research constants
// ─────────────────────────────────────────────────────────────────────────────

const RESEARCH = {
  hypertrophy: {
    sets_per_exercise: { min: 3, max: 4 },  // use 3 by default
    rep_range:         { min: 8, max: 12 },
    rir_target:        { min: 1, max: 3 },
    rest_seconds:      { min: 90, max: 180, default: 120 },
  },
  strength: {
    sets_per_exercise: { min: 3, max: 5 },  // use 4 by default
    rep_range:         { min: 3, max: 5 },
    rir_target:        { min: 1, max: 2 },
    rest_seconds:      { min: 180, max: 300, default: 240 },
  },
  progressive_overload: {
    upper_kg:          2.5,
    lower_kg:          5.0,
  },
  layoff: {
    moderate:  { days_min: 8,  days_max: 14, weight_pct: 0.55 },  // 50-60% → midpoint 55%
    deep:      { days_min: 15, days_max: 21, weight_pct: 0.45 },  // 40-50% → midpoint 45%
    restart:   { days_min: 22, days_max: Infinity, weight_pct: 0.30 }, // very light
  },
  warmup_protocol: [
    { pct: 0.50, reps: 5 },
    { pct: 0.70, reps: 3 },
    { pct: 0.85, reps: 1 },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Default exercise catalogue
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the 7 default compound exercises with full schema fields.
 * @returns {object[]}
 */
export function getDefaultExercises() {
  const now = new Date().toISOString();

  return [
    {
      id:                     crypto.randomUUID(),
      name:                   'Barbell Bench Press',
      category:               'chest',
      muscle_group:           'Chest, Front Delts, Triceps',
      is_compound:            true,
      equipment:              'barbell',
      default_rep_range_min:  8,
      default_rep_range_max:  12,
      utility_for:            [],
      notes:                  'Primary upper-body horizontal push.',
      priority:               false,
      split_day:              'upper',
      created_at:             now,
      updated_at:             now,
    },
    {
      id:                     crypto.randomUUID(),
      name:                   'Barbell Squat',
      category:               'legs',
      muscle_group:           'Quads, Glutes, Hamstrings, Core',
      is_compound:            true,
      equipment:              'barbell',
      default_rep_range_min:  5,
      default_rep_range_max:  8,
      utility_for:            [],
      notes:                  'Primary lower-body compound.',
      priority:               false,
      split_day:              'lower',
      created_at:             now,
      updated_at:             now,
    },
    {
      id:                     crypto.randomUUID(),
      name:                   'Barbell Deadlift',
      category:               'back',
      muscle_group:           'Hamstrings, Glutes, Lower Back, Traps',
      is_compound:            true,
      equipment:              'barbell',
      default_rep_range_min:  3,
      default_rep_range_max:  5,
      utility_for:            [],
      notes:                  'Primary posterior chain compound.',
      priority:               false,
      split_day:              'lower',
      created_at:             now,
      updated_at:             now,
    },
    {
      id:                     crypto.randomUUID(),
      name:                   'Overhead Press',
      category:               'shoulders',
      muscle_group:           'Front Delts, Triceps, Upper Traps',
      is_compound:            true,
      equipment:              'barbell',
      default_rep_range_min:  6,
      default_rep_range_max:  10,
      utility_for:            [],
      notes:                  'Primary overhead push.',
      priority:               false,
      split_day:              'upper',
      created_at:             now,
      updated_at:             now,
    },
    {
      id:                     crypto.randomUUID(),
      name:                   'Barbell Row',
      category:               'back',
      muscle_group:           'Lats, Rhomboids, Biceps, Rear Delts',
      is_compound:            true,
      equipment:              'barbell',
      default_rep_range_min:  6,
      default_rep_range_max:  10,
      utility_for:            [],
      notes:                  'Primary horizontal pull.',
      priority:               false,
      split_day:              'upper',
      created_at:             now,
      updated_at:             now,
    },
    {
      id:                     crypto.randomUUID(),
      name:                   'Pull-Up',
      category:               'back',
      muscle_group:           'Lats, Biceps, Rear Delts',
      is_compound:            true,
      equipment:              'bodyweight',
      default_rep_range_min:  5,
      default_rep_range_max:  10,
      utility_for:            [],
      notes:                  'Vertical pull. Add weight when >10 reps easily achieved.',
      priority:               false,
      split_day:              'upper',
      created_at:             now,
      updated_at:             now,
    },
    {
      id:                     crypto.randomUUID(),
      name:                   'Romanian Deadlift',
      category:               'legs',
      muscle_group:           'Hamstrings, Glutes, Lower Back',
      is_compound:            true,
      equipment:              'barbell',
      default_rep_range_min:  8,
      default_rep_range_max:  12,
      utility_for:            [],
      notes:                  'Hip-hinge accessory; excellent hamstring hypertrophy.',
      priority:               false,
      split_day:              'lower',
      created_at:             now,
      updated_at:             now,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1RM / performance utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Epley formula for estimated 1RM.
 * @param {number} weight  Weight lifted (kg).
 * @param {number} reps    Reps performed.
 * @returns {number} Estimated 1RM in kg (rounded to 2 decimal places).
 */
export function calculateE1RM(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 100) / 100;
}

/**
 * Scans the training_log for an exercise and returns its personal records.
 * @param {string} exerciseId
 * @returns {Promise<{
 *   bestSet:   { weight: number, reps: number, date: string } | null,
 *   bestE1RM:  { value: number, weight: number, reps: number, date: string } | null,
 * }>}
 */
export async function getPersonalRecords(exerciseId) {
  await initDB();
  const history = await getExerciseHistory(exerciseId);

  if (history.length === 0) {
    return { bestSet: null, bestE1RM: null };
  }

  let bestSet  = null;
  let bestE1RM = null;

  for (const entry of history) {
    if (entry.set_type === 'warmup') continue;

    const w  = parseFloat(entry.weight_kg) || 0;
    const r  = parseInt(entry.actual_reps, 10) || 0;
    const e1 = calculateE1RM(w, r);

    if (!bestSet || w > bestSet.weight || (w === bestSet.weight && r > bestSet.reps)) {
      bestSet = { weight: w, reps: r, date: entry.date };
    }

    if (!bestE1RM || e1 > bestE1RM.value) {
      bestE1RM = { value: e1, weight: w, reps: r, date: entry.date };
    }
  }

  return { bestSet, bestE1RM };
}

// ─────────────────────────────────────────────────────────────────────────────
// Weight progression logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines the suggested working weight for next session.
 *
 * Rules (from spec):
 *  • All working sets hit target at RIR >= 2  → +2.5 kg (upper) / +5 kg (lower)
 *  • RIR consistently 0-1                     → same weight
 *  • 2+ sets failed (actual < target)         → −5%
 *
 * @param {object[]} lastSets   Working sets from the last session.
 * @param {'upper'|'lower'} splitDay
 * @param {number} lastWeight   The weight used last session.
 * @returns {number} Suggested weight in kg (rounded to nearest 0.5 kg).
 */
function _progressWeight(lastSets, splitDay, lastWeight) {
  if (!lastSets || lastSets.length === 0) return lastWeight;

  const working = lastSets.filter(s => s.set_type === 'working');
  if (working.length === 0) return lastWeight;

  const increment = splitDay === 'lower'
    ? RESEARCH.progressive_overload.lower_kg
    : RESEARCH.progressive_overload.upper_kg;

  // Count failures and high-RIR sets
  let allHitTargetHighRIR = true;
  let failedSets          = 0;
  let lowRIRCount         = 0;

  for (const s of working) {
    const actual = parseInt(s.actual_reps, 10) || 0;
    const target = parseInt(s.target_reps, 10) || 0;
    const rir    = parseInt(s.rir, 10);

    if (actual < target) {
      failedSets++;
      allHitTargetHighRIR = false;
    } else if (!isNaN(rir) && rir <= 1) {
      allHitTargetHighRIR = false;
      lowRIRCount++;
    }
  }

  let newWeight;
  if (failedSets >= 2) {
    newWeight = lastWeight * 0.95;
  } else if (allHitTargetHighRIR) {
    newWeight = lastWeight + increment;
  } else {
    newWeight = lastWeight; // maintain
  }

  // Round to nearest 0.5 kg plate increment
  return Math.round(newWeight * 2) / 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Warmup set generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates warmup sets at 50%, 70%, 85% of working weight.
 * @param {number} workingWeight
 * @returns {{ weight: number, reps: number }[]}
 */
function _generateWarmupSets(workingWeight) {
  return RESEARCH.warmup_protocol.map(({ pct, reps }) => ({
    weight: Math.round(workingWeight * pct * 2) / 2, // nearest 0.5 kg
    reps,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-entry protocol
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the re-entry protocol identifier for a given days gap.
 * @param {number} daysSince
 * @returns {null|'moderate'|'deep'|'restart'}
 */
function _getReentryProtocol(daysSince) {
  if (daysSince < 8)  return null;
  if (daysSince <= 14) return 'moderate';
  if (daysSince <= 21) return 'deep';
  return 'restart';
}

/**
 * Returns the weight multiplier for a re-entry protocol.
 * @param {null|'moderate'|'deep'|'restart'} protocol
 * @returns {number}
 */
function _reentryMultiplier(protocol) {
  if (!protocol) return 1.0;
  return RESEARCH.layoff[protocol].weight_pct;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main suggestion function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates the next recommended workout.
 *
 * @returns {Promise<{
 *   splitDay: 'upper'|'lower',
 *   phase: 'hypertrophy'|'strength',
 *   exercises: Array<{
 *     exerciseId: string,
 *     exerciseName: string,
 *     warmupSets: Array<{weight: number, reps: number}>,
 *     workingSets: number,
 *     targetReps: number,
 *     suggestedWeight: number,
 *     restSeconds: number,
 *     isPriority: boolean,
 *     isAccessory: boolean,
 *   }>,
 *   daysSinceLastSession: number,
 *   reentryProtocol: null|'moderate'|'deep'|'restart',
 *   volumeAdjustment: 0|-1,
 *   rationale: string,
 * }>}
 */
export async function suggestWorkout() {
  await initDB();

  // ── 1. Load program state ─────────────────────────────────────────────────
  const allState   = await getAll('program_state');
  const stateMap   = Object.fromEntries(allState.map(r => [r.key, r.value]));

  const phase            = (stateMap.current_mesocycle ?? 'hypertrophy');
  const lastSessionDate  = stateMap.last_session_date ?? null;
  const lastSplitDay     = stateMap.last_split_day    ?? 'lower';  // default so first session is upper
  const priorityExId     = stateMap.priority_exercise_id ?? null;

  // ── 2. Days since last session ────────────────────────────────────────────
  let daysSince = 0;
  if (lastSessionDate) {
    const last = new Date(lastSessionDate);
    const now  = new Date();
    daysSince  = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  }

  // ── 3. Re-entry protocol ──────────────────────────────────────────────────
  const reentryProtocol  = _getReentryProtocol(daysSince);
  const weightMultiplier = _reentryMultiplier(reentryProtocol);

  // ── 4. Volume adjustment (4-7 day gap: 1 fewer working set) ──────────────
  const volumeAdjustment = (daysSince >= 4 && daysSince <= 7) ? -1 : 0;

  // ── 5. Determine next split day ───────────────────────────────────────────
  const splitDay = lastSplitDay === 'upper' ? 'lower' : 'upper';

  // ── 6. Phase scheme ───────────────────────────────────────────────────────
  const scheme     = RESEARCH[phase] ?? RESEARCH.hypertrophy;
  const baseSets   = phase === 'strength' ? 4 : 3;
  const targetReps = phase === 'strength'
    ? scheme.rep_range.min        // e.g. 3
    : Math.round((scheme.rep_range.min + scheme.rep_range.max) / 2); // e.g. 10
  const restSecs   = scheme.rest_seconds.default;

  // ── 7. Fetch exercises for this split day ─────────────────────────────────
  let allExercises = await getAll('exercises');

  // Fallback: if no exercises in DB, use defaults for suggestion purposes only
  if (!allExercises || allExercises.length === 0) {
    allExercises = getDefaultExercises();
  }

  const splitExercises = allExercises.filter(
    ex => ex.split_day === splitDay || !ex.split_day
  );

  // ── 8. Determine which exercises to include ───────────────────────────────
  let exercisePool = [...splitExercises];

  // Priority exercise: include in every session regardless of split
  let priorityExercise = null;
  if (priorityExId) {
    priorityExercise = allExercises.find(ex => ex.id === priorityExId) ?? null;
    if (priorityExercise && !exercisePool.find(ex => ex.id === priorityExId)) {
      exercisePool.unshift(priorityExercise);
    }
  }

  // Utility exercises for the priority exercise
  if (priorityExercise && Array.isArray(priorityExercise.utility_for)) {
    for (const utilityName of priorityExercise.utility_for) {
      const utilEx = allExercises.find(
        ex => ex.name.toLowerCase() === utilityName.toLowerCase()
      );
      if (utilEx && !exercisePool.find(ex => ex.id === utilEx.id)) {
        exercisePool.push(utilEx);
      }
    }
  }

  // ── 9. Build exercise suggestions ─────────────────────────────────────────
  const rationale_parts = [
    `Split day: ${splitDay.toUpperCase()}.`,
    `Phase: ${phase}.`,
    daysSince > 0 ? `${daysSince} day(s) since last session.` : 'First session.',
    reentryProtocol ? `Re-entry protocol: ${reentryProtocol} (${Math.round(weightMultiplier * 100)}% of working weight).` : '',
    volumeAdjustment < 0 ? 'Volume reduced by 1 set per exercise (4-7 day gap).' : '',
  ].filter(Boolean).join(' ');

  const exercises = [];

  for (const ex of exercisePool) {
    const isPriority = ex.id === priorityExId;
    const isAccessory = !ex.is_compound;

    // Working sets count
    const workingSets = Math.max(1, baseSets + volumeAdjustment + (isPriority ? 1 : 0));

    // Suggested weight: base on last session performance
    const lastSets     = await getLatestSessionForExercise(ex.id);
    const lastWorkSets = lastSets.filter(s => s.set_type === 'working');
    const lastWeight   = lastWorkSets.length > 0
      ? (parseFloat(lastWorkSets[lastWorkSets.length - 1].weight_kg) || 0)
      : 0;

    let suggestedWeight = 0;

    if (lastWeight > 0) {
      // Progress based on last performance
      const progressed  = _progressWeight(lastWorkSets, splitDay, lastWeight);
      suggestedWeight   = Math.round(progressed * weightMultiplier * 2) / 2;
    } else {
      // No history — suggest a conservative starter weight
      suggestedWeight = ex.category === 'legs' ? 60 : 40;
      if (ex.equipment === 'bodyweight') suggestedWeight = 0;
    }

    // Ensure minimum sensible weight
    if (suggestedWeight < 0) suggestedWeight = 20;

    const warmupSets = ex.equipment === 'bodyweight'
      ? []
      : _generateWarmupSets(suggestedWeight);

    exercises.push({
      exerciseId:      ex.id,
      exerciseName:    ex.name,
      warmupSets,
      workingSets,
      targetReps,
      suggestedWeight,
      restSeconds:     restSecs,
      isPriority,
      isAccessory,
    });
  }

  return {
    splitDay,
    phase,
    exercises,
    daysSinceLastSession: daysSince,
    reentryProtocol,
    volumeAdjustment,
    rationale: rationale_parts,
  };
}
