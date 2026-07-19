def convert_score_attack_border_reward(obj):
    """Maps (event_id, local quest_id) to complete cumulative score reward rows."""
    lookup = {}
    for reward_id, entries in obj.items():
        if not isinstance(entries, list) or not entries:
            continue
        row = entries[0]
        event_id = int(row[1])
        quest_id = int(row[2])
        rewards = []
        for slot in range(6):
            base = 6 + slot * 3
            kind_value = row[base]
            if kind_value == '' or kind_value == '(None)':
                continue
            kind = int(kind_value)
            reward_id_value = row[base + 1]
            amount_value = row[base + 2]
            reward = {
                'kind': kind,
                'amount': int(amount_value),
            }
            if reward_id_value != '' and reward_id_value != '(None)':
                reward['id'] = int(reward_id_value)
            rewards.append(reward)
        tier = {
            'id': int(reward_id),
            'eventId': event_id,
            'questId': quest_id,
            'score': int(float(row[4])),
            'reasonId': int(row[5]),
            'rewards': rewards,
        }
        key = f'{event_id}_{quest_id}'
        if key not in lookup:
            lookup[key] = []
        lookup[key].append(tier)
    for key in lookup:
        lookup[key].sort(key=lambda tier: (tier['score'], tier['id']))
    return lookup

