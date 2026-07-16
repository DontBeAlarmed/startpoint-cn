# Character Awake Reward Settlement Design

## Goal

Align CharacterAwake mission rewards with the CN 1.8.1 client: gameplay updates
progress silently, while opening the CharacterAwake mission screen settles newly
completed rewards, shows mission reward toasts, and applies the final mana-board
unlock.

## Confirmed Client Contract

`CharacterAwakeScene.afterTransition()` requests
`mission/get_mission_progress` with category 9 and the selected character ID.
The endpoint-specific flow consumes `mission_progress_list`. Before that flow,
the common-response handler applies `item_list` and `character_list`, and turns
each `mission_info` entry into a mission reward toast.

CharacterAwake reward rows contain three distinct pieces of data:

- column 0: `mission_reward_id`, used by `mission_info` and the client toast;
- columns 1-4: optional `AwakeManaBoard(character_id, board_index, awake_level)`;
- columns 9 onward: normal item, equipment, character, currency, or EXP rewards.

## Server Design

Add a CharacterAwake-specific settlement module. It receives the computed
category 9 mission progress for the requested character, compares completed
stages with persisted `players_category_mission_stages` receipt state, and
settles only completed, unreceived stages.

Settlement runs in one SQLite transaction:

1. persist the server-computed mission progress;
2. grant normal rewards through `MissionRewardGranter`;
3. mark the category 9 stage received;
4. collect `mission_info` using the row's actual `mission_reward_id`;
5. apply any `AwakeManaBoard` special reward to the response unlock map.

The final unlock remains persistable without a new table because receipt of the
stage containing `AwakeManaBoard` is durable. Full-load serialization derives
the unlock from received special-reward stages, while already-awakened node
state remains the post-awakening fallback.

`mission/update_mission_progress` will continue to store counter deltas but will
stop returning CharacterAwake `character_list`. It must not settle category 9
rewards or unlock the board.

## Response Behavior

The first category 9 screen request after completion returns:

- the normal `mission_progress_list`;
- `mission_info` entries for newly settled reward rows;
- changed `item_list`, `user_info`, `equipment_list`, `character_list`, and
  `degree_list` collections as applicable;
- a `character_list.mana_board_awake` update only when a newly settled special
  reward unlocks the board.

Repeated requests find the stages already received and return no duplicate
rewards, mission toasts, or unlock event.

## Compatibility

Historical stages already marked received are trusted and are not granted
again. Completed stages with no receipt row are settled on the next screen
entry. Existing player and category mission schemas are sufficient.

## Verification

Focused tests cover reward metadata parsing, completion versus receipt state,
first settlement, idempotent repeated settlement, final special unlock, and the
absence of a silent update unlock. TypeScript compilation and repository hygiene
checks complete the verification.
