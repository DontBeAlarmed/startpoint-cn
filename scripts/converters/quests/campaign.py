import field_map as f
import quest_builder as qb


def _optional_int(value):
    if value is None or value == '' or value == '(None)':
        return None
    return int(float(value))

def convert_story_event_single_quest(obj):
    return qb.convert_3level_with_story(obj, f.TYPE_MAP['story_event_single_quest']['layout'])



def convert_challenge_dungeon_event_quest(obj):
    return qb.convert_3level(obj, f.TYPE_MAP['challenge_dungeon_event_quest']['layout'])



def convert_expert_single_event_quest(obj):
    return qb.convert_3level_with_event(obj, f.TYPE_MAP['expert_single_event_quest']['layout'], event_field_name='eventId')



def convert_score_attack_event_quest(obj):
    converted = {}
    for event_id, folders in obj.items():
        for local_quest_id, wrapper in folders.items():
            if isinstance(wrapper, list):
                for quest in wrapper:
                    if not isinstance(quest, list) or len(quest) <= 104:
                        continue
                    qid = quest[0]
                    result = {
                        "name": quest[4],
                        "eventId": int(event_id),
                        "scoreAttackQuestId": int(local_quest_id),
                        "bRankScore": int(float(quest[52])),
                        "aRankScore": int(float(quest[53])),
                        "sRankScore": int(float(quest[54])),
                        "ssRankScore": int(float(quest[55])),
                        "rankPointReward": int(float(quest[86])),
                        "characterExpReward": int(float(quest[87])),
                        "manaReward": int(float(quest[88])),
                        "poolExpReward": int(float(quest[89])),
                        "element": int(quest[73]),
                        # Master data stores battle_time_limit in 60 FPS frames.
                        "timeLimitMs": round(int(quest[104]) * 1000 / 60),
                    }
                    folder_id = _optional_int(quest[1])
                    if folder_id is not None:
                        result["folderId"] = folder_id
                    clear_reward_id = _optional_int(quest[6])
                    if clear_reward_id is not None:
                        result["clearRewardId"] = clear_reward_id
                    score_reward_group_id = _optional_int(quest[72])
                    if score_reward_group_id is not None:
                        result["scoreRewardGroupId"] = score_reward_group_id
                    converted[qid] = result
    return converted

