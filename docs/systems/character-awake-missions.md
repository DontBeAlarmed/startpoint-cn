# 角色觉醒任务覆盖文档

> 状态: 部分完成   关键文件: src/routes/api/mission.ts, src/lib/mission.ts   数据源: assets/mission_char_awake.json, assets/character_quest_lookup.json

## 概览

- **144 条任务**（36 个角色 × 4 个槽位）
- **Category 9**，请求格式 `{"character_id": N, "category": 9}`
- `get_mission_progress` 中按 `lastDigit` 分发计算

### 槽位含义

| lastDigit | 含义 | 计算方式 |
|-----------|------|---------|
| 1 | 阅读个人剧情 / 队伍中编有X通关 | 故事计数 或 `clears.clear_count`（fallback） |
| 2 | 累计阅读故事（Alk）/ 队长或队伍通关 | Alk=`totalStories`，其他=`clears.clear_count` |
| 3 | 强化弹射（Alk）/ 共斗/限时 | Alk=0，其他=`clears.clear_count`（部分覆盖） |
| 4 | 完成全部觉醒任务 | 检查 slot 1+2+3 是否全部 ≥1 |

### 正确度评估

| 符号 | 含义 |
|------|------|
| ✅ | 完全计算，与官方对齐 |
| ⚠️ | 部分覆盖（clear_count 近似，缺少特定条件跟踪） |
| ❌ | 不可计算（需弹射/共斗/限时/玛纳/特定关卡数据） |

---

### 前22个角色（故事类型）覆盖

| char_id | s | mission_id | type_key | 描述 | 计算 | 正确度 |
|---------|---|------------|----------|------|------|:---:|
| 1 | 1 | 11 | alk_awake_mission_1 | 阅读阿尔克的所有个人剧情 | story count | ✅ |
| 1 | 2 | 12 | alk_awake_mission_2 | 累计阅读::x_count:: 篇角色故事 | totalStories | ✅ |
| 1 | 3 | 13 | alk_awake_mission_3 | 累计进行强化弹射::x_count::次 | return 0 | ❌ |
| 1 | 4 | 14 | alk_awake_mission_all | 完成全部觉醒任务 | 1+2+3 check | ✅ |
| 111001 | 1 | 1110011 | fire_dragon_awake_mission_1 | 阅读瓦格纳的剧情 | story count | ✅ |
| 111001 | 2 | 1110012 | fire_dragon_awake_mission_2 | 队长+特定队员通关 | clears.clear_count | ⚠️ |
| 111001 | 3 | 1110013 | fire_dragon_awake_mission_3 | 单人通关伊尔格拉乌 | clears.clear_count | ⚠️ |
| 111001 | 4 | 1110014 | fire_dragon_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 111003 | 1 | 1110031 | clarisse_awake_mission_1 | 队伍中编有克拉莉丝通关 | clears.clear_count | ✅ |
| 111003 | 2 | 1110032 | clarisse_awake_mission_2 | 队伍中编有克拉莉丝通关*次 | clears.clear_count | ⚠️ |
| 111003 | 3 | 1110033 | clarisse_awake_mission_3 | 队伍中编有克拉莉丝通关*次 | clears.clear_count | ⚠️ |
| 111003 | 4 | 1110034 | clarisse_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 121001 | 1 | 1210011 | brown_fighter_awake_mission_1 | 阅读索妮雅的剧情 | story count | ✅ |
| 121001 | 2 | 1210012 | brown_fighter_awake_mission_2 | 以索妮雅为队长强化弹射 | clears.clear_count | ⚠️ |
| 121001 | 3 | 1210013 | brown_fighter_awake_mission_3 | 单次战斗连击 | clears.clear_count | ⚠️ |
| 121001 | 4 | 1210014 | brown_fighter_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 121005 | 1 | 1210051 | commander_awake_mission_1 | 队伍中编有希丽奴通关 | clears.clear_count | ✅ |
| 121005 | 2 | 1210052 | commander_awake_mission_2 | 队伍中编有希丽奴通关*次 | clears.clear_count | ⚠️ |
| 121005 | 3 | 1210053 | commander_awake_mission_3 | 队伍中编有希丽奴通关*次 | clears.clear_count | ⚠️ |
| 121005 | 4 | 1210054 | commander_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 131004 | 1 | 1310041 | thunder_archer_awake_mission_1 | 队伍中编有梅媞斯通关 | clears.clear_count | ✅ |
| 131004 | 2 | 1310042 | thunder_archer_awake_mission_2 | 队伍中编有梅媞斯通关*次 | clears.clear_count | ⚠️ |
| 131004 | 3 | 1310043 | thunder_archer_awake_mission_3 | 队伍中编有梅媞斯通关*次 | clears.clear_count | ⚠️ |
| 131004 | 4 | 1310044 | thunder_archer_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 131005 | 1 | 1310051 | mighty_striker_awake_mission_1 | 阅读巴拉克的剧情 | story count | ✅ |
| 131005 | 2 | 1310052 | mighty_striker_awake_mission_2 | 以巴拉克为队长通关特定关卡 | clears.clear_count | ⚠️ |
| 131005 | 3 | 1310053 | mighty_striker_awake_mission_3 | 以巴拉克为队长共斗 | clears.clear_count | ⚠️ |
| 131005 | 4 | 1310054 | mighty_striker_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 141001 | 1 | 1410011 | wind_spgirl_awake_mission_1 | 队伍中编有希尔媞通关 | clears.clear_count | ✅ |
| 141001 | 2 | 1410012 | wind_spgirl_awake_mission_2 | 队伍中编有希尔媞通关*次 | clears.clear_count | ⚠️ |
| 141001 | 3 | 1410013 | wind_spgirl_awake_mission_3 | 队伍中编有希尔媞通关*次 | clears.clear_count | ⚠️ |
| 141001 | 4 | 1410014 | wind_spgirl_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 141003 | 1 | 1410031 | katana_ghost_awake_mission_1 | 阅读丛云的剧情 | story count | ✅ |
| 141003 | 2 | 1410032 | katana_ghost_awake_mission_2 | 通关八岐大蛇超级 | clears.clear_count | ⚠️ |
| 141003 | 3 | 1410033 | katana_ghost_awake_mission_3 | 获得丛云的全部信赖之证 | clears.clear_count | ❌ |
| 141003 | 4 | 1410034 | katana_ghost_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 151006 | 1 | 1510061 | combat_soldier_awake_mission_1 | 阅读贝瑞塔的剧情 | story count | ✅ |
| 151006 | 2 | 1510062 | combat_soldier_awake_mission_2 | 队长+特定队员通关 | clears.clear_count | ⚠️ |
| 151006 | 3 | 1510063 | combat_soldier_awake_mission_3 | 队长参与共斗 | clears.clear_count | ⚠️ |
| 151006 | 4 | 1510064 | combat_soldier_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 151007 | 1 | 1510071 | blade_dancer_awake_mission_1 | 队伍中编有里布拉姆通关 | clears.clear_count | ✅ |
| 151007 | 2 | 1510072 | blade_dancer_awake_mission_2 | 队伍中编有里布拉姆通关*次 | clears.clear_count | ⚠️ |
| 151007 | 3 | 1510073 | blade_dancer_awake_mission_3 | 队伍中编有里布拉姆通关*次 | clears.clear_count | ⚠️ |
| 151007 | 4 | 1510074 | blade_dancer_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 161001 | 1 | 1610011 | dimension_witch_awake_mission_1 | 队伍中编有贝尔赛蒂亚通关 | clears.clear_count | ✅ |
| 161001 | 2 | 1610012 | dimension_witch_awake_mission_2 | 队伍中编有贝尔赛蒂亚通关*次 | clears.clear_count | ⚠️ |
| 161001 | 3 | 1610013 | dimension_witch_awake_mission_3 | 队伍中编有贝尔赛蒂亚通关*次 | clears.clear_count | ⚠️ |
| 161001 | 4 | 1610014 | dimension_witch_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 161002 | 1 | 1610021 | veteran_hunter_awake_mission_1 | 阅读威隆的剧情 | story count | ✅ |
| 161002 | 2 | 1610022 | veteran_hunter_awake_mission_2 | 队长通关不能阵亡 | clears.clear_count | ⚠️ |
| 161002 | 3 | 1610023 | veteran_hunter_awake_mission_3 | 以队长通关*次 | clears.clear_count | ⚠️ |
| 161002 | 4 | 1610024 | veteran_hunter_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 211001 | 1 | 2110011 | dragon_slayer_awake_mission_1 | 阅读阿赛尔的剧情 | story count | ✅ |
| 211001 | 2 | 2110012 | dragon_slayer_awake_mission_2 | 队伍中编有特定队员通关 | clears.clear_count | ⚠️ |
| 211001 | 3 | 2110013 | dragon_slayer_awake_mission_3 | 队长通关特定关卡 | clears.clear_count | ⚠️ |
| 211001 | 4 | 2110014 | dragon_slayer_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 211002 | 1 | 2110021 | lady_summoner_awake_mission_1 | 队伍中编有碧安卡通关 | clears.clear_count | ✅ |
| 211002 | 2 | 2110022 | lady_summoner_awake_mission_2 | 队伍中编有碧安卡通关*次 | clears.clear_count | ⚠️ |
| 211002 | 3 | 2110023 | lady_summoner_awake_mission_3 | 队伍中编有碧安卡通关*次 | clears.clear_count | ⚠️ |
| 211002 | 4 | 2110024 | lady_summoner_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 221001 | 1 | 2210011 | swallow_knight_awake_mission_1 | 队伍中编有尤维尔通关 | clears.clear_count | ✅ |
| 221001 | 2 | 2210012 | swallow_knight_awake_mission_2 | 队伍中编有尤维尔通关*次 | clears.clear_count | ⚠️ |
| 221001 | 3 | 2210013 | swallow_knight_awake_mission_3 | 队伍中编有尤维尔通关*次 | clears.clear_count | ⚠️ |
| 221001 | 4 | 2210014 | swallow_knight_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 221004 | 1 | 2210041 | alice_awake_mission_1 | 阅读爱丽丝的剧情 | story count | ✅ |
| 221004 | 2 | 2210042 | alice_awake_mission_2 | 队伍中编有特定队员通关 | clears.clear_count | ⚠️ |
| 221004 | 3 | 2210043 | alice_awake_mission_3 | 获得爱丽丝的全部信赖之证 | clears.clear_count | ❌ |
| 221004 | 4 | 2210044 | alice_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 231001 | 1 | 2310011 | thunder_dragon_awake_mission_1 | 阅读拉姆斯的剧情 | story count | ✅ |
| 231001 | 2 | 2310012 | thunder_dragon_awake_mission_2 | 队长+特定队员通关 | clears.clear_count | ⚠️ |
| 231001 | 3 | 2310013 | thunder_dragon_awake_mission_3 | 限时通关 | clears.clear_count | ❌ |
| 231001 | 4 | 2310014 | thunder_dragon_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 231006 | 1 | 2310061 | minotaur_girl_awake_mission_1 | 队伍中编有米诺通关 | clears.clear_count | ✅ |
| 231006 | 2 | 2310062 | minotaur_girl_awake_mission_2 | 队伍中编有米诺通关*次 | clears.clear_count | ⚠️ |
| 231006 | 3 | 2310063 | minotaur_girl_awake_mission_3 | 队伍中编有米诺通关*次 | clears.clear_count | ⚠️ |
| 231006 | 4 | 2310064 | minotaur_girl_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 241002 | 1 | 2410021 | birdman_awake_mission_1 | 队伍中编有奥罗尔通关 | clears.clear_count | ✅ |
| 241002 | 2 | 2410022 | birdman_awake_mission_2 | 队伍中编有奥罗尔通关*次 | clears.clear_count | ⚠️ |
| 241002 | 3 | 2410023 | birdman_awake_mission_3 | 队伍中编有奥罗尔通关*次 | clears.clear_count | ⚠️ |
| 241002 | 4 | 2410024 | birdman_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |

### 后 14 个角色（简单类型）覆盖

| char_id | s | mission_id | type_key | 描述 | 计算 | 正确度 |
|---------|---|------------|----------|------|------|:---:|
| 241063 | 1 | 2410631 | ekaki_girl_playable_awake_mission_1 | 阅读凉月的剧情 | story count | ✅ |
| 241063 | 2 | 2410632 | ekaki_girl_playable_awake_mission_2 | 队伍中编有特定队员通关 | clears.clear_count | ⚠️ |
| 241063 | 3 | 2410633 | ekaki_girl_playable_awake_mission_3 | 队伍中编有3队员通关 | clears.clear_count | ⚠️ |
| 241063 | 4 | 2410634 | ekaki_girl_playable_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 251003 | 1 | 2510031 | lightbullet_wiz_awake_mission_1 | 阅读艾莉亚的剧情 | story count | ✅ |
| 251003 | 2 | 2510032 | lightbullet_wiz_awake_mission_2 | 队长通关特定关卡 | clears.clear_count | ⚠️ |
| 251003 | 3 | 2510033 | lightbullet_wiz_awake_mission_3 | 限时通关 | clears.clear_count | ❌ |
| 251003 | 4 | 2510034 | lightbullet_wiz_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 251004 | 1 | 2510041 | palpebra_knight_awake_mission_1 | 阅读芬的剧情 | story count | ✅ |
| 251004 | 2 | 2510042 | palpebra_knight_awake_mission_2 | 队伍中编有特定队员通关 | clears.clear_count | ⚠️ |
| 251004 | 3 | 2510043 | palpebra_knight_awake_mission_3 | 获得芬的全部信赖之证 | clears.clear_count | ❌ |
| 251004 | 4 | 2510044 | palpebra_knight_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 251006 | 1 | 2510061 | unyielding_adventurer_awake_mission_1 | 队伍中编有莱亚通关 | clears.clear_count | ✅ |
| 251006 | 2 | 2510062 | unyielding_adventurer_awake_mission_2 | 队伍中编有莱亚通关*次 | clears.clear_count | ⚠️ |
| 251006 | 3 | 2510063 | unyielding_adventurer_awake_mission_3 | 队伍中编有莱亚通关*次 | clears.clear_count | ⚠️ |
| 251006 | 4 | 2510064 | unyielding_adventurer_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 261003 | 1 | 2610031 | battle_maid_awake_mission_1 | 队伍中编有玛丽安通关 | clears.clear_count | ✅ |
| 261003 | 2 | 2610032 | battle_maid_awake_mission_2 | 队伍中编有玛丽安通关*次 | clears.clear_count | ⚠️ |
| 261003 | 3 | 2610033 | battle_maid_awake_mission_3 | 队伍中编有玛丽安通关*次 | clears.clear_count | ⚠️ |
| 261003 | 4 | 2610034 | battle_maid_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 261007 | 1 | 2610071 | blindness_gunner_awake_mission_1 | 阅读赛吉尔的剧情 | story count | ✅ |
| 261007 | 2 | 2610072 | blindness_gunner_awake_mission_2 | 队长通关不能阵亡 | clears.clear_count | ⚠️ |
| 261007 | 3 | 2610073 | blindness_gunner_awake_mission_3 | 获得赛吉尔的全部信赖之证 | clears.clear_count | ❌ |
| 261007 | 4 | 2610074 | blindness_gunner_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 263002 | 1 | 2630021 | touyakiren_ceo_awake_mission_1 | 阅读拉芙的剧情 | story count | ✅ |
| 263002 | 2 | 2630022 | touyakiren_ceo_awake_mission_2 | 累计获得玛纳 | clears.clear_count | ❌ |
| 263002 | 3 | 2630023 | touyakiren_ceo_awake_mission_3 | 特定队员通关特定关卡 | clears.clear_count | ⚠️ |
| 263002 | 4 | 2630024 | touyakiren_ceo_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 311002 | 1 | 3110021 | pretty_witch_awake_mission_1 | 队伍中编有梅米通关 | clears.clear_count | ✅ |
| 311002 | 2 | 3110022 | pretty_witch_awake_mission_2 | 队伍中编有梅米通关*次 | clears.clear_count | ⚠️ |
| 311002 | 3 | 3110023 | pretty_witch_awake_mission_3 | 队伍中编有梅米通关*次 | clears.clear_count | ⚠️ |
| 311002 | 4 | 3110024 | pretty_witch_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 321009 | 1 | 3210091 | cute_fafnir_awake_mission_1 | 队伍中编有法夫通关 | clears.clear_count | ✅ |
| 321009 | 2 | 3210092 | cute_fafnir_awake_mission_2 | 队伍中编有法夫通关*次 | clears.clear_count | ⚠️ |
| 321009 | 3 | 3210093 | cute_fafnir_awake_mission_3 | 队伍中编有法夫通关*次 | clears.clear_count | ⚠️ |
| 321009 | 4 | 3210094 | cute_fafnir_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 321013 | 1 | 3210131 | scout_girl_mission_1 | 阅读莉塔的剧情 | story count | ✅ |
| 321013 | 2 | 3210132 | scout_girl_mission_2 | 队伍中编有莉塔通关特定关卡 | clears.clear_count | ⚠️ |
| 321013 | 3 | 3210133 | scout_girl_mission_3 | 队伍中编有莉塔通关特定关卡 | clears.clear_count | ⚠️ |
| 321013 | 4 | 3210134 | scout_girl_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 331002 | 1 | 3310021 | bee_girl_awake_mission_1 | 队伍中编有赫妮通关 | clears.clear_count | ✅ |
| 331002 | 2 | 3310022 | bee_girl_awake_mission_2 | 队伍中编有赫妮通关*次 | clears.clear_count | ⚠️ |
| 331002 | 3 | 3310023 | bee_girl_awake_mission_3 | 队伍中编有赫妮通关*次 | clears.clear_count | ⚠️ |
| 331002 | 4 | 3310024 | bee_girl_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 331003 | 1 | 3310031 | lightning_fighter_awake_mission_1 | 阅读泰加的剧情 | story count | ✅ |
| 331003 | 2 | 3310032 | lightning_fighter_awake_mission_2 | 队伍中编有特定队员通关 | clears.clear_count | ⚠️ |
| 331003 | 3 | 3310033 | lightning_fighter_awake_mission_3 | 队伍中编有特定队员通关 | clears.clear_count | ⚠️ |
| 331003 | 4 | 3310034 | lightning_fighter_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 341001 | 1 | 3410011 | highlander_awake_mission_1 | 阅读伊凡的剧情 | story count | ✅ |
| 341001 | 2 | 3410012 | highlander_awake_mission_2 | 队伍中编有伊凡通关特定关卡 | clears.clear_count | ⚠️ |
| 341001 | 3 | 3410013 | highlander_awake_mission_3 | 队伍中编有伊凡通关特定关卡 | clears.clear_count | ⚠️ |
| 341001 | 4 | 3410014 | highlander_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 341005 | 1 | 3410051 | cat_fighter_awake_mission_1 | 队伍中编有缪通关 | clears.clear_count | ✅ |
| 341005 | 2 | 3410052 | cat_fighter_awake_mission_2 | 队伍中编有缪通关*次 | clears.clear_count | ⚠️ |
| 341005 | 3 | 3410053 | cat_fighter_awake_mission_3 | 队伍中编有缪通关*次 | clears.clear_count | ⚠️ |
| 341005 | 4 | 3410054 | cat_fighter_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 351001 | 1 | 3510011 | priest_awake_mission_1 | 队伍中编有可莉娜通关 | clears.clear_count | ✅ |
| 351001 | 2 | 3510012 | priest_awake_mission_2 | 队伍中编有可莉娜通关*次 | clears.clear_count | ⚠️ |
| 351001 | 3 | 3510013 | priest_awake_mission_3 | 队伍中编有可莉娜通关*次 | clears.clear_count | ⚠️ |
| 351001 | 4 | 3510014 | priest_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |
| 361002 | 1 | 3610021 | chakram_shooter_awake_mission_1 | 队伍中编有札里尔通关 | clears.clear_count | ✅ |
| 361002 | 2 | 3610022 | chakram_shooter_awake_mission_2 | 队伍中编有札里尔通关*次 | clears.clear_count | ⚠️ |
| 361002 | 3 | 3610023 | chakram_shooter_awake_mission_3 | 队伍中编有札里尔通关*次 | clears.clear_count | ⚠️ |
| 361002 | 4 | 3610024 | chakram_shooter_awake_mission_all | 完成全部 | 1+2+3 check | ✅ |

---

### 统计

| 正确度 | 数量 |
|:---:|------|
| ✅ | 72 条（50%） |
| ⚠️ | 60 条（41%） |
| ❌ | 12 条（8%） |

### ❌ 不可计算详情

| 任务 | 角色 | 需要的数据 |
|------|------|-----------|
| `强化弹射` | Alk (1) | 弹射计数器 |
| `获得全部信赖之证` | 丛云(141003)、爱丽丝(221004)、芬(251004)、赛吉尔(261007) | 角色信用代币 |
| `累计获得玛纳` | 拉芙(263002) | 终身玛纳追踪 |
| `限时通关` | 拉姆斯(231001)、艾莉亚(251003) | 完成时间追踪 |
| 共斗（联机） | 贝瑞塔(151006)、巴拉克(131005) 等 | 多人战斗追踪（联机不稳定） |

### 后续完善路径

| 顺序 | 功能 | 工作量 | 将可解锁的 ❌ 数量 |
|------|------|--------|----------|
| 1 | 信用代币进度（从 `players_characters_bond_tokens` 读取） | 小 | 解锁 4 个 ❌ → ✅ |
| 2 | 终身玛纳追踪（DB 列） | 小 | 解锁 1 个 ❌ → ✅ |
| 3 | 特定任务完成（quest_id→task 映射） | 中 | 解锁 ~30 个 ⚠️ → ✅ |
| 4 | 弹射追踪 + 时间追踪 + 联机 | 大 | 解锁 3 个 ❌ → ✅ |
