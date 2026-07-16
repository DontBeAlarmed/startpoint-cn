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

- `/mission/update_mission_progress` returns minimal `character_list` entries
  for characters whose four Awake missions are complete.
- `/mission/get_mission_progress` returns the same entries as a fallback.
- `/load` merges mission-unlocked levels with levels reconstructed from stored
  node state, taking the maximum per board.
- `active_mission_list` remains separate from `all_active_mission_list`; Awake
  category IDs are not injected into the latter.

## Remaining client limitation

If the final mission completes while `CharacterAwakeScene` is already open,
the scene has already cached the old level. Leave and re-enter the character
Awake page to rebuild it. Enabling the tab in place would require a client
patch; it cannot be forced by a server response alone.
