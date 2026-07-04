# Advent Event Flow

This document tracks the current server implementation for Advent Event quests
(CN: `advent_event_quest`, commonly referred to as Annihilator/Advent battles).
It focuses on the behavior verified against the decompiled client flow.

## Client Flow Summary

- The quest selection scene does not call a dedicated Advent quest-list API.
  It filters local master data through player quest progress and time windows.
- Story quests finish through the generic `story_quest/finish` route.
- Single-player battle starts and finishes through `single_battle_quest/*`.
- Co-op battle rooms use the generic `multi_battle_quest/*` routes.
- Advent co-op room list requests include `category_id` and may include
  `event_id`; `event_id` is the Advent event id, not the quest id.
- Item-gated battles use `battle_startable_use_item_mode`.
  The currently imported Advent data only has per-start `Always` item costs.

## Implemented Server Coverage

- Full Advent event and quest master export from the runtime upload store.
- Server-side Advent quest lookup backed by `assets/advent_event_quest_full.json`.
- Story-shaped Advent quests remain story-shaped so story finish can process
  them without exposing battle reward fields.
- Battle-shaped Advent quests expose official fields used by start/finish:
  event id, stamina cost, available play kind, start item costs, max continue,
  rank times, rank item counts, score reward group, and prerequisites.
- Story, single battle, and multi battle start paths validate viewable/selectable
  quest prerequisites using either Advent single or Advent multi progress.
- Single battle start consumes Advent stamina and per-start item costs.
- Single battle continue respects the official max continue count.
- Single and multi battle finish use Advent rank item counts for common score
  reward drop count and keep rare reward probability ordering.
- `multi_battle_quest/get_rooms` now lists public joinable rooms for the
  requested category/event instead of returning only rooms hosted by the caller.
- Room listing filters out rooms already in battle and rooms with three mates.

## Current Intentional Gaps

- Multi battle start stamina and per-start item deduction is intentionally not
  implemented in this PR. It was identified as high priority, but explicitly
  deferred before this checkpoint.
- Multi battle continue still needs official max-continue parity.
- Server-side event period enforcement for Advent start/create-room is still
  pending.
- `quest/unlock` does not yet derive one-time unlock costs from Advent full
  master data. Current imported Advent rows do not require this path.
- Event shop and event mission counters need a separate Advent-focused pass.

## Key Files

- `tools/export_advent_master.cjs`
- `assets/advent_event.json`
- `assets/advent_event_quest_full.json`
- `src/lib/assets.ts`
- `src/lib/quest/start-handler.ts`
- `src/lib/quest.ts`
- `src/routes/api/storyQuest.ts`
- `src/routes/api/singleBattleQuest.ts`
- `src/multi/http/battle.ts`
- `src/multi/http/lobby.ts`
- `src/multi/room/listing.ts`
- `src/multi/room/manager.ts`

## Verification

Run these checks for Advent-related changes:

```powershell
node tools\advent_master_export.test.cjs
node tools\advent_server_master.test.cjs
node tools\advent_score_rewards.test.cjs
node tools\advent_room_list.test.cjs
npm run build
```
