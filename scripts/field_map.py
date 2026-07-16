# scripts/field_map.py
# Named field → array index mappings for each quest type layout.
# Sentinel values:
#   NOT_USED = -1   → this quest type doesn't have this field
#   ZERO     = -2   → field is always hardcoded 0
#   FROM_KEY = -3   → value comes from outer JSON key, not row[ ]

NOT_USED = -1
ZERO = -2
FROM_KEY = -3

# ─── Group 1: Standard Battle (main, ex, boss) ─────────────────────────
STANDARD = {
    'quest_id':      0,
    'clear_reward':  3,       # boss=4, others=3
    'score_group':   70,
    'element':       72,
    'rank_b':        84,
    'rank_a':        85,
    'rank_s':        86,
    'rank_sp':       87,
    'rank_point':    93,
    'char_exp':      94,
    'mana':          95,
    'pool_exp':      96,
    'fixed_party':   118,
    'story_check':   84,
}

BOSS = {**STANDARD, 'clear_reward': 4, 'fixed_party': NOT_USED}

# ─── Group 2: World Story Event ─────────────────────────────────────────
WORLD_STORY = {
    'quest_id':      0,
    'clear_reward':  4,
    'score_group':   71,
    'element':       73,
    'rank_b':        85,
    'rank_a':        86,
    'rank_s':        87,
    'rank_sp':       88,
    'rank_point':    94,
    'char_exp':      95,
    'mana':          96,
    'pool_exp':      97,
    'fixed_party':   119,
    'story_check':   85,
}

# ─── Group 3: World Story Boss ───────────────────────────────────────────
WORLD_STORY_BOSS = {
    'quest_id':      0,
    'clear_reward':  4,
    'score_group':   70,
    'element':       72,
    'rank_b':        84,
    'rank_a':        85,
    'rank_s':        86,
    'rank_sp':       87,
    'rank_point':    93,
    'char_exp':      94,
    'mana':          95,
    'pool_exp':      97,       # Note: not 96 — confirmed by CDN
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED, # always battle
}

# ─── Group 4: Advent Event ───────────────────────────────────────────────
ADVENT = {
    'quest_id':      0,
    'clear_reward':  4,
    'score_group':   76,
    'element':       76,        # Note: same index as score_group — intentional CDN layout
    'rank_b':        90,
    'rank_a':        91,
    'rank_s':        92,
    'rank_sp':       93,
    'rank_point':    97,
    'char_exp':      98,
    'mana':          99,
    'pool_exp':      100,
    'fixed_party':   NOT_USED,
    'story_check':   90,
}

# ─── Group 5: No-Timer Events ────────────────────────────────────────────
DAILY_EXP_MANA = {
    'quest_id':      0,
    'clear_reward':  4,
    'score_group':   66,
    'element':       NOT_USED,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    68,
    'char_exp':      69,
    'mana':          70,
    'pool_exp':      71,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

DAILY_WEEK = {
    'quest_id':      0,
    'clear_reward':  3,
    'score_group':   65,
    'element':       NOT_USED,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    67,
    'char_exp':      68,
    'mana':          69,
    'pool_exp':      70,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

TOWER = {
    'quest_id':      0,
    'clear_reward':  NOT_USED,
    'score_group':   69,
    'element':       NOT_USED,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    82,
    'char_exp':      83,
    'mana':          84,
    'pool_exp':      85,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

RUSH = {
    'quest_id':      0,
    'clear_reward':  NOT_USED,
    'score_group':   NOT_USED,
    'element':       73,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    82,
    'char_exp':      83,
    'mana':          84,
    'pool_exp':      85,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
    # rush-specific
    'folder_id':     1,
    'rush_round':    2,
}

CARNIVAL = {
    'quest_id':      0,
    'clear_reward':  6,
    'score_group':   NOT_USED,
    'element':       69,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    82,
    'char_exp':      83,
    'mana':          84,
    'pool_exp':      85,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

# ─── Group 6: Activity Campaign ──────────────────────────────────────────
STORY_EVENT_SINGLE = {
    'quest_id':      0,
    'clear_reward':  4,
    'score_group':   72,
    'element':       73,
    'rank_b':        86,
    'rank_a':        87,
    'rank_s':        88,
    'rank_sp':       89,
    'rank_point':    94,
    'char_exp':      95,
    'mana':          96,
    'pool_exp':      97,
    'fixed_party':   NOT_USED,
    'story_check':   86,
}

CHALLENGE = {
    'quest_id':      0,
    'clear_reward':  4,
    'score_group':   71,
    'element':       73,
    'rank_b':        85,
    'rank_a':        86,
    'rank_s':        87,
    'rank_sp':       88,
    'rank_point':    92,
    'char_exp':      93,
    'mana':          94,
    'pool_exp':      95,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

EXPERT_SINGLE = {
    'quest_id':      0,
    'clear_reward':  6,
    'score_group':   73,
    'element':       73,         # same as score_group — CDN layout
    'rank_b':        87,
    'rank_a':        88,
    'rank_s':        89,
    'rank_sp':       90,
    'rank_point':    96,
    'char_exp':      97,
    'mana':          98,
    'pool_exp':      99,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

SCORE_ATTACK = {
    'quest_id':      0,
    'clear_reward':  FROM_KEY,   # hardcoded to 1
    'score_group':   70,
    'element':       NOT_USED,
    'rank_b':        85,
    'rank_a':        86,
    'rank_s':        87,
    'rank_sp':       88,
    'rank_point':    92,
    'char_exp':      93,
    'mana':          94,
    'pool_exp':      95,
    'fixed_party':   NOT_USED,
    'story_check':   85,         # "" or "(None)" = story
}

# ─── Group 7: Special ────────────────────────────────────────────────────
RANKING = {
    'quest_id':      0,
    'clear_reward':  NOT_USED,
    'score_group':   NOT_USED,
    'element':       NOT_USED,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    ZERO,
    'char_exp':      ZERO,
    'mana':          ZERO,
    'pool_exp':      ZERO,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

SOLO_TIME = {
    'quest_id':      0,
    'clear_reward':  NOT_USED,
    'score_group':   71,
    'element':       NOT_USED,
    'rank_b':        51,
    'rank_a':        52,
    'rank_s':        53,
    'rank_sp':       54,
    'rank_point':    85,
    'char_exp':      86,
    'mana':          87,
    'pool_exp':      88,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

RAID = {
    'quest_id':      0,
    'clear_reward':  6,
    'score_group':   69,
    'element':       70,
    'rank_b':        ZERO,
    'rank_a':        ZERO,
    'rank_s':        ZERO,
    'rank_sp':       ZERO,
    'rank_point':    83,
    'char_exp':      84,
    'mana':          85,
    'pool_exp':      86,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

CHARACTER = {
    'quest_id':      FROM_KEY,   # JSON key is quest ID
    'clear_reward':  5,
    'score_group':   NOT_USED,
    'element':       NOT_USED,
    'rank_b':        NOT_USED,
    'rank_a':        NOT_USED,
    'rank_s':        NOT_USED,
    'rank_sp':       NOT_USED,
    'rank_point':    NOT_USED,
    'char_exp':      NOT_USED,
    'mana':          NOT_USED,
    'pool_exp':      NOT_USED,
    'fixed_party':   NOT_USED,
    'story_check':   NOT_USED,
}

# ─── Map: converter function name → layout + game category ──────────────
TYPE_MAP = {
    'main_quest':                        {'layout': STANDARD,           'cat': 1},
    'ex_quest':                          {'layout': STANDARD,           'cat': 4},
    'boss_battle_quest':                 {'layout': BOSS,               'cat': 2},
    'world_story_event_quest':           {'layout': WORLD_STORY,        'cat': 18},
    'world_story_event_boss_battle_quest':{'layout': WORLD_STORY_BOSS,  'cat': 19},
    'advent_event_quest':                {'layout': ADVENT,             'cat': 7},
    'daily_exp_mana_event_quest':        {'layout': DAILY_EXP_MANA,     'cat': 14},
    'daily_week_event_quest':            {'layout': DAILY_WEEK,         'cat': 6},
    'challenge_dungeon_event_quest':     {'layout': CHALLENGE,          'cat': 13},
    'story_event_single_quest':          {'layout': STORY_EVENT_SINGLE, 'cat': 10},
    'ranking_event_single_quest':        {'layout': RANKING,            'cat': 11},
    'solo_time_attack_event_quest':      {'layout': SOLO_TIME,          'cat': 25},
    'tower_dungeon_event_quest':         {'layout': TOWER,              'cat': 20},
    'expert_single_event_quest':         {'layout': EXPERT_SINGLE,      'cat': 21},
    'carnival_event_quest':              {'layout': CARNIVAL,           'cat': 22},
    'rush_event_quest':                  {'layout': RUSH,               'cat': 24},
    'raid_event_quest':                  {'layout': RAID,               'cat': 23},
    'score_attack_event_quest':          {'layout': SCORE_ATTACK,       'cat': 27},
    'character_quest':                   {'layout': CHARACTER,          'cat': 3},
}
