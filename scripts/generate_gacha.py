#!/usr/bin/env python3
"""
Generate complete assets/gacha.json for CN gacha banners.
Data sources:
  - CN gacha.json (banner metadata: ID, dates, costs, types)
  - CN gacha_feature_content.json (UP characters per banner)
  - User's character_table.json (常驻卡池 permanent pool)
  - CN character.json (CDN CharacterTable for UP validation)
"""

import json, sys, os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# Load data sources
def load_json(path):
    with open(path) as f:
        return json.load(f)

ROOT = os.path.dirname(PROJECT_ROOT)
print("Loading data sources...")
cn_gacha = load_json(os.path.join(ROOT, "wf-assets-cn", "orderedmap", "gacha", "gacha.json"))
cn_fc = load_json(os.path.join(ROOT, "wf-assets-cn", "orderedmap", "gacha", "gacha_feature_content.json"))
cn_chars = load_json(os.path.join(ROOT, "wf-assets-cn", "orderedmap", "character", "character.json"))

# Global equipment gacha IDs for detection
global_eq_ids = {'3','5000','5001','5002','5003','5004','5005','5006','5007','5008','5009','5010','5011','5012','5013','5014','5015','5016','5017','5018','5019','5020','5021','5022','5023','5024','5025','5026','5027','5028','5029','5030','5031','5032','5033','5034','5035','5036','5037','5038'}

cn_eq_pool = {"1": [{"id": 5010028, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5020008, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5020010, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5020030, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5020037, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5030025, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5040010, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5040016, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5050009, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5060009, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5060025, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5070023, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5070036, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5080007, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}, {"id": 5100002, "rank": 5, "odds": 1, "isRateUp": False, "rarity": 66.67}], "2": [{"id": 4010010, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4020007, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4030003, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4030004, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4030008, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4030009, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4030024, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4040007, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4040008, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4040021, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4050004, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4050007, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4060005, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4060022, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4060028, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4060032, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4060035, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4070004, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4070007, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4080003, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4080015, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4080019, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4080021, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}, {"id": 4080027, "rank": 4, "odds": 1, "isRateUp": False, "rarity": 41.67}], "3": [{"id": 3010007, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3010008, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3010013, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3010027, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3010035, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3010053, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3020006, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3020011, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3020012, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3030007, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3030012, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3030013, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3030027, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3040003, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3040006, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3040032, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3050002, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3050005, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3050010, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3060003, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3060007, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3070006, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3070010, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3070018, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3070022, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3080008, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3080009, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3080017, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}, {"id": 3100007, "rank": 3, "odds": 1, "isRateUp": False, "rarity": 34.48}]}

# Normalized equipment rarity: sum per tier ≈ 1000
# Already applied above, values are final

# 1. Build pool template from user's character_table.json (permanent gacha pool)
char_table_path = os.path.join(os.path.dirname(__file__), "..", "data", "character_table.json")
char_table = load_json(char_table_path)

pool_template = {'1': [], '2': [], '3': []}  # 1=★5, 2=★4, 3=★3
for item in char_table:
    if item.get('source') != '常驻卡池':
        continue
    code = str(item.get('code_number', ''))
    if not code:
        continue
    # 首位数决定星级: 1=★5, 2=★4, 3=★3
    first = code[0]
    if first == '1':   rank = 5; pool_key = '1'
    elif first == '2': rank = 4; pool_key = '2'
    elif first == '3': rank = 3; pool_key = '3'
    else: continue
    pool_template[pool_key].append({
        'id': int(code),
        'rank': rank,
        'odds': 1,
        'isRateUp': False,
        'rarity': 0  # recalculated per banner
    })

print(f"Template pool from user table: ★5={len(pool_template['1'])} ★4={len(pool_template['2'])} ★3={len(pool_template['3'])} total={sum(len(v) for v in pool_template.values())}")

# 2. Extract UP characters per gacha from feature_content

# 2. Extract UP characters per gacha from feature_content
cdn_codes = set(cn_chars.keys())  # for validation

def extract_up_chars(gacha_id):
    """Return list of UP character codes for a gacha banner"""
    chars = set()
    
    # 1. Try from gacha_feature_content.json
    if gacha_id in cn_fc:
        for sections in cn_fc[gacha_id].values():
            for row in sections:
                for cell in row:
                    s = str(cell)
                    if s.isdigit() and len(s) == 6 and not s.startswith('0'):
                        if s in cdn_codes:
                            chars.add(s)
    
    # 2. Also read UP characters from gacha.json columns
    # CN gacha has UP character IDs in various column positions
    # Accept both 5-digit (old k_id) and 6-digit (business code) formats
    if gacha_id in cn_gacha:
        rows = cn_gacha[gacha_id]
        row = rows[0] if isinstance(rows, list) and len(rows) > 0 and isinstance(rows[0], list) else rows
        if isinstance(row, list):
            up_cols = [21, 22, 23, 26, 27, 28]
            for col in up_cols:
                if col < len(row) and row[col] not in ('', '(None)', None):
                    try:
                        code = str(int(row[col]))
                        if code.isdigit() and (len(code) == 5 or len(code) == 6):
                            # Accept any 5-6 digit character ID (old k_id or business code)
                            chars.add(code)
                    except (ValueError, TypeError):
                        pass
    
    return list(chars)

# 3. Build complete gacha.json
output = {}
skipped = 0
generated = 0

for gid, rows in cn_gacha.items():
    if not isinstance(rows, list) or len(rows) == 0:
        continue
    
    row = rows[0] if isinstance(rows[0], list) else rows
    
    # Parse CN metadata
    gacha_type = int(row[9]) if len(row) > 9 and str(row[9]).isdigit() else 0
    # CN type: 1=character, 2=equipment (mapped to global: 0=char, 1=eq)
    global_type = 0 if gacha_type == 1 else 1 if gacha_type == 2 else 0
    
    single_cost = int(row[5]) if len(row) > 5 and str(row[5]).isdigit() else 150
    multi_cost = int(row[6]) if len(row) > 6 and str(row[6]).isdigit() else 1500
    discount_cost = int(row[7]) if len(row) > 7 and str(row[7]).isdigit() else 50
    
    movie_name = str(row[17]) if len(row) > 17 else 'normal'
    guarantee_movie = str(row[18]) if len(row) > 18 else 'normal_guarantee'
    start_date = str(row[29]) if len(row) > 29 else '2000-01-01 00:00:00'
    end_date = str(row[30]) if len(row) > 30 else '2099-01-01 00:00:00'
    
    name = str(row[1]) if len(row) > 1 else f'Gacha {gid}'
    
    # Detect equipment gacha
    is_equipment = gid in global_eq_ids or '装备' in name or '武器' in name or '武具' in name or name.startswith('装备')
    
    if is_equipment:
        # Equipment banner — use CN equipment pool
        global_type = 1
        single_cost = int(row[5]) if len(row) > 5 and str(row[5]).isdigit() else 75
        multi_cost = int(row[6]) if len(row) > 6 and str(row[6]).isdigit() else 750
        discount_cost = 25
        
        banner = {
            'type': global_type,
            'paymentType': 0,
            'singleCost': single_cost,
            'multiCost': multi_cost,
            'discountCost': discount_cost,
            'startDate': start_date,
            'endDate': end_date,
            'name': name,
            'pool': cn_eq_pool
        }
        output[gid] = banner
        generated += 1
        continue
    
    # Build pool from template + UP characters
    # Deep copy template pool
    pool = {}
    for pk in ['1', '2', '3']:
        pool[pk] = [dict(item) for item in pool_template[pk]]
    
    # Add UP characters from feature_content
    up_codes = extract_up_chars(gid)
    
    # Per-tier UP targets: within-tier probability per UP character
    # ★5: single=1.5%, double=1.0%, triple=0.7%, quad=0.5% → within ★5: ÷5%
    # ★4: single=2.5%, double=2.0% → within ★4: ÷25%
    # ★3: no rate-up
    up_targets = {
        '1': {1: 0.30, 2: 0.20, 3: 0.14, 4: 0.10},  # ★5
        '2': {1: 0.10, 2: 0.08},                       # ★4
    }
    
    # Count UP per tier
    up_by_tier = {'1': set(), '2': set(), '3': set()}
    for code in up_codes:
        code_str = str(code)
        first = code_str[0]
        if first in up_by_tier:
            up_by_tier[first].add(code_str)
    
    # Calculate odds per tier
    # Formula: w = tier_non_up × target / (1 - target × tier_up_count)
    tier_odds = {}
    for pk in ['1', '2']:
        tier_up_count = len(up_by_tier[pk])
        if tier_up_count == 0:
            continue
        target = up_targets[pk].get(tier_up_count)
        if target is None:
            continue
        tier_non_up = len(pool_template[pk])
        denom = 1 - target * tier_up_count
        if denom > 0:
            tier_odds[pk] = max(1, round(tier_non_up * target / denom))
        else:
            tier_odds[pk] = 50
    
    for code in up_codes:
        code_str = str(code)
        # Determine rarity tier from code prefix
        if code_str[0] == '1':   rank = 5; pk = '1'
        elif code_str[0] == '2': rank = 4; pk = '2'
        elif code_str[0] == '3': rank = 3; pk = '3'
        else:                     rank = 1; pk = '1'
        
        # Remove existing entry with same ID from template (if any)
        pool[pk] = [item for item in pool[pk] if int(item['id']) != int(code)]
        
        # ★3: no rate-up, use odds=1 (same as normal)
        up_odds = tier_odds.get(pk, 1)
        
        # Add as UP (or normal for ★3)
        pool[pk].append({
            'id': int(code),
            'rank': rank,
            'odds': up_odds,
            'isRateUp': True if pk in tier_odds else False,
            'rarity': 100  # placeholder, recalculated below
        })
    
    # Recalculate rarity values: sum per tier must ≈ 1000 for randomPoolItem(0, 1001)
    for pk in pool:
        items = pool[pk]
        if not items: continue
        total_weight = sum(item['odds'] for item in items)
        base = 1000.0 / total_weight if total_weight > 0 else 1.0
        for item in items:
            item['rarity'] = round(item['odds'] * base, 2)
    
    # Skip banners with empty pools
    total_chars = sum(len(pool[r]) for r in pool)
    if total_chars == 0:
        skipped += 1
        continue
    
    output[gid] = {
        'type': global_type,
        'paymentType': 0,
        'singleCost': single_cost,
        'multiCost': multi_cost,
        'discountCost': discount_cost,
        'movieName': movie_name,
        'guaranteeMovieName': guarantee_movie,
        'startDate': start_date,
        'endDate': end_date,
        'name': name,
        'pool': {r: items for r, items in pool.items() if items}
    }
    generated += 1

# Write output
out_path = os.path.join(ROOT, "starpoint-cn", "assets", "gacha.json")
with open(out_path, 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f"\nGenerated: {generated} banners")
print(f"Skipped: {skipped} (equipment gacha or empty)")
print(f"Template: {sum(len(v) for v in pool_template.values())} characters from user table (常驻卡池)")
print(f"Output: {out_path}")
print(f"File size: {os.path.getsize(out_path):,} bytes")
