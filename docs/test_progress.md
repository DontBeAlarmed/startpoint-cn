# 关卡/活动测试进度

每条需完成 **进入** 和 **结算** 两种流程测试。

## 测试清单

| # | 活动名称 | quest JSON | 关数 | 进入 | 结算 | 备注 |
|---|------|------|:---:|:---:|:---:|------|
| 1 | 嘉年华 | `carnival_event_quest` | 171 | ✅ | ✅ | 配队独立存储 EVENT；分数统计+通关队伍显示正常 |
| 2 | 战阵之宴（Rush） | `rush_event_quest` | 110 | ✅ | ⬜ | ⏸️ 涉及联机，延后测试 |
| 3 | Raid 活动 | `raid_event_quest` | 50 | ✅ | ⬜ | ⏸️ 联机多人，battle/start stub |
| 4 | 练习战 | `practice_quest` | 21 | 🔧 | 🔧 | 云水试炼进入+结算通过；余下 4 试炼待测（共 5 试炼，复用同一网络请求） |
| 5 | 分数挑战 | `score_attack_event_quest` | 123 | ✅ | ✅ | 进入+结算通过；⚠️ 无 scoreRewardGroup，仅首通 clearReward |
| 6 | 剧情活动 | `story_event_single_quest` | 348 | ⬜ | ⬜ | 需活动开放期 |
| 7 | 排名战 | `ranking_event_single_quest` | 7 | ✅ | ✅ | 测 2 个通过，走 single_battle_quest 通用流程 |
| 8 | 专家挑战 | `expert_single_event_quest` | 28 | ⬜ | ⬜ | 高难单人 |
| 9 | 主线关卡 | `main_quest` | 419 | ✅ | ✅ | 最常测试，稳定 |
| 10 | 高难关卡（EX） | `ex_quest` | 221 | ⬜ | ⬜ | |
| 11 | 角色剧情 | `character_quest` | 1,318 | ✅ | ✅ | story_quest/finish 通过；⚠️ 阅读后不记录已读状态（紫色标记不消除），待实现 episode_trial/save |
| 12 | 主线 BOSS 战 | `boss_battle_quest` | 232 | ⬜ | ⬜ | |
| 13 | 降临讨伐 | `advent_event_quest` | 459 | ⬜ | ⬜ | 需活动开放期 |
| 14 | 外传故事 | `world_story_event_quest` | 913 | ✅ | ✅ | 剧情关 S+ 金冠 + Boss 战正常评级；C3212 彻底修复（见底部详解） |
| 15 | 外传 BOSS（多人） | `world_story_event_boss_battle_quest` | 96 | ⬜ | ⬜ | 联机 Phase 2 |
| 16 | 挑战迷宫 | `challenge_dungeon_event_quest` | 46 | ⬜ | ⬜ | |
| 17 | 每日经验玛纳 | `daily_exp_mana_event_quest` | 6 | ⬜ | ⬜ | |
| 18 | 每日周常 | `daily_week_event_quest` | 114 | ⬜ | ⬜ | |
| 19 | 塔之迷宫 | `tower_dungeon_event_quest` | 480 | ⬜ | ⬜ | |
| 20 | 单人计时 | `solo_time_attack_event_quest` | 6 | ⬜ | ⬜ | |
| 21 | Hard Multi | `hard_multi_event_quest` | 12 | ⬜ | ⬜ | 联机 Phase 2 |

## 结算相关修复（影响所有关卡）

| 修复 | 影响 |
|------|------|
| C8702/C2280 mail 角色响应字段补齐 | 邮件领取角色不再报错 |
| F1010 bondTokenStatusList 空指针修复 | 战斗结算经验卡界面不再崩溃 |
| F1009 mana board 二版渲染崩溃 | 玛纳板正常显示 + 时间窗口适配 |
| C3032 抽卡动画种子不匹配 | ⚠️ 已知不修复（非必现） |
| shop/buy 响应 free_vmoney 补齐 | 购买后珠子余量正确显示 |
| CDN 白名单修正 | 商店商品不再 C8601 崩溃 |
| F1011 score reward MANA 写入 freeVmoney | `src/lib/quest.ts:61` `freeVmoney`→`freeMana`，玛纳结算正确累加 |
| F1012 bondTokenList 双板同步更新 | `character.ts:207` WHERE 加 `mana_board_index`，不再联动修改两个板 |
| F1013 1板角色虚假 board 2 行 | `insertDefaultPlayerCharacterSync` 按 `skill_count` 决定创建几条 |
| F1014 open_mana_board 缺等级检查 | 5★ Lv80 / 4★ Lv70 / 3★ Lv60 最低经验限制 |
| — DB 清理 | player 20 全部 243 行污染 status=1→0，161129 板 1 标记为可领取 |
| F1015 scoreRewardGroup null 不可遍历 | `assets.ts:105` + `quest.ts:36` null 守卫，练习战结算不再崩溃 |
| F1016 邮件 EQUIPMENT 已有装备 UNIQUE 冲突 | `mail.ts` 改用 `givePlayerEquipmentSync`，已有则加 stack |
| F1017 邮件 type_id 超 Int 范围 C8700 | `web_api/mail.ts` 加 1~2^31-1 校验，`formatMailResponse` null 安全 |
| F1018 episode_trial_reading/finish 404 | `cn-server.ts` 新增 stub 端点 |
| F1019 getQuestSync 统一 BattleQuest | 缺失字段默认 0，嘉年华关卡不再 400 |
| F1020 C3212 外传故事 clear_rank 缺失 | `storyQuest.ts` + `singleBattleQuest.ts` 三层修复：响应 `?? 5`、DB INSERT `?? 5`、DB 函数 `\|\|`→`??` |
| F1021 carnival score + party display | DB 表 + CDN 打分数据 + `single_battle_quest/finish` carnival_event 字段 |
| F1022 party_slot 3000 → F1009 | 外传「体验队伍」标识，战斗结束后未被清回；修复为 1 恢复进游戏 |
| F1023 getQuestSync 统一 BattleQuest 副作用 | 纯剧情关被客户端误判为战斗关，需 `clearRank: 5` 补充 |
| F1024 quest/unlock H404 | `questUnlock.ts` 新增 stub 端点 |
| F1025 事件商店购买限制 | `shop.ts` + `players_shop_purchases` 表：stock_quantity 真实库存 + /buy 校验上限 + 购买记录 |
| F1026 280 关 BOSS 掉落修复 | `boss_battle_quest.json` + `world_story_event_boss_battle_quest.json` 从 CDN col[70] 重新生成 scoreRewardGroup |
| F1027 DROP_MULTIPLIER 可配置 | `.env` 中 `DROP_MULTIPLIER=10`（测试状态），`quest.ts` 默认 1；影响 ITEM/MANA/EXP 普通掉落 |
| F1028 score_attack_event_quest 字段修复 | 转换脚本重写，rankTime/reward 字段正确提取，移除不存在的 scoreRewardGroup |
| F1029 event_item_shop 57 事件缺失 | 从 `orderedmap/shop/event_item_shop.json` 原始数据补全 3595 个商品 |
| F1030 BOSS 币稀有掉落修复 | 生成 55 个合成稀有组（offset=15），覆盖全部 17 个 BOSS 事件的银/金/紫币掉落 + 武器直掉 |
| ⚠️ 已知缺口 — rare_score_reward | probability/数量需 CDN 原始数据校验；id=0 条目暂不处理 |

## BOSS 币稀有掉落映射表

所有 BOSS 事件的银/金/紫币使用 `offset=15` 映射到稀有组：`rare_group_id = coin_id + 15`

| Event ID | 银币 → 稀有组 | 金币 → 稀有组 | 紫币 → 稀有组 | 武器 |
|------|------|------|------|------|
| 200062 | 10000010→10000025 | 10000011→10000026 | 10000012→10000027 | — |
| 200064 | 10000019→10000034 | 10000020→10000035 | 10000021→10000036 | — |
| 200065 | 10000025→10000040 | 10000026→10000041 | 10000027→10000042 | — |
| 200068 | 10000038→10000053 | 10000039→10000054 | 10000040→10000055 | — |
| 200070 | 10000043→10000058 | 10000044→10000059 | 10000045→10000060 | — |
| 200071 | 10000047→10000062 | 10000048→10000063 | — | — |
| 200072 | 10000057→10000072 | 10000058→10000073 | 10000059→10000074 | — |
| 200074 | 10000065→10000080 | 10000066→10000081 | 10000067→10000082 | — |
| 200075 | 10000042→10000057 | 10000046→10000061 | 10000051→10000066 | — |
| 200076 | 10000070→10000085 | 10000071→10000086 | — | — |
| **200077** | **10000076→10000091** | **10000077→10000092** | **10000078→10000093** | **5070044** |
| 200079 | 10000081→10000096 | 10000082→10000097 | 10000083→10000098 | — |
| **200080** | **10000087→10000102** | **10000088→10000103** | **10000089→10000104** | — |
| 200081 | 10000091→10000106 | 10000092→10000107 | 10000093→10000108 | — |
| 100005 | 10000004→10000019 | 10000005→10000020 | — | — |
| 100008 | 10000053→10000068 | 10000054→10000069 | — | — |
| 300002 | 10000007→10000022 | 10000008→10000023 | 10000009→10000024 | — |

**格式**：每个稀有组条目 = `{type:0, id:coin_id, count:1, rarity:1.0}`

**武器组**：稀有组 = 紫币稀有组 + 1，条目 = `{type:1, id:equip_id, count:1, rarity:0.05}`

**已验证**：Event 200077（机兵）和 Event 200080（前鬼后鬼）的映射与用户数据一致。

## C3212 修复详解

### 因果链

```
getQuestSync 统一 BattleQuest → 纯剧情关有了 rankPointReward 字段
→ 客户端判定为「战斗关」→ 查 clear_rank
→ 首次完成时 single_battle_quest/finish 响应发 null
→ 客户端缓存 null → 外传任务列表 C3212
```

### 三层修复

| 层 | 位置 | 操作 |
|------|------|------|
| 1 | `quest.ts:99` | `\|\| null` → `?? null`（0 不被 falsy 吞掉） |
| 2 | `singleBattleQuest.ts` `multiBattleQuest.ts` | DB INSERT `clearRank: clearRank ?? 5` |
| 3 | `singleBattleQuest.ts` `multiBattleQuest.ts` | 响应 `"clear_rank": clearRank ?? 5`（不发 null 给客户端） |
