# /latest/api/index.php/story_quest/finish_with_skip

Triggered when the player skips a story quest (e.g. NPC helper auto-complete or manual skip).
Same server logic as `/finish` — marks quest as completed and grants clear rewards.

## Request
### Body
```
{
  "category": int,      // QuestCategory (e.g. 3 = Character, 1 = Main)
  "quest_id": int,      // Quest numeric ID
  "party_id": int,      // Current party ID (used but not consumed)
  "viewer_id": int,     // Auto-injected by RequestQueue
  "api_count": int      // Auto-injected by RequestQueue
}
```

## Response
### Body
```
{
  "data_headers": {
    "force_update": false,
    "asset_update": false,
    "short_udid": 0,
    "viewer_id": <viewer_id>,
    "servertime": <unix_epoch>,
    "result_code": 1
  },
  "data": {
    "user_info": {
      "free_vmoney": int,
      "free_mana": int
    },
    "character_list": [],
    "joined_character_id_list": [],
    "equipment_list": [],
    "items": {},
    "presigned_quest_category": []
  }
}
```

If the quest was already completed, `data` is `[]` (empty array).

## Client
- `StoryQuestFinishWithSkipRealRemote.as` — sends request, `successHandler` is empty
- Response processed by `earlySuccessHandler` → extracts `user_info` etc. via CommonResponse pipeline
- Triggered by: `StoryQuestScene.finishScenarioSkip()` → `remote.storyQuestFinishWithSkip()`
