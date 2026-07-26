from math import floor
import field_map as f
import quest_builder as qb

def convert_ranking_event_single_quest(obj):
    layout = f.TYPE_MAP['ranking_event_single_quest']['layout']
    converted = {}
    for _, quests in obj.items():
        for _, quest in quests.items():
            row = qb.unwrap(quest)
            converted[row[layout['quest_id']]] = {
                "name": "",
                "bRankTime": 0, "aRankTime": 0, "sRankTime": 0, "sPlusRankTime": 0,
                "rankPointReward": 0, "characterExpReward": 0, "manaReward": 0, "poolExpReward": 0
            }
    return converted 

def convert_solo_time_attack_event_quest(obj):
    return qb.convert_3level(obj, f.TYPE_MAP['solo_time_attack_event_quest']['layout'], hardcode_clear_reward=False, hardcode_s_plus=True)

def convert_raid_event_quest(obj):
    converted = qb.convert_3level(obj, f.TYPE_MAP['raid_event_quest']['layout'], hardcode_clear_reward=False)
    for event_id, stages in obj.items():
        for _, row_wrapper in stages.items():
            row = qb.unwrap(row_wrapper)
            quest = converted[str(row[0])]
            quest['eventId'] = int(event_id)
            quest['folderId'] = int(row[2])
            quest['killCountWeight'] = int(row[52])
    return converted

def convert_character_quests(obj):
    converted = {}
    for story_id, character_story in obj.items():
        converted[story_id] = {
            "name": "",
            "clearRewardId": int(character_story[5])
        }
    return converted


def convert_hard_multi_event_quest(obj):
    """Convert Hard Multi rows using the CN 1.8.1 generated field order."""
    layout = f.TYPE_MAP['hard_multi_event_quest']['layout']
    converted = {}
    for _, stages in obj.items():
        for _, row_wrapper in stages.items():
            row = qb.unwrap(row_wrapper)
            quest_id = str(row[layout['quest_id']])
            converted[quest_id] = {
                "name": row[layout['name']],
                "clearRewardId": qb.optional_int(row, layout['clear_reward']),
                "sPlusRewardId": qb.optional_int(row, layout['s_plus_reward']),
                "bRankTime": qb.optional_float_ms(row, layout['rank_b']) or 0,
                "aRankTime": qb.optional_float_ms(row, layout['rank_a']) or 0,
                "sRankTime": qb.optional_float_ms(row, layout['rank_s']) or 0,
                "sPlusRankTime": qb.optional_float_ms(row, layout['rank_sp']) or 0,
                "rankPointReward": qb.optional_int(row, layout['rank_point']) or 0,
                "characterExpReward": qb.optional_int(row, layout['char_exp']) or 0,
                "manaReward": qb.optional_int(row, layout['mana']) or 0,
                "poolExpReward": qb.optional_int(row, layout['pool_exp']) or 0,
            }
    return converted
