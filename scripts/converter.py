# Converts the output/orderedmap files into a format readable by the server.
import os
from util import parse_file, save_json
from converters import (
    # quests
    convert_main_ex_quests, convert_boss_quests,
    convert_world_story_event_quest, convert_world_story_event_boss_battle_quest,
    convert_advent_quest, convert_daily_exp_mana_event_quest,
    convert_daily_week_event_quest, convert_challenge_dungeon_event_quest,
    convert_story_event_single_quest, convert_ranking_event_single_quest,
    convert_solo_time_attack_event_quest, convert_tower_dungeon_event_quest,
    convert_expert_single_event_quest, convert_carnival_event_quest,
    convert_raid_event_quest, convert_rush_event_quest,
    convert_score_attack_event_quest, convert_character_quests, convert_hard_multi_event_quest,
    # rewards
    convert_score_attack_border_reward, convert_clear_rewards,
    convert_score_reward, convert_rare_score_reward,
    convert_rush_event_quest_folder, convert_rush_event_ranking_reward,
    # gacha
    convert_box_rewards, convert_box_gacha, convert_gacha,
    convert_gacha_campaigns,
    # shop
    convert_general_shop, convert_boss_coin_shop, convert_event_item_shop,
    convert_treasure_shop, convert_star_grain_shop, convert_equipment_enhancement_shop,
    # items
    convert_characters, convert_mana_nodes, convert_ex_boost,
    convert_ex_status, convert_ex_ability,
    # misc
    convert_encyclopedia,
)

ROOT = os.path.dirname(os.path.realpath(__file__))
FILE_INPUT = os.path.join(ROOT, 'in')
FILE_OUTPUT = os.path.join(ROOT, "out")

if not os.path.exists(FILE_OUTPUT):
    os.makedirs(FILE_OUTPUT)
if not os.path.exists(FILE_INPUT):
    os.makedirs(FILE_INPUT)

# define the files to convert
to_convert_files = {
    "main_quest": convert_main_ex_quests,
    "ex_quest": convert_main_ex_quests,
    "boss_battle_quest": convert_boss_quests,
    "character_quest": convert_character_quests,
    "clear_reward": convert_clear_rewards,
    "score_reward": convert_score_reward,
    "character": convert_characters,
    "rare_score_reward": convert_rare_score_reward,
    "mana_node": convert_mana_nodes,
    "ex_boost": convert_ex_boost,
    "ex_status": convert_ex_status,
    "ex_ability": convert_ex_ability,
    "world_story_event_boss_battle_quest": convert_world_story_event_boss_battle_quest,
    "world_story_event_quest": convert_world_story_event_quest,
    "advent_event_quest": convert_advent_quest,
    "daily_exp_mana_event_quest": convert_daily_exp_mana_event_quest,
    "daily_week_event_quest": convert_daily_week_event_quest,
    "challenge_dungeon_event_quest": convert_challenge_dungeon_event_quest,
    "story_event_single_quest": convert_story_event_single_quest,
    "ranking_event_single_quest": convert_ranking_event_single_quest,
    "solo_time_attack_event_quest": convert_solo_time_attack_event_quest,
    "tower_dungeon_event_quest": convert_tower_dungeon_event_quest,
    "expert_single_event_quest": convert_expert_single_event_quest,
    "carnival_event_quest": convert_carnival_event_quest,
    "rush_event_quest": convert_rush_event_quest,
    "raid_event_quest": convert_raid_event_quest,
    "score_attack_event_quest": convert_score_attack_event_quest,
    "hard_multi_event_quest": convert_hard_multi_event_quest,
    "score_attack_border_reward": convert_score_attack_border_reward,
    "box_reward": convert_box_rewards,
    "box_gacha": convert_box_gacha,
    "gacha": convert_gacha,
    "gacha_campaign": convert_gacha_campaigns,
    "general_shop": convert_general_shop,
    "boss_coin_shop": convert_boss_coin_shop,
    "event_item_shop": convert_event_item_shop,
    "treasure_shop": convert_treasure_shop,
    "equipment_enhancement_shop": convert_equipment_enhancement_shop,
    "star_grain_shop": convert_star_grain_shop,
    "encyclopedia": convert_encyclopedia,
    "rush_event_quest_folder": convert_rush_event_quest_folder,
    "rush_event_ranking_reward": convert_rush_event_ranking_reward,
}

for file_name, converter in to_convert_files.items():
    file_name = f"{file_name}.json"
    parsed = parse_file(os.path.join(FILE_INPUT, file_name))
    if parsed is None:
        print(f"{file_name} file not found inside the '/in' folder. Skipping...")
    else:
        save_json(converter(parsed), os.path.join(FILE_OUTPUT, file_name))
