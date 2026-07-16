import field_map as f
import quest_builder as qb

def convert_daily_exp_mana_event_quest(obj):
    return qb.convert_3level(obj, f.TYPE_MAP['daily_exp_mana_event_quest']['layout'], hardcode_s_plus=False)



def convert_daily_week_event_quest(obj):
    return qb.convert_3level(obj, f.TYPE_MAP['daily_week_event_quest']['layout'], hardcode_s_plus=False)



def convert_tower_dungeon_event_quest(obj):
    return qb.convert_3level(obj, f.TYPE_MAP['tower_dungeon_event_quest']['layout'], hardcode_clear_reward=False, hardcode_s_plus=False)



def convert_carnival_event_quest(obj):
    converted = qb.convert_3level(obj, f.TYPE_MAP['carnival_event_quest']['layout'], hardcode_s_plus=False)
    for event_id, stages in obj.items():
        for _, row_wrapper in stages.items():
            row = qb.unwrap(row_wrapper)
            quest = converted[str(row[0])]
            quest['eventId'] = int(event_id)
            quest['folderId'] = int(row[1])
            quest['timeLimitMs'] = int(row[100])
            quest['difficultyScore'] = int(float(row[104]))
    return converted



def convert_rush_event_quest(obj):
    converted = {}
    for rush_event_id_str, quests in obj.items():
        rush_event_id = int(rush_event_id_str)
        for _, quest in quests.items():
            quest = quest[0]  # extract inner array
            converted[quest[0]] = {
                "name": "",
                "bRankTime": 0,
                "aRankTime": 0,
                "sRankTime": 0,
                "sPlusRankTime": 0,
                "rankPointReward": int(quest[82]),
                "characterExpReward": int(quest[83]),
                "manaReward": int(quest[84]),
                "poolExpReward": int(quest[85]),
                "rushEventId": rush_event_id,
                "rushEventFolderId": int(quest[1]),
                "rushEventRound": int(quest[2])
            }
            if quest[73] != "(None)" and quest[73] != "":
                converted[quest[0]]["element"] = int(quest[73])
    return converted 

