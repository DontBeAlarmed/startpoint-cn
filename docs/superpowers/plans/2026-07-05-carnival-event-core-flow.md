# Carnival Event Core Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make haniwa carnival battle finish follow the official client-visible flow for score calculation, folder records, duplicate-character resets, and total-score reward response data.

**Architecture:** Keep carnival rules in `src/lib/quest/finish/carnival-handler.ts` as injectable pure logic plus a thin mutation wrapper. Persist records and received reward ids through `src/data/domains/carnivalEvent.ts`, and wire the existing `single_battle_quest/finish` route to load reward data and merge any granted rewards into the normal finish response.

**Tech Stack:** TypeScript, Fastify route handlers, better-sqlite3 domain helpers, CommonJS assert-based tool tests with `ts-node/register`.

---

## File Structure

- Modify `src/lib/quest/finish/carnival-handler.ts`
  - Owns score formula, duplicate-character reset detection, total-score reward threshold detection, conversion of carnival reward rows to existing `Reward` objects, and the injectable finish wrapper.
- Modify `src/data/types.ts`
  - Adds raw/domain types for `players_carnival_event_total_score_rewards`.
- Modify `src/data/domains/carnivalEvent.ts`
  - Adds record reset, best-score sum, and total-score reward receipt helpers.
- Modify `src/data/initializers/wdfpData.ts`
  - Creates the new total-score reward receipt table.
- Modify `src/routes/api/singleBattleQuest.ts`
  - Loads `assets/carnival_event_total_score_reward.json`, injects domain helpers into carnival finish, and merges carnival reward grants into response fields.
- Create `assets/carnival_event_total_score_reward.json`
  - Empty `{}` fallback until the official master table is converted.
- Create `tools/carnival_event_core_flow.test.cjs`
  - Assert-based tests for the injectable carnival finish wrapper using in-memory records and synthetic rewards.

## Task 1: Pure Carnival Finish Rule

**Files:**
- Modify: `src/lib/quest/finish/carnival-handler.ts`
- Test: `tools/carnival_event_core_flow.test.cjs`

- [ ] **Step 1: Write the failing test harness**

Create `tools/carnival_event_core_flow.test.cjs`:

```javascript
require("ts-node/register");

const assert = require("assert");
const { QuestCategory } = require("../src/lib/types/quest.ts");
const {
  handleCarnivalEventFinish,
  convertCarnivalRewardsToPlayerRewards,
} = require("../src/lib/quest/finish/carnival-handler.ts");

const lookup = {
  "1001": { difficulty_score: 20, time_limit_ms: 108000, folder_id: 1, event_id: 1 },
  "1002": { difficulty_score: 55, time_limit_ms: 72000, folder_id: 2, event_id: 1 },
};

function party(main, unison) {
  return {
    characters: main.map((id) => (id == null ? null : { id })),
    unison_characters: unison.map((id) => (id == null ? null : { id })),
    leader: main[0] == null ? null : { id: main[0] },
  };
}

function cloneRecords(records) {
  return records.map((record) => ({
    eventId: record.eventId,
    folderId: record.folderId,
    bestScore: record.bestScore,
    previousScore: record.previousScore,
    previousCharacterIds: record.previousCharacterIds == null ? null : [...record.previousCharacterIds],
    previousUnisonCharacterIds: record.previousUnisonCharacterIds == null ? null : [...record.previousUnisonCharacterIds],
  }));
}

function runHarness({
  questId = 1001,
  clearTime = 8000,
  records = [],
  rewards = [],
  receivedRewardIds = [],
  currentParty = party([101, 102, 103], [201, 202, 203]),
} = {}) {
  const state = {
    records: cloneRecords(records),
    resetFolderIds: [],
    upserts: [],
    insertedRewardIds: [],
    receivedRewardIds: new Set(receivedRewardIds),
    rewardGrantResult: null,
  };

  const result = handleCarnivalEventFinish({
    questCategory: QuestCategory.CARNIVAL_EVENT,
    questAccomplished: true,
    questId,
    clearTime,
    party: currentParty,
    playerId: 99,
    carnivalLookup: lookup,
    totalScoreRewards: rewards,
    getRecordsFn: () => cloneRecords(state.records),
    resetRecordsFn: (_playerId, _eventId, folderIds) => {
      state.resetFolderIds.push(...folderIds);
      for (const folderId of folderIds) {
        const record = state.records.find((candidate) => candidate.folderId === folderId);
        if (record) {
          record.bestScore = null;
          record.previousScore = null;
          record.previousCharacterIds = null;
          record.previousUnisonCharacterIds = null;
        }
      }
    },
    upsertFn: (_playerId, eventId, folderId, score, chars, unisons) => {
      state.upserts.push({ eventId, folderId, score, chars, unisons });
      let record = state.records.find((candidate) => candidate.eventId === eventId && candidate.folderId === folderId);
      if (!record) {
        record = { eventId, folderId, bestScore: null, previousScore: null, previousCharacterIds: null, previousUnisonCharacterIds: null };
        state.records.push(record);
      }
      record.bestScore = Math.max(record.bestScore || 0, score);
      record.previousScore = score;
      record.previousCharacterIds = [...chars];
      record.previousUnisonCharacterIds = [...unisons];
    },
    getReceivedRewardIdsFn: () => [...state.receivedRewardIds],
    insertReceivedRewardFn: (_playerId, _eventId, rewardId) => {
      state.insertedRewardIds.push(rewardId);
      state.receivedRewardIds.add(rewardId);
    },
    giveRewardsFn: (_playerId, rewardsToGrant) => {
      state.rewardGrantResult = rewardsToGrant;
      return {
        user_info: { free_mana: 0, free_vmoney: 0, exp_pool: 0 },
        character_list: [],
        joined_character_id_list: [],
        equipment_list: [],
        items: {},
      };
    },
  });

  return { result, state };
}

{
  const { result, state } = runHarness();
  assert.strictEqual(result.clientData.score.difficulty_bonus, 20);
  assert.strictEqual(result.clientData.score.time_bonus, 100000);
  assert.strictEqual(state.upserts[0].score, 100020);
}

{
  const { result, state } = runHarness({
    records: [{ eventId: 1, folderId: 1, bestScore: 120000, previousScore: 120000, previousCharacterIds: [101, 102, 103], previousUnisonCharacterIds: [201, 202, 203] }],
    clearTime: 20000,
  });
  assert.strictEqual(result.clientData.previous_total_best_score, 120000);
  assert.strictEqual(state.records[0].previousScore, 88020);
  assert.strictEqual(state.records[0].bestScore, 120000);
}

{
  const { state } = runHarness({
    records: [{ eventId: 1, folderId: 1, bestScore: 80000, previousScore: 80000, previousCharacterIds: [101, 102, 103], previousUnisonCharacterIds: [201, 202, 203] }],
    clearTime: 1000,
  });
  assert.strictEqual(state.records[0].bestScore, 107020);
}

{
  const { result, state } = runHarness({
    records: [
      { eventId: 1, folderId: 1, bestScore: 50000, previousScore: 50000, previousCharacterIds: [301, 302, 303], previousUnisonCharacterIds: [401, 402, 403] },
      { eventId: 1, folderId: 2, bestScore: 60000, previousScore: 60000, previousCharacterIds: [101, 304, 305], previousUnisonCharacterIds: [404, 405, 406] },
    ],
  });
  assert.deepStrictEqual(state.resetFolderIds, [2]);
  assert.strictEqual(state.records.find((record) => record.folderId === 2).bestScore, null);
  assert.strictEqual(result.clientData.previous_total_best_score, 110000);
}

{
  const { state } = runHarness({
    records: [{ eventId: 1, folderId: 1, bestScore: 50000, previousScore: 50000, previousCharacterIds: [101, 302, 303], previousUnisonCharacterIds: [401, 402, 403] }],
  });
  assert.deepStrictEqual(state.resetFolderIds, []);
}

{
  const rewards = [
    { id: 10, event_id: 1, score: 90000, rewards: [{ kind: 7, id: 7001, number: 1 }] },
    { id: 11, event_id: 1, score: 150000, rewards: [{ kind: 3, id: null, number: 5000 }] },
    { id: 12, event_id: 1, score: 210000, rewards: [{ kind: 7, id: 7002, number: 1 }] },
  ];
  const { result, state } = runHarness({
    records: [{ eventId: 1, folderId: 2, bestScore: 40000, previousScore: 40000, previousCharacterIds: [301, 302, 303], previousUnisonCharacterIds: [401, 402, 403] }],
    rewards,
    receivedRewardIds: [10],
  });
  assert.deepStrictEqual(result.clientData.reward_ids, [11]);
  assert.deepStrictEqual(result.clientData.new_degree_ids, []);
  assert.deepStrictEqual(state.insertedRewardIds, [11]);
  assert.strictEqual(state.rewardGrantResult.length, 1);
}

{
  const rewards = [
    { id: 20, event_id: 1, score: 90000, rewards: [{ kind: 7, id: 7100, number: 1 }] },
  ];
  const { result } = runHarness({ rewards });
  assert.deepStrictEqual(result.clientData.reward_ids, [20]);
  assert.deepStrictEqual(result.clientData.new_degree_ids, [7100]);
}

assert.deepStrictEqual(convertCarnivalRewardsToPlayerRewards([
  { kind: 0, id: 777, number: 3 },
  { kind: 1, id: 888, number: 2 },
  { kind: 3, id: null, number: 1000 },
  { kind: 4, id: null, number: 2000 },
  { kind: 6, id: 123001, number: 1 },
  { kind: 7, id: 7100, number: 1 },
]), [
  { type: 0, id: 777, count: 3 },
  { type: 1, id: 888, count: 2 },
  { type: 4, count: 1000 },
  { type: 5, count: 2000 },
  { type: 2, id: 123001 },
]);

console.log("carnival_event_core_flow tests passed");
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node tools/carnival_event_core_flow.test.cjs
```

Expected: FAIL because the current handler returns `difficulty_bonus` as `2000`, does not expose `clientData`, and does not support injected record/reward helpers.

- [ ] **Step 3: Implement the minimal carnival finish rule**

Replace `src/lib/quest/finish/carnival-handler.ts` with the new injectable implementation. Keep the public function name `handleCarnivalEventFinish`, but return a wrapper object so the route can separately send `clientData` and merge `rewardResult`.

```typescript
import { PlayerCarnivalEventRecord } from "../../../data/types"
import { PlayerRewardResult } from "../../types/rewards"
import { QuestCategory, Reward, RewardType } from "../../types"

export interface CarnivalEventData {
    is_record_valid: boolean
    leader_character_id: number
    new_degree_ids: number[]
    previous_total_best_score: number
    reward_ids: number[]
    score: { difficulty_bonus: number, time_bonus: number }
}

export interface CarnivalQuestScoreInfo {
    difficulty_score: number
    time_limit_ms: number
    folder_id: number
    event_id: number
}

export interface CarnivalTotalScoreRewardItem {
    kind: number
    id: number | null
    number: number
}

export interface CarnivalTotalScoreReward {
    id: number
    event_id: number
    score: number
    rewards: CarnivalTotalScoreRewardItem[]
}

export interface CarnivalFinishResult {
    clientData: CarnivalEventData | null
    rewardResult: PlayerRewardResult | null
}

interface CarnivalParty {
    characters: ({ id: number | null } | null)[]
    unison_characters: ({ id: number | null } | null)[]
    leader?: { id: number | null } | null
}

function sumBestScore(records: PlayerCarnivalEventRecord[]): number {
    return records.reduce((sum, record) => sum + (record.bestScore ?? 0), 0)
}

function idsFromParty(party: CarnivalParty): { characterIds: (number | null)[], unisonCharacterIds: (number | null)[], usedIds: Set<number> } {
    const characterIds = party.characters.map(value => value?.id ?? null)
    const unisonCharacterIds = party.unison_characters.map(value => value?.id ?? null)
    const usedIds = new Set<number>()
    for (const id of [...characterIds, ...unisonCharacterIds]) {
        if (id !== null) usedIds.add(id)
    }
    return { characterIds, unisonCharacterIds, usedIds }
}

function recordUsesAnyCharacter(record: PlayerCarnivalEventRecord, usedIds: Set<number>): boolean {
    for (const id of [...(record.previousCharacterIds ?? []), ...(record.previousUnisonCharacterIds ?? [])]) {
        if (id !== null && usedIds.has(id)) return true
    }
    return false
}

function computeBestScoreAfterFinish(records: PlayerCarnivalEventRecord[], currentFolderId: number, resetFolderIds: Set<number>, score: number): number {
    let sawCurrent = false
    let total = 0
    for (const record of records) {
        if (resetFolderIds.has(record.folderId)) continue
        if (record.folderId === currentFolderId) {
            sawCurrent = true
            total += Math.max(record.bestScore ?? 0, score)
        } else {
            total += record.bestScore ?? 0
        }
    }
    if (!sawCurrent) total += score
    return total
}

export function convertCarnivalRewardsToPlayerRewards(items: CarnivalTotalScoreRewardItem[]): Reward[] {
    const rewards: Reward[] = []
    for (const item of items) {
        if (item.kind === 7) continue
        if (item.kind === 0 && item.id !== null) rewards.push({ type: RewardType.ITEM, id: item.id, count: item.number } as Reward)
        if (item.kind === 1 && item.id !== null) rewards.push({ type: RewardType.EQUIPMENT, id: item.id, count: item.number } as Reward)
        if (item.kind === 2) rewards.push({ type: RewardType.BEADS, count: item.number } as Reward)
        if (item.kind === 3) rewards.push({ type: RewardType.MANA, count: item.number } as Reward)
        if (item.kind === 4) rewards.push({ type: RewardType.EXP, count: item.number } as Reward)
        if (item.kind === 6 && item.id !== null) rewards.push({ type: RewardType.CHARACTER, id: item.id } as Reward)
    }
    return rewards
}

export function handleCarnivalEventFinish(params: {
    questCategory: number
    questAccomplished: boolean
    questId: number
    clearTime: number
    party: CarnivalParty
    playerId: number
    carnivalLookup: Record<string, CarnivalQuestScoreInfo>
    totalScoreRewards?: CarnivalTotalScoreReward[]
    getRecordsFn: (playerId: number, eventId: number) => PlayerCarnivalEventRecord[]
    resetRecordsFn: (playerId: number, eventId: number, folderIds: number[]) => void
    upsertFn: (playerId: number, eventId: number, folderId: number, score: number, chars: (number | null)[], unisons: (number | null)[]) => void
    getReceivedRewardIdsFn: (playerId: number, eventId: number) => number[]
    insertReceivedRewardFn: (playerId: number, eventId: number, rewardId: number) => void
    giveRewardsFn?: (playerId: number, rewards: Reward[]) => PlayerRewardResult | null
}): CarnivalFinishResult {
    const emptyResult = { clientData: null, rewardResult: null }
    if (params.questCategory !== QuestCategory.CARNIVAL_EVENT || !params.questAccomplished) return emptyResult

    const carnivalInfo = params.carnivalLookup[String(params.questId)]
    if (!carnivalInfo) return emptyResult

    const records = params.getRecordsFn(params.playerId, carnivalInfo.event_id)
    const previousTotalBestScore = sumBestScore(records)
    const { characterIds, unisonCharacterIds, usedIds } = idsFromParty(params.party)
    const resetFolderIds = records
        .filter(record => record.folderId !== carnivalInfo.folder_id && recordUsesAnyCharacter(record, usedIds))
        .map(record => record.folderId)
    const resetFolderIdSet = new Set(resetFolderIds)
    const difficultyBonus = Math.round(carnivalInfo.difficulty_score)
    const timeBonus = Math.max(0, carnivalInfo.time_limit_ms - Math.round(params.clearTime))
    const totalScore = difficultyBonus + timeBonus
    const newTotalBestScore = computeBestScoreAfterFinish(records, carnivalInfo.folder_id, resetFolderIdSet, totalScore)
    const receivedRewardIds = new Set(params.getReceivedRewardIdsFn(params.playerId, carnivalInfo.event_id))
    const newlyReachedRewards = (params.totalScoreRewards ?? [])
        .filter(reward => reward.event_id === carnivalInfo.event_id)
        .filter(reward => reward.score > previousTotalBestScore && reward.score <= newTotalBestScore)
        .filter(reward => !receivedRewardIds.has(reward.id))
        .sort((a, b) => a.score - b.score || a.id - b.id)

    if (resetFolderIds.length > 0) params.resetRecordsFn(params.playerId, carnivalInfo.event_id, resetFolderIds)
    params.upsertFn(params.playerId, carnivalInfo.event_id, carnivalInfo.folder_id, totalScore, characterIds, unisonCharacterIds)
    for (const reward of newlyReachedRewards) {
        params.insertReceivedRewardFn(params.playerId, carnivalInfo.event_id, reward.id)
    }

    const rewardsToGrant = newlyReachedRewards.flatMap(reward => convertCarnivalRewardsToPlayerRewards(reward.rewards ?? []))
    const rewardResult = rewardsToGrant.length > 0 && params.giveRewardsFn ? params.giveRewardsFn(params.playerId, rewardsToGrant) : null

    return {
        clientData: {
            is_record_valid: true,
            leader_character_id: params.party.leader?.id ?? 0,
            new_degree_ids: newlyReachedRewards.flatMap(reward => (reward.rewards ?? []).filter(item => item.kind === 7 && item.id !== null).map(item => item.id as number)),
            previous_total_best_score: previousTotalBestScore,
            reward_ids: newlyReachedRewards.map(reward => reward.id),
            score: { difficulty_bonus: difficultyBonus, time_bonus: timeBonus },
        },
        rewardResult,
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```powershell
node tools/carnival_event_core_flow.test.cjs
```

Expected: PASS and output `carnival_event_core_flow tests passed`.

- [ ] **Step 5: Commit**

```powershell
git add -- src/lib/quest/finish/carnival-handler.ts tools/carnival_event_core_flow.test.cjs
git commit -m "test: cover carnival event core finish flow"
```

## Task 2: Carnival Event Persistence Helpers

**Files:**
- Modify: `src/data/types.ts`
- Modify: `src/data/domains/carnivalEvent.ts`
- Modify: `src/data/initializers/wdfpData.ts`

- [ ] **Step 1: Add persistence API assertions to the harness**

Append this section to `tools/carnival_event_core_flow.test.cjs` after the pure rule tests. It does not call the helpers, so it does not mutate the app database; it verifies that the route can import the exact helper names introduced by this task. The SQL behavior is covered through the injected mutation tests in Task 1 and by `npm run typecheck`.

```javascript
{
  const carnivalDomain = require("../src/data/domains/carnivalEvent.ts");
  assert.strictEqual(typeof carnivalDomain.sumPlayerCarnivalEventBestScoreSync, "function");
  assert.strictEqual(typeof carnivalDomain.resetPlayerCarnivalEventRecordsSync, "function");
  assert.strictEqual(typeof carnivalDomain.getReceivedCarnivalEventTotalScoreRewardIdsSync, "function");
  assert.strictEqual(typeof carnivalDomain.insertReceivedCarnivalEventTotalScoreRewardSync, "function");
}
```

Run:

```powershell
node tools/carnival_event_core_flow.test.cjs
```

Expected: FAIL because `sumPlayerCarnivalEventBestScoreSync` and the other new helper exports do not exist yet.

- [ ] **Step 2: Add raw/domain types**

Add to `src/data/types.ts` near the carnival record interfaces:

```typescript
export interface RawPlayerCarnivalEventTotalScoreReward {
    player_id: number
    event_id: number
    reward_id: number
}

export interface PlayerCarnivalEventTotalScoreReward {
    eventId: number
    rewardId: number
}
```

- [ ] **Step 3: Add the receipt table**

In `src/data/initializers/wdfpData.ts`, immediately after the existing `players_carnival_event_records` table creation, add:

```typescript
    database.prepare(`CREATE TABLE IF NOT EXISTS players_carnival_event_total_score_rewards (
        player_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        reward_id INTEGER NOT NULL,
        PRIMARY KEY (player_id, event_id, reward_id),
        FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
    )`).run()
```

- [ ] **Step 4: Add carnival domain helpers**

Append these functions to `src/data/domains/carnivalEvent.ts`:

```typescript
export function sumPlayerCarnivalEventBestScoreSync(playerId: number, eventId: number): number {
    const row = getDb().prepare(`
    SELECT COALESCE(SUM(best_score), 0) AS total
    FROM players_carnival_event_records
    WHERE player_id = ? AND event_id = ? AND best_score IS NOT NULL
    `).get(playerId, eventId) as { total: number } | undefined

    return row?.total ?? 0
}

export function resetPlayerCarnivalEventRecordsSync(playerId: number, eventId: number, folderIds: number[]): void {
    if (folderIds.length === 0) return
    const statement = getDb().prepare(`
    UPDATE players_carnival_event_records
    SET best_score = NULL,
        previous_score = NULL,
        previous_character_ids = NULL,
        previous_unison_character_ids = NULL
    WHERE player_id = ? AND event_id = ? AND folder_id = ?
    `)
    const transaction = getDb().transaction((ids: number[]) => {
        for (const folderId of ids) statement.run(playerId, eventId, folderId)
    })
    transaction(folderIds)
}

export function getReceivedCarnivalEventTotalScoreRewardIdsSync(playerId: number, eventId: number): number[] {
    const rows = getDb().prepare(`
    SELECT reward_id
    FROM players_carnival_event_total_score_rewards
    WHERE player_id = ? AND event_id = ?
    ORDER BY reward_id ASC
    `).all(playerId, eventId) as { reward_id: number }[]

    return rows.map(row => row.reward_id)
}

export function insertReceivedCarnivalEventTotalScoreRewardSync(playerId: number, eventId: number, rewardId: number): void {
    getDb().prepare(`
    INSERT OR IGNORE INTO players_carnival_event_total_score_rewards (player_id, event_id, reward_id)
    VALUES (?, ?, ?)
    `).run(playerId, eventId, rewardId)
}
```

- [ ] **Step 5: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS. If TypeScript reports that `better-sqlite3` transaction typing needs an annotation, use `const transaction = getDb().transaction((ids: number[]) => { ... })` exactly as shown above.

- [ ] **Step 6: Commit**

```powershell
git add -- src/data/types.ts src/data/domains/carnivalEvent.ts src/data/initializers/wdfpData.ts
git commit -m "feat: persist carnival total score reward receipts"
```

## Task 3: Route Wiring and Reward Asset Loading

**Files:**
- Modify: `src/routes/api/singleBattleQuest.ts`
- Create: `assets/carnival_event_total_score_reward.json`

- [ ] **Step 1: Extend the harness with route-shape expectations**

Append this assertion to `tools/carnival_event_core_flow.test.cjs`:

```javascript
{
  const { result } = runHarness();
  assert.ok(result.clientData);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.clientData, "reward_ids"), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result.clientData, "previous_total_best_score"), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, "rewardResult"), true);
}
```

- [ ] **Step 2: Run test to verify it still passes before route wiring**

Run:

```powershell
node tools/carnival_event_core_flow.test.cjs
```

Expected: PASS. This confirms the route can rely on `clientData` and `rewardResult`.

- [ ] **Step 3: Add the empty fallback reward asset**

Create `assets/carnival_event_total_score_reward.json`:

```json
{}
```

- [ ] **Step 4: Load carnival total-score rewards in the route**

In `src/routes/api/singleBattleQuest.ts`, change the carnival import:

```typescript
import { getReceivedCarnivalEventTotalScoreRewardIdsSync, getPlayerCarnivalEventRecordsSync, insertReceivedCarnivalEventTotalScoreRewardSync, resetPlayerCarnivalEventRecordsSync, upsertPlayerCarnivalEventRecordSync } from "../../data/domains/carnivalEvent"
```

Change the handler import:

```typescript
import { CarnivalTotalScoreReward, handleCarnivalEventFinish } from "../../lib/quest/finish/carnival-handler";
```

Add a reward loader after the existing carnival score lookup loader:

```typescript
let carnivalTotalScoreRewards: CarnivalTotalScoreReward[] = []
try {
    const rewardPath = path.join(process.cwd(), "assets", "carnival_event_total_score_reward.json")
    if (existsSync(rewardPath)) {
        carnivalTotalScoreRewards = Object.values(JSON.parse(readFileSync(rewardPath, "utf-8")))
    }
} catch {} // Init failed silently; carnival total-score rewards won't be granted
```

- [ ] **Step 5: Wire the finish call and merge rewards**

Replace the current carnival finish call in `src/routes/api/singleBattleQuest.ts` with:

```typescript
        const carnivalFinishResult = handleCarnivalEventFinish({
            questCategory,
            questAccomplished,
            questId,
            clearTime,
            party: bodyPartyStatistics,
            playerId,
            carnivalLookup: carnivalScoreLookup,
            totalScoreRewards: carnivalTotalScoreRewards,
            getRecordsFn: (pid, eid) => getPlayerCarnivalEventRecordsSync(pid, eid),
            resetRecordsFn: (pid, eid, folderIds) => resetPlayerCarnivalEventRecordsSync(pid, eid, folderIds),
            upsertFn: (pid, eid, fid, score, chars, unisons) => upsertPlayerCarnivalEventRecordSync(pid, eid, fid, score, chars, unisons),
            getReceivedRewardIdsFn: (pid, eid) => getReceivedCarnivalEventTotalScoreRewardIdsSync(pid, eid),
            insertReceivedRewardFn: (pid, eid, rewardId) => insertReceivedCarnivalEventTotalScoreRewardSync(pid, eid, rewardId),
            giveRewardsFn: (pid, rewards) => givePlayerRewardsSync(pid, rewards),
        })
        const carnivalEventData = carnivalFinishResult.clientData
        const carnivalRewardResult = carnivalFinishResult.rewardResult
```

Update the response merge sites:

```typescript
"free_mana": newMana + (clearReward?.user_info.free_mana || 0) + (sPlusClearReward?.user_info.free_mana || 0) + scoreRewardsResult.user_info.free_mana + (carnivalRewardResult?.user_info.free_mana ?? 0),
"exp_pool": rewardCharacterExpResult.exp_pool + (clearReward?.user_info.exp_pool || 0) + scoreRewardsResult.user_info.exp_pool + (carnivalRewardResult?.user_info.exp_pool ?? 0),
"free_vmoney": playerData.freeVmoney + (clearReward?.user_info.free_vmoney || 0) + (sPlusClearReward?.user_info.free_vmoney || 0) + scoreRewardsResult.user_info.free_vmoney + (carnivalRewardResult?.user_info.free_vmoney ?? 0),
```

Add carnival character/equipment/item merges:

```typescript
...scoreRewardsResult.character_list,
...(carnivalRewardResult?.character_list ?? [])
```

```typescript
...scoreRewardsResult.joined_character_id_list,
...(carnivalRewardResult?.joined_character_id_list ?? [])
```

```typescript
...(rushEventRewardsResult?.equipment_list || []),
...(carnivalRewardResult?.equipment_list ?? [])
```

Update `itemList`:

```typescript
        const itemList = {
            ...(activeQuestData.entryItemId ? { [activeQuestData.entryItemId]: getPlayerItemSync(playerId, activeQuestData.entryItemId) ?? 0 } : {}),
            ...scoreRewardsResult.items,
            ...(rushEventRewardsResult?.items ?? {}),
            ...(carnivalRewardResult?.items ?? {})
        }
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
node tools/carnival_event_core_flow.test.cjs
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```powershell
git add -- src/routes/api/singleBattleQuest.ts assets/carnival_event_total_score_reward.json tools/carnival_event_core_flow.test.cjs
git commit -m "feat: wire carnival finish rewards into quest response"
```

## Task 4: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
node tools/carnival_event_core_flow.test.cjs
```

Expected: PASS with `carnival_event_core_flow tests passed`.

- [ ] **Step 2: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Inspect final diff**

Run:

```powershell
git diff --stat HEAD~3..HEAD
git status --short
```

Expected: commits include only the carnival handler, carnival domain/types/schema, single battle route, empty carnival reward asset, and the new carnival test harness. Existing unrelated gacha/decompile/mod-tools working tree changes may still appear in `git status`; do not stage or revert them.

- [ ] **Step 4: Manual smoke path**

Run the CN server build:

```powershell
npm run build
```

Expected: PASS. This is the build command used by `npm run dev:cn` before starting `out/cn-server.js`.

- [ ] **Step 5: Final commit if Task 4 changed files**

Only commit if verification required a follow-up fix:

```powershell
git add -- <fixed-files>
git commit -m "fix: stabilize carnival event core flow"
```

If no files changed, skip this step.

## Follow-Up Work Not In This Plan

- Convert the official `CarnivalEventTotalScoreRewardTable` into `assets/carnival_event_total_score_reward.json`.
- Add carnival period checks: `/carnival_event/index` result code `5303` and quest start result code `4050`.
- Add `/load` serialization for `carnival_event_record_list`.
- Confirm whether pass card point reward kind `5` exists in this CN package and map it when a service-side account field is available.
