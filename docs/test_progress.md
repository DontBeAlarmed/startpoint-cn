# 关卡/活动测试进度

每条需完成 **进入** 和 **结算** 两种流程测试。

## 测试清单

| # | 活动名称 | quest JSON | 关数 | 进入 | 结算 | 备注 |
|---|------|------|:---:|:---:|:---:|------|
| 1 | 嘉年华 | `carnival_event_quest` | 171 | ✅ | ✅ | 配队独立存储 EVENT；分数统计+通关队伍显示正常 |
| 2 | 战阵之宴（Rush） | `rush_event_quest` | 110 | ✅ | ⬜ | ⏸️ 涉及联机，延后测试 |
| 3 | Raid 活动 | `raid_event_quest` | 50 | ✅ | ⬜ | ⏸️ 联机多人，battle/start stub |
| 4 | 练习战 | `practice_quest` | 21 | 🔧 | 🔧 | 云水试炼进入+结算通过；余下 4 试炼待测（共 5 试炼，复用同一网络请求） |
| 5 | 分数挑战 | `score_attack_event_quest` | 123 | ⬜ | ⬜ | 含 BOSS 63 关；history/score_attack_event_battle 已实现 |
| 6 | 剧情活动 | `story_event_single_quest` | 348 | ⬜ | ⬜ | 需活动开放期 |
| 7 | 排名战 | `ranking_event_single_quest` | 7 | ✅ | ✅ | 测 2 个通过，走 single_battle_quest 通用流程 |
| 8 | 专家挑战 | `expert_single_event_quest` | 28 | ⬜ | ⬜ | 高难单人 |
| 9 | 主线关卡 | `main_quest` | 419 | ✅ | ✅ | 最常测试，稳定 |
| 10 | 高难关卡（EX） | `ex_quest` | 221 | ⬜ | ⬜ | |
| 11 | 角色剧情 | `character_quest` | 1,318 | ✅ | ✅ | story_quest/finish 通过；⚠️ 阅读后不记录已读状态（紫色标记不消除），待实现 episode_trial/save |
| 12 | 主线 BOSS 战 | `boss_battle_quest` | 232 | ⬜ | ⬜ | |
| 13 | 降临讨伐 | `advent_event_quest` | 459 | ⬜ | ⬜ | 需活动开放期 |
| 14 | 外传故事 | `world_story_event_quest` | 913 | ✅ | ✅ | 剧情关+ Boss 战均通过；C3212 clearRank null→0 修复 |
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
| F1020 C3212 story_quest clear_rank 缺失 | `storyQuest.ts:processStoryQuestFinish` 保存 `clearRank: 0` |
| F1021 carnival score + party display | DB 表 + CDN 打分数据 + `single_battle_quest/finish` carnival_event 字段 |
| F1022 party_slot 3000 → F1009 崩溃 | `party_slot` 无效值导致 HomeScene null pointer；修复为 1 |
