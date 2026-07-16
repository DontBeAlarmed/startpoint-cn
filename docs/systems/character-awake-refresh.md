# Character Awake refresh

## Client behavior

The CN 1.8.1 client reads `mana_board_awake[1]` when
`CharacterAwakeScene.preparation()` runs. A value of `0` disables the second
tab; a positive value selects the Awake node page and is also used as the
target awake level.

`MissionGetProgressProcessingFlow` refreshes only the displayed mission list.
It does not recalculate the scene's cached `boardAwakeLevel` or enable the
second tab.

Every API response can, however, include the common `character_list` field.
`RealRemoteService` parses it before endpoint-specific handling and
`PlayerLogic.applyCommonResponseCharacterList()` applies `mana_board_awake` to
the owned character.

## Server behavior

- `/mission/update_mission_progress` only stores progress deltas. It does not
  grant CharacterAwake rewards or return `mana_board_awake`.
- A category 9 `/mission/get_mission_progress` request settles completed,
  unreceived stages when the player enters the CharacterAwake mission screen.
- Settlement returns `mission_info` for the official reward toast, changed
  inventory collections, and `character_list.mana_board_awake` only when the
  reward row contains an `AwakeManaBoard` special reward.
- `/load` derives mission unlocks from received special-reward stages and merges
  them with levels reconstructed from stored node state, taking the maximum per
  board.
- `active_mission_list` remains separate from `all_active_mission_list`; Awake
  category IDs are not injected into the latter.

`/character/awake_mana_node` also enforces the server-side gate. The request is
rejected unless the `AwakeManaBoard` special reward has been settled, the
requested level matches the unlocked level, every base board node has been
learned, and every requested node belongs to board 1. Duplicate/empty node
lists are invalid. Mana, items, and node awake levels are committed in one
SQLite transaction.

## Remaining client limitation

If the final mission completes while `CharacterAwakeScene` is already open,
the scene has already cached the old level. Leave and re-enter the character
Awake page to rebuild it. Enabling the tab in place would require a client
patch; it cannot be forced by a server response alone.
