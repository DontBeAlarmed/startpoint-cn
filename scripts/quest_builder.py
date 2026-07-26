# scripts/quest_builder.py
# Shared functions to build quest dicts from CDN array rows using field_map layouts.

import field_map as f

def unwrap(row):
    """Extract inner array from single-element list wrapper."""
    if isinstance(row, list) and len(row) == 1 and isinstance(row[0], list):
        return row[0]
    return row

def optional_int(row, idx):
    """Return int from row[idx] if valid, else None."""
    if idx < 0:
        return None
    val = row[idx] if idx < len(row) else '(None)'
    if val == '(None)' or val == '':
        return None
    return int(val)

def optional_float_ms(row, idx):
    """Return float→int(ms) from row[idx] if valid, else None."""
    if idx < 0:
        return None
    from math import floor
    val = row[idx] if idx < len(row) else '(None)'
    if val == '(None)' or val == '':
        return None
    return floor(float(val) * 1000)

def required_bool(row, idx, field):
    """Return a strict boolean from the generated master-data spelling."""
    if idx < 0 or idx >= len(row):
        raise ValueError(f'missing {field}')
    val = row[idx]
    if val in ('true', 'True', 'TRUE'):
        return True
    if val in ('false', 'False', 'FALSE'):
        return False
    raise ValueError(f'invalid {field}: {val}')

def extract_rank_times(row, layout):
    """Return {bRankTime, aRankTime, sRankTime, sPlusRankTime} dict."""
    result = {}
    for field, idx_key in [('bRankTime', 'rank_b'), ('aRankTime', 'rank_a'),
                        ('sRankTime', 'rank_s'), ('sPlusRankTime', 'rank_sp')]:
        i = layout.get(idx_key)
        if i is None or i == f.NOT_USED:
            continue
        if i == f.ZERO:
            result[field] = 0
        else:
            v = optional_float_ms(row, i)
            result[field] = v if v is not None else 0
    return result

def extract_rewards(row, layout):
    """Return {rankPointReward, characterExpReward, manaReward, poolExpReward} dict."""
    result = {}
    mapping = [('rankPointReward', 'rank_point'), ('characterExpReward', 'char_exp'),
               ('manaReward', 'mana'), ('poolExpReward', 'pool_exp')]
    for out_field, layout_field in mapping:
        i = layout.get(layout_field)
        if i is None or i == f.NOT_USED:
            continue
        if i == f.ZERO:
            result[out_field] = 0
        else:
            result[out_field] = optional_int(row, i) or 0
    return result

def extract_element(row, layout):
    """Return element int or None if not present/valid."""
    i = layout.get('element')
    if i is None or i < 0:
        return None
    return optional_int(row, i)

def extract_score_group(row, layout):
    """Return scoreRewardGroupId int or None."""
    i = layout.get('score_group')
    if i is None or i < 0:
        return None
    return optional_int(row, i)

def extract_fixed_party(row, layout):
    """Return fixedParty int or None."""
    i = layout.get('fixed_party')
    if i is None or i < 0:
        return None
    return optional_int(row, i)

def is_story(row, layout):
    """Check if quest is story-only (no battle/battle rank time is empty)."""
    i = layout.get('story_check')
    if i is None or i < 0:
        return False
    val = row[i] if i < len(row) else ''
    return val == '' or val == '(None)'

# ── Converter helpers ──────────────────────────────────────────────────────

def convert_3level(obj, layout, hardcode_clear_reward=True, hardcode_s_plus=True, extra=None):
    """Generic 3-level nested event quest converter.
    
    obj:   {event_id → {stage_id → [row]}}
    layout: field_map layout dict
    hardcode_clear_reward: if True, set clearRewardId=1 when field not in layout
    hardcode_s_plus: if True, always set sPlusRewardId=1; if False, never set it
    extra: optional dict of extra fields to inject into every quest (e.g., eventId from outer key)
    
    Returns: {quest_id → quest_dict}
    """
    converted = {}
    for _, stages in obj.items():
        for _, row_wrapper in stages.items():
            row = unwrap(row_wrapper)
            qid = str(row[layout['quest_id']])
            q = {'name': ''}
            
            # clear reward
            ci = layout.get('clear_reward', -1)
            if ci is not None and ci >= 0:
                v = optional_int(row, ci)
                if v is not None:
                    q['clearRewardId'] = v
            elif hardcode_clear_reward:
                q['clearRewardId'] = 1
            
            # score reward group
            si = layout.get('score_group', -1)
            if si is not None and si >= 0:
                sg = optional_int(row, si)
                if sg is not None:
                    q['scoreRewardGroupId'] = sg
            
            # rank times — always include, ZERO fields write 0
            for field, idx_key in [('bRankTime','rank_b'),('aRankTime','rank_a'),
                                   ('sRankTime','rank_s'),('sPlusRankTime','rank_sp')]:
                idx = layout.get(idx_key)
                if idx is None or idx == f.NOT_USED:
                    continue
                if idx == f.ZERO:
                    q[field] = 0
                else:
                    val = optional_float_ms(row, idx)
                    q[field] = val if val is not None else 0
            
            # rewards
            rewards = extract_rewards(row, layout)
            for k, v in rewards.items():
                q[k] = v
            
            # element
            el = extract_element(row, layout)
            if el is not None:
                q['element'] = el
            
            # fixed party
            fp = extract_fixed_party(row, layout)
            if fp is not None:
                q['fixedParty'] = fp
            
            # hardcoded sPlusRewardId
            if hardcode_s_plus:
                q['sPlusRewardId'] = 1
            
            if extra:
                q.update(extra)
            
            converted[qid] = q
    return converted

def convert_3level_with_story(obj, layout, hardcode_clear_reward=True, hardcode_s_plus=True, extra=None):
    """3-level converter with story quest support. Story quests only get clearRewardId + name."""
    converted = {}
    for _, stages in obj.items():
        for _, row_wrapper in stages.items():
            row = unwrap(row_wrapper)
            qid = str(row[layout['quest_id']])
            
            if is_story(row, layout):
                q = {'name': ''}
                ci = layout.get('clear_reward', -1)
                if ci is not None and ci >= 0:
                    v = optional_int(row, ci)
                    if v is not None:
                        q['clearRewardId'] = v
                elif hardcode_clear_reward:
                    q['clearRewardId'] = 1
                converted[qid] = q
            else:
                # Battle quest — build quest directly from row
                q = {'name': ''}
                
                ci = layout.get('clear_reward', -1)
                if ci is not None and ci >= 0:
                    v = optional_int(row, ci)
                    if v is not None:
                        q['clearRewardId'] = v
                elif hardcode_clear_reward:
                    q['clearRewardId'] = 1
                
                si = layout.get('score_group', -1)
                if si is not None and si >= 0:
                    sg = optional_int(row, si)
                    if sg is not None:
                        q['scoreRewardGroupId'] = sg
                
                for field in ['bRankTime', 'aRankTime', 'sRankTime', 'sPlusRankTime']:
                    idx = layout.get({'bRankTime':'rank_b','aRankTime':'rank_a',
                                      'sRankTime':'rank_s','sPlusRankTime':'rank_sp'}[field])
                    if idx is None or idx == f.NOT_USED:
                        continue
                    if idx == f.ZERO:
                        q[field] = 0
                    else:
                        val = optional_float_ms(row, idx)
                        q[field] = val if val is not None else 0
                
                rewards = extract_rewards(row, layout)
                for k, v in rewards.items():
                    q[k] = v
                
                el = extract_element(row, layout)
                if el is not None:
                    q['element'] = el
                
                fp = extract_fixed_party(row, layout)
                if fp is not None:
                    q['fixedParty'] = fp
                
                if hardcode_s_plus:
                    q['sPlusRewardId'] = 1
                
                if extra:
                    q.update(extra)
                
                converted[qid] = q
    
    # Also handle battle branch extra injection
    for qid, q in list(converted.items()):
        if extra and len(q) > 1:  # has more than just name
            if 'sPlusRewardId' not in q and hardcode_s_plus:
                pass  # already handled
    return converted

# ── 4-level nested (main/ex/boss quests) ─────────────────────────────────

def convert_4level_with_story(obj, layout, story_clear_reward=None):
    """4-level nested quest converter with story quest support.
    story_clear_reward: override clear_reward index for story branch (default: use layout)."""
    from math import floor
    converted = {}
    for _, chapter_stages in obj.items():
        for _, sub_stages in chapter_stages.items():
            for _, quest_wrapper in sub_stages.items():
                row = unwrap(quest_wrapper)
                qid = str(row[layout['quest_id']])
                
                if is_story(row, layout):
                    q = {'name': ''}
                    ci = story_clear_reward if story_clear_reward is not None else layout.get('clear_reward', -1)
                    if ci is not None and ci >= 0:
                        v = optional_int(row, ci)
                        if v is not None:
                            q['clearRewardId'] = v
                    converted[qid] = q
                else:
                    q = {'name': ''}
                    cr = layout.get('clear_reward', -1)
                    if cr is not None and cr >= 0:
                        v = optional_int(row, cr)
                        if v is not None:
                            q['clearRewardId'] = v
                    sgr = layout.get('score_group', -1)
                    if sgr is not None and sgr >= 0:
                        v = optional_int(row, sgr)
                        if v is not None:
                            q['scoreRewardGroupId'] = v
                    for field, idx_key in [('bRankTime','rank_b'),('aRankTime','rank_a'),('sRankTime','rank_s'),('sPlusRankTime','rank_sp')]:
                        idx = layout.get(idx_key)
                        if idx is None or idx == f.NOT_USED:
                            continue
                        q[field] = optional_float_ms(row, idx) or 0
                    rewards = extract_rewards(row, layout)
                    for k, v in rewards.items():
                        q[k] = v
                    el = extract_element(row, layout)
                    if el is not None:
                        q['element'] = el
                    fp = extract_fixed_party(row, layout)
                    if fp is not None:
                        q['fixedParty'] = fp
                    both_boss = layout.get('is_both_boss')
                    if both_boss is not None and both_boss >= 0 \
                            and required_bool(row, both_boss, 'is_both_boss'):
                        q['isBothBoss'] = True
                    q['sPlusRewardId'] = 1
                    converted[qid] = q
    return converted

# ── 3-level with outer event key ─────────────────────────────────────────

def convert_3level_with_event(obj, layout, event_field_name='eventId', **kwargs):
    """3-level converter where the outer key is event_id, injected as a field.
    
    obj: {event_id → {quest_id → [row]}}
    event_field_name: name of the field to inject (e.g. 'eventId', 'rushEventId')
    kwargs: passed to convert_3level (hardcode_s_plus, etc.)
    """
    converted = {}
    for event_id, stages in obj.items():
        extra = {event_field_name: int(event_id)}
        # convert_3level expects {outer → {inner → [row]}}, wrap appropriately
        wrapped = {event_id: stages}
        result = convert_3level(wrapped, layout, extra=extra, **kwargs)
        converted.update(result)
    return converted
