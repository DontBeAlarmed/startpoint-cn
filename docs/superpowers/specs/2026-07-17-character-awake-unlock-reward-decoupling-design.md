# Character Awake Unlock and Reward Decoupling Design

## Goal

Allow a character whose awakening missions are all complete to open the
CharacterAwake scene directly on tab 2, while keeping any unclaimed tab 1
mission rewards pending until the player manually opens tab 1.

This is a server-only change. The CN 1.8.1 client remains unmodified.

## Confirmed Client Contract

`CharacterAwakeScene.preparation()` caches `mana_board_awake[1]` before the
scene sends a CharacterAwake API request.

- A cached level of `0` selects tab 1, disables tab 2, and automatically sends
  `mission/get_mission_progress` after the transition.
- A positive cached level selects tab 2 and sends no automatic mission request.
- When the player later selects tab 1, `tabChanged(1)` sends
  `mission/get_mission_progress` if the mission list has not been requested in
  the current scene instance.

Consequently, a first-entry tab 2 unlock must already be present in client
player state before scene construction. Pending rewards can then be settled by
the existing manual tab 1 request.

## Accepted User Flow

### Missions Not All Complete

1. The character remains locked at `mana_board_awake[1] = 0`.
2. Entering CharacterAwake opens tab 1 and disables tab 2.
3. The automatic category 9 `get_mission_progress` request settles completed,
   unreceived stages in order.
4. The response shows `mission_info` reward notifications.
5. Tab 2 remains locked.

### Missions All Complete

1. The authoritative action that completes the final requirement persists the
   tab 2 unlock without claiming mission rewards.
2. That action's response includes the unlocked character's
   `character_list.mana_board_awake` value so the active client is updated.
3. Entering CharacterAwake opens tab 2 immediately and sends no mission request.
4. Rewards remain pending until the player manually selects tab 1.
5. The tab 1 `get_mission_progress` request grants every completed, unreceived
   reward and returns the corresponding `mission_info` notifications.
6. Repeated tab visits and later scene entries do not duplicate rewards.

If the player never opens tab 1, those mission rewards remain unclaimed. This
is intentional and is the accepted server-only compromise.

## State Model

Unlock availability and reward receipt are separate durable states.

### Unlock State

Add a `players_character_awake_unlocks` table:

```sql
CREATE TABLE IF NOT EXISTS players_character_awake_unlocks (
    player_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    board_index INTEGER NOT NULL,
    awake_level INTEGER NOT NULL,
    PRIMARY KEY (player_id, character_id, board_index),
    FOREIGN KEY (player_id) REFERENCES players (id) ON DELETE CASCADE
);
```

An upsert keeps the maximum `awake_level`. Unlock rows never regress when party
composition or another live condition changes later.

### Reward Receipt State

Continue using `players_category_mission_stages.status` for category 9 reward
receipt. Persisting an unlock must not insert or update a receipt row and must
not grant normal rewards.

The `AwakeManaBoard` special reward becomes an idempotent confirmation of an
already persisted unlock during later tab 1 settlement. The settlement still
marks its stage received and emits its actual `mission_reward_id`, but it does
not grant or advance the unlock a second time.

## Unlock Reconciliation

Create a focused CharacterAwake unlock service. For each candidate character it
will:

1. build the existing category 9 computation context;
2. compute the character's mission progress from authoritative player state and
   stored counters;
3. find completed reward stages carrying an `AwakeManaBoard` special reward;
4. upsert the corresponding character, board index, and awake level;
5. return only newly created or increased unlocks for response serialization.

Completion of the special-reward stage, rather than receipt of that stage,
drives the unlock. This preserves CDN-defined character, board, and level data
without hard-coding a specific mission ID.

Reconciliation runs after every authoritative mutation that can complete an
awakening requirement, including battle completion trackers, story completion,
bond-token completion, and applicable mission counter updates. Each affected
route merges newly unlocked character entries into its existing
`character_list` response by `character_id`.

`/load` also reconciles all owned CharacterAwake candidates before full player
serialization. This is the compatibility path for existing accounts and for a
final-action response that was not delivered to the client.

## Response and Serialization Rules

- Mutation responses include `mana_board_awake` only for unlocks newly created
  or increased by that request.
- `/load` reconstructs `mana_board_awake` from persisted unlock rows and merges
  it with actual mana-node awake levels, taking the maximum per board.
- `mission/get_mission_progress` continues returning reward inventory changes,
  `mission_info`, and mission progress for tab 1.
- Category 9 settlement may idempotently ensure the unlock row exists, but
  reward receipt is never required to expose tab 2.
- `/character/awake_mana_node` checks the persisted unlock row rather than a
  received special-reward stage. Existing node ownership, base-board
  completion, requested level, cost, and transaction validations remain intact.

## Compatibility and Recovery

Database version 4 will create the unlock table for existing databases and
backfill rows from received `AwakeManaBoard` stages. Existing nonzero mana-node
awake levels remain a serialization fallback and may also seed matching unlock
rows.

On the next `/load`, reconciliation additionally unlocks characters whose
missions were already complete but whose final rewards were never claimed.
Their receipt rows remain untouched, so manual tab 1 entry still grants the
pending rewards.

For immediate tab 2 entry in an active session, the response that observes the
final completion must reach the client. If it is lost, the client can still
enter with stale level `0`; the automatic tab 1 request will settle rewards and
return the unlock, but that already-created scene cannot enable tab 2 in place.
The next `/load` or scene entry repairs the presentation. No server response can
remove this client cache edge case.

## Transaction and Idempotency

- Unlock reconciliation uses a transaction and maximum-level upserts.
- Reward settlement keeps its existing transaction for progress persistence,
  grants, receipt updates, and player inventory persistence.
- Unlock writes and reward receipt writes remain logically independent even
  when category 9 settlement performs both as a recovery path.
- Duplicate final-action requests, repeated `/load`, repeated tab 1 requests,
  and repeated node-awakening requests must not duplicate unlocks or rewards.

## Verification

Focused tests will cover:

1. incomplete missions: tab 1 settlement behavior and no unlock;
2. final completion: unlock persisted with no reward receipt or inventory grant;
3. final-action response: merged `character_list.mana_board_awake`;
4. first entry after completion: client-visible data is sufficient for tab 2;
5. manual tab 1 request: all pending rewards and notifications are returned;
6. repeated tab 1 request: no duplicate rewards or notifications;
7. `/load` recovery for historical completed-but-unclaimed missions;
8. migration backfill for previously received unlock stages and awakened nodes;
9. `awake_mana_node` authorization using unlock state before tab 1 rewards are
   claimed;
10. TypeScript compilation and repository hygiene checks.

## Out of Scope

- Client changes that send a request when tab 2 first opens.
- Automatic reward settlement merely from entering an already unlocked tab 2.
- CDN request inference, periodic request inference, or other unreliable scene
  detection.
