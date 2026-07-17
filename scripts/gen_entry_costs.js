/**
 * Phase 1: Calibrate stamina field index per quest type by matching OLD values.
 * Phase 2: Generate complete quest_entry_costs.json.
 * Phase 3: Diff old vs new.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const OM = path.resolve(__dirname, "..", "..", "wf-assets-cn", "orderedmap");
const OUT = path.join(__dirname, "..", "assets", "quest_entry_costs.json");

function readJSON(p) {
  try { return JSON.parse(fs.readFileSync(path.join(OM, p), "utf8")); } catch { return null; }
}

const oldCosts = JSON.parse(fs.readFileSync(OUT, "utf8")); // currently the OLD file

// Quest type → {file, category}
const QUEST_TYPES = {
  main_quest: { file: "quest/main_quest.json", cat: 1 },
  ex_quest: { file: "quest/ex_quest.json", cat: 4 },
  boss_battle_quest: { file: "quest/boss_battle_quest.json", cat: 2 },
  character_quest: { file: "quest/character_quest.json", cat: 3 },
  advent_event_quest: { file: "quest/event/advent_event_quest.json", cat: 7 },
  carnival_event_quest: { file: "quest/event/carnival_event_quest.json", cat: 22 },
  challenge_dungeon_event_quest: {
    file: "quest/event/challenge_dungeon_event_quest.json",
    cat: 13,
    entryItem: { modeIndex: 56, itemIdIndex: 57, itemCountIndex: 58, staminaIndex: 70 },
  },
  daily_exp_mana_event_quest: { file: "quest/event/daily_exp_mana_event_quest.json", cat: 14 },
  daily_week_event_quest: { file: "quest/event/daily_week_event_quest.json", cat: 6 },
  expert_single_event_quest: { file: "quest/event/expert_single_event_quest.json", cat: 21 },
  // Fields 50 and 69 both equal 1 on the first row, so first-match calibration is ambiguous.
  hard_multi_event_quest: { file: "quest/event/hard_multi_event_quest.json", cat: 26, staminaIndex: 69 },
  raid_event_quest: { file: "quest/event/raid_event_quest.json", cat: 8 },
  ranking_event_single_quest: { file: "quest/event/ranking_event_single_quest.json", cat: 10 },
  rush_event_quest: { file: "quest/event/rush_event_quest.json", cat: 24 },
  score_attack_event_quest: { file: "quest/event/score_attack_event_quest.json", cat: 9 },
  solo_time_attack_event_quest: { file: "quest/event/solo_time_attack_event_quest.json", cat: 25 },
  story_event_single_quest: { file: "quest/event/story_event_single_quest.json", cat: 11 },
  tower_dungeon_event_quest: { file: "quest/event/tower_dungeon_event_quest.json", cat: 20 },
  world_story_event_quest: { file: "quest/event/world_story_event_quest.json", cat: 18 },
  world_story_event_boss_battle_quest: { file: "quest/event/world_story_event_boss_battle_quest.json", cat: 19 },
};

// Walk nested quest data
function walk(obj, onQuest) {
  for (const [, val] of Object.entries(obj)) {
    if (Array.isArray(val) && Array.isArray(val[0])) {
      const f = val[0];
      if (f[0] && f.length > 0) onQuest(f);
    } else if (typeof val === "object" && !Array.isArray(val)) {
      walk(val, onQuest);
    }
  }
}

// Phase 1: Calibrate field index using OLD values
console.log("=== Phase 1: Calibrate stamina field indices ===\n");

const indices = {};
for (const [name, cfg] of Object.entries(QUEST_TYPES)) {
  const obj = readJSON(cfg.file);
  if (!obj) continue;

  let idx = cfg.staminaIndex ?? cfg.entryItem?.staminaIndex ?? null;
  walk(obj, (f) => {
    if (idx !== null) return;
    const qid = f[0];
    const key = `${cfg.cat}_${qid}`;
    if (oldCosts[key] && oldCosts[key].stamina > 0) {
      const oldVal = oldCosts[key].stamina;
      // Find field that matches oldVal
      for (let i = 50; i < Math.min(f.length, 120); i++) {
        if (parseInt(f[i]) === oldVal) {
          idx = i;
          return;
        }
      }
    }
  });

  if (idx !== null) {
    indices[name] = idx;
    console.log(`  ${name}: field[${idx}] (verified)`);
  } else {
    // Try common relative positions based on converter.py known fields
    // For most quest types, scoreRewardGroupId is at a known position.
    // Let's check where the first numeric value near that position is.
    let best = null;
    walk(obj, (f) => {
      if (best !== null) return;
      // Try to find any positive integer between field 60-100
      for (let i = 60; i <= 100; i++) {
        const v = parseInt(f[i]);
        if (!isNaN(v) && v > 0 && v <= 100) {
          best = i;
          return;
        }
      }
    });
    indices[name] = best;
    console.log(`  ${name}: field[${best}] (best guess)`);
  }
}

// Phase 2: Generate complete entry costs
console.log("\n=== Phase 2: Generate complete entry costs ===\n");

const result = {};
const details = {}; // for diff comparison

for (const [name, cfg] of Object.entries(QUEST_TYPES)) {
  const obj = readJSON(cfg.file);
  if (!obj) continue;

  const idx = indices[name];
  if (idx === null) continue;

  let total = 0,
    withStamina = 0;
  walk(obj, (f) => {
    total++;
    const qid = f[0];
    const st = parseInt(f[idx]);
    if (!isNaN(st) && st > 0) {
      withStamina++;
      const key = `${cfg.cat}_${qid}`;
      const itemMode = cfg.entryItem ? parseInt(f[cfg.entryItem.modeIndex]) : 0;
      const itemId = cfg.entryItem && itemMode === 1
        ? parseInt(f[cfg.entryItem.itemIdIndex])
        : 0;
      const itemCount = cfg.entryItem && itemMode === 1
        ? parseInt(f[cfg.entryItem.itemCountIndex])
        : 0;
      result[key] = cfg.entryItem && itemMode === 1
        ? { itemMode, itemId, itemCount, stamina: st }
        : { itemId, itemCount, stamina: st };
      details[key] = { new: st, old: oldCosts[key]?.stamina ?? null };
    }
  });
  console.log(`  ${name}: ${total} quests, ${withStamina} with stamina > 0`);
}

console.log(`\nTotal entries: ${Object.keys(result).length}`);

for (let questId = 2001; questId <= 2006; questId++) {
  assert.deepStrictEqual(
    result[`13_${questId}`],
    { itemMode: 1, itemId: 500000, itemCount: 1, stamina: 10 },
    `invalid treasure domain entry cost for quest ${questId}`,
  );
}

// Phase 3: Diff
console.log("\n=== Phase 3: Diff OLD vs NEW ===\n");

let added = 0,
  removed = 0,
  changed = 0,
  unchanged = 0;
const diffs = [];

// Entries in OLD but not in NEW
for (const [key, val] of Object.entries(oldCosts)) {
  if (!result[key]) {
    removed++;
    diffs.push({ key, type: "REMOVED", old: val.stamina, new: null });
  } else if (result[key].stamina !== val.stamina) {
    changed++;
    diffs.push({ key, type: "CHANGED", old: val.stamina, new: result[key].stamina });
  } else {
    unchanged++;
  }
}
// Entries in NEW but not in OLD
for (const [key, val] of Object.entries(result)) {
  if (!oldCosts[key]) {
    added++;
    diffs.push({ key, type: "ADDED", old: null, new: val.stamina });
  }
}

console.log(`  Added:      ${added}`);
console.log(`  Removed:    ${removed}`);
console.log(`  Changed:    ${changed} (OLD was wrong)`);
console.log(`  Unchanged:  ${unchanged}`);

// Show changed values
if (changed > 0) {
  console.log(`\n  CHANGED entries (OLD → NEW):`);
  const changedList = diffs.filter((d) => d.type === "CHANGED");
  changedList.slice(0, 30).forEach((d) => console.log(`    ${d.key}: ${d.old} → ${d.new}`));
  if (changedList.length > 30) console.log(`    ... and ${changedList.length - 30} more`);
}

// Show removed (old data that shouldn't exist)
if (removed > 0) {
  console.log(`\n  REMOVED entries (stale data):`);
  diffs
    .filter((d) => d.type === "REMOVED")
    .slice(0, 20)
    .forEach((d) => console.log(`    ${d.key}: ${d.old} (quest no longer exists)`));
}

// Show added (new coverage)
if (added > 0) {
  console.log(`\n  ADDED entries (new coverage):`);
  const byCat = {};
  diffs
    .filter((d) => d.type === "ADDED")
    .forEach((d) => {
      const cat = d.key.split("_")[0];
      if (!byCat[cat]) byCat[cat] = 0;
      byCat[cat]++;
    });
  for (const [cat, count] of Object.entries(byCat)) {
    console.log(`    category ${cat}: ${count} quests`);
  }
}

// Write new file
fs.writeFileSync(OUT, JSON.stringify(result));
console.log(`\nWritten to ${OUT}`);
