# Mission system completion audit

## Fixed in the local mission completion module

- Category mission progress now uses `players_category_missions` with
  `(category, mission_id, player_id)` identity. Equal regular, daily, event,
  weekly, and Awake IDs no longer overwrite one another.
- Database version 3 migrates known CharacterAwake rows out of the legacy
  ActiveMission tables. Ambiguous historical category rows are not guessed.
- Progress writes use SQLite UPSERT instead of `INSERT OR REPLACE`, preserving
  received-stage children.
- `update_mission_progress` treats client values as deltas. This matches
  `MissionCounterLogic`, which clears its local batch after each silent send.
- Daily and weekly resets delete only category 2 and category 10 data.
- Category 10 uses `RegularComputer` and its weekly snapshot.
- Stage thresholds use the CN table-specific columns: regular/daily/event/
  degree/weekly column 1, collect-item column 2, Awake column 5.
- `get_mission_progress` honors mission availability windows, collect-item
  `event_id`, and each CharacterAwake `character_id` request independently.
- `get_mission_progress` remains read-only for ordinary category list refreshes.
  Category 9 requests carrying a CharacterAwake `character_id` are the official
  screen-entry settlement trigger and atomically claim newly completed stages.
- ActiveMission claims validate mission existence, stage definitions,
  completion thresholds, prior receipt, and duplicates before an atomic grant.
- ActiveMission rewards now preserve kind 0 (Stone) and dispatch items,
  equipment, characters, mana, EXP, and degree rewards to the correct response
  collections.

## CharacterAwake refresh

Awake mission completion and reward receipt are stored separately under
category 9. The silent progress response never unlocks the board. Category 9
screen entry returns `mission_info`, changed reward collections, and the
`AwakeManaBoard` special reward; `/load` reconstructs the unlock only from a
received special-reward stage or persisted awakened node state. The
already-open scene limitation remains documented in
`character-awake-refresh.md`.

## Remaining feature gaps

- PassDaily, PassWeek, and PassEvent (categories 6, 7, and 8) have client enum
  entries but no extracted server stage/reward master data. They still return
  no mission rows.
- Category mission reward settlement is not yet wired into every gameplay
  endpoint that can change server-computed progress. CharacterAwake is handled
  separately because its client contract settles rewards on category 9 screen
  entry.
- Event missions whose goal is repeated clears need per-event repeat counters;
  the current quest-progress model can count distinct completed quests and
  stored multiplayer clear counts, but not every historical single-player
  repeat.
- CharacterAwake pair/race progress still relies on the documented local
  counters and mappings; reward settlement and the final special-reward trigger
  are implemented from the CN 1.8.1 client master schema.

These gaps keep both mission progress routes at partial status even though the
storage, reset, protocol filtering, and ActiveMission claim safety issues are
resolved.
