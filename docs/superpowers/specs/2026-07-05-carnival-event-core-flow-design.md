# Carnival Event Core Flow Design

## Goal

Implement the official core flow for haniwa carnival battle completion: score calculation, folder record mutation, duplicate-character record reset, total best score reward detection, and the `carnival_event` finish response used by the client.

## Scope

This first slice covers the server behavior after a carnival quest is cleared. It updates the existing finish path so the client-visible flow matches the decompiled client expectations:

- Difficulty bonus uses the raw carnival quest `difficulty_score`.
- Time bonus is `max(0, battle_time_limit_ms - clear_time_ms)`.
- Total quest score is `difficulty_bonus + time_bonus`.
- `previous_total_best_score` is the event-wide best-score sum before applying the clear.
- Current folder `previous_score`, `best_score`, `previous_character_ids`, and `previous_unison_character_ids` are updated from the clear.
- Other folders that previously recorded any reused main or unison character from the current party are reset.
- Newly reached total-score rewards are returned in `reward_ids` and stored as received.
- Degree rewards from newly reached total-score rewards are returned in `new_degree_ids`.

This slice does not implement carnival period validation, `/load` initialization serialization, or full master-table extraction for every carnival table. Those are follow-up slices after the finish flow is correct and test-covered.

## Client Evidence

The decompiled client computes carnival score in `CarnivalEventQuestLogic` as:

- `get_difficultyScore()` returns the rounded `difficulty_score` value.
- `caluculateTimeBonus(clearTime)` returns `floor(max(0, battle_time_limit_ms - round(clearTime)))`.
- `caluculateTotalScore(clearTime)` returns `get_difficultyScore() + caluculateTimeBonus(clearTime)`.

The finish remote expects `data.carnival_event` to include:

- `is_record_valid`
- `leader_character_id`
- `new_degree_ids`
- `previous_total_best_score`
- `reward_ids`
- `score.difficulty_bonus`
- `score.time_bonus`

The battle-finish process only writes carnival high-score update data when `is_record_valid` is true and `reward_ids` is non-empty. The score-reward scene then compares the previous total best score with the current event best score and shows newly achieved degree/reward state.

The party-select client detects reused characters from other folders before battle start and warns the user that affected stage records will be reset. The client does not block the battle, so the server must apply the reset rule when recording the clear.

## Server Changes

### Domain Layer

Extend `src/data/domains/carnivalEvent.ts` with focused record helpers:

- `sumPlayerCarnivalEventBestScoreSync(playerId, eventId)` returns the sum of non-null `best_score` across all folders for the event.
- `resetPlayerCarnivalEventRecordsSync(playerId, eventId, folderIds)` clears `best_score`, `previous_score`, `previous_character_ids`, and `previous_unison_character_ids` for the selected folders.
- `getReceivedCarnivalEventTotalScoreRewardIdsSync(playerId, eventId)` returns received total-score reward ids.
- `insertReceivedCarnivalEventTotalScoreRewardSync(playerId, eventId, rewardId)` stores a newly received reward id.

Add database initialization for:

```sql
CREATE TABLE IF NOT EXISTS players_carnival_event_total_score_rewards (
    player_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    reward_id INTEGER NOT NULL,
    PRIMARY KEY (player_id, event_id, reward_id),
    FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
)
```

### Reward Data

Add a service-side asset at `assets/carnival_event_total_score_reward.json`.

Each entry uses this shape:

```json
{
  "100101": {
    "id": 100101,
    "event_id": 1,
    "score": 50000,
    "rewards": [
      { "kind": 7, "id": 301001, "number": 1 }
    ]
  }
}
```

The first implementation only needs the fields required to detect thresholds and degree rewards. Reward kinds keep the client master mapping:

- `0`: item
- `1`: equipment
- `2`: stone
- `3`: mana
- `4`: pooled exp
- `5`: pass card point
- `6`: character
- `7`: degree

If a newly reached reward has kind `7`, the reward id is appended to `new_degree_ids`. Other reward kinds are preserved in the reward data and can be wired to the existing reward mutation utilities where the current codebase already has a clear equivalent.

### Finish Rule

Replace the current minimal `handleCarnivalEventFinish` behavior with a rule that accepts the current records and total-score reward data through injected functions/data. Keeping the rule injectable makes it testable without starting Fastify or a real account session.

The rule order is:

1. Return `null` unless the quest category is carnival and the quest was accomplished.
2. Look up the carnival quest score metadata by quest id.
3. Read current event records.
4. Compute `previous_total_best_score` from current records.
5. Compute `difficulty_bonus`, `time_bonus`, and total score with the client formula.
6. Build the current party's main and unison character id set, excluding nulls.
7. Find other folder records whose previous main or unison ids intersect the current id set.
8. Reset those other folder records.
9. Upsert the current folder record with the new previous score and max best score.
10. Re-read or derive the new total best score after resets and current-folder update.
11. Find total-score rewards for this event where:
    - `score > previous_total_best_score`
    - `score <= new_total_best_score`
    - reward id has not already been received
12. Store each newly received reward id.
13. Return a `carnival_event` object with real `previous_total_best_score`, `reward_ids`, `new_degree_ids`, and score breakdown.

When duplicate-character reset lowers other folder scores, reward receipt history is not rolled back. This matches one-time reward semantics and avoids taking rewards away after the player has already claimed them.

## Testing

Because the repository currently has no dedicated test runner, this slice will add a small executable TypeScript or JavaScript test harness for the pure carnival finish rule. The tests will run without Fastify and without a production database.

Required cases:

- Difficulty score is not multiplied by 100.
- First clear records current folder score and party.
- Lower replay on the same folder updates `previous_score` but does not lower `best_score`.
- Higher replay on the same folder raises `best_score`.
- Reusing any recorded main or unison character resets other affected folders.
- Reusing characters from the same folder does not reset the current folder before upsert.
- Crossing total-score thresholds returns only newly reached `reward_ids`.
- Already received reward ids are not returned again.
- Degree rewards from newly reached thresholds appear in `new_degree_ids`.

The implementation is complete when the new harness passes and `npm run typecheck` succeeds.

## Risks

The biggest data risk is that `assets/carnival_event_total_score_reward.json` does not exist yet. The implementation should tolerate a missing or empty reward file by returning no new reward ids, while still performing score and record updates correctly.

The biggest behavior risk is duplicate-character reset timing. This design applies reset during successful finish, not during start, because the client warning is advisory and the current server has no explicit confirmation payload from the client.
