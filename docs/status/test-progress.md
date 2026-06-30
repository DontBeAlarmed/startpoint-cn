# 关卡/活动测试进度
> 状态: 测试进度   关键文件: src/routes/cn/...   相关端点: /single_battle_quest/*

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
| 13 | 降临讨伐 | `advent_event_quest` | 459 | ✅ | ✅ | 暗机兵 Boss 币掉落正常到账；361/459 关有掉落组 |
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
| C3032 抽卡动画种子不匹配 | ✅ 种子验证器自动过滤（`gacha-physics.ts` + `seed-validator.ts`） |
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
| F1022 party_slot 3000 → F1009 | ✅ `lib/validate/party-slot.ts` — PartySlotValidator：/load 时 partySlot < 1 或 > 120 自动重置为 1；12 组 × 10 槽正常范围 1~120 |
| F1023 getQuestSync 统一 BattleQuest 副作用 | 纯剧情关被客户端误判为战斗关，需 `clearRank: 5` 补充 |
| F1024 quest/unlock H404 | `questUnlock.ts` 新增 stub 端点 |
| F1025 事件商店购买限制 | `shop.ts` + `players_shop_purchases` 表：stock_quantity 真实库存 + /buy 校验上限 + 购买记录 |
| F1026 280 关 BOSS 掉落修复 | `boss_battle_quest.json` + `world_story_event_boss_battle_quest.json` 从 CDN col[70] 重新生成 scoreRewardGroup |
| F1027 DROP_MULTIPLIER 可配置 | `.env` 中 `DROP_MULTIPLIER=10`（测试状态），`quest.ts` 默认 1；影响 ITEM/MANA/EXP 普通掉落 |
| F1028 score_attack_event_quest 字段修复 | 转换脚本重写，rankTime/reward 字段正确提取，移除不存在的 scoreRewardGroup |
| F1029 event_item_shop 57 事件缺失 | 从 `orderedmap/shop/event_item_shop.json` 原始数据补全 3595 个商品 |
| F1031 advent_event_quest 掉落修复 | 转换脚本 `col[70]`→`col[76]` + 再生 JSON |
| F1032 CDN 数据再生 + C8601 根除 | `score_reward.json` + `rare_score_reward.json` 从 CDN 全量重新生成：修复 array wrapper bug，type=0/1 正确分类，罕见组 ID 对齐客户端表 |
| 📊 掉落表 | `docs/quest_drop_table.json` — 1573 关 × 10335 条掉落，含物品名/数量/稀有度 |
| F1033 gacha_campaign 修复 | CN CDN 重新生成 145 条映射（旧版全球数据仅 50 条） |
| F1034 gacha.json CDN odds 重建 | 从 926 个 CDN `gacha_odds/` 有序映射文件完整重建 490 卡池：CDN 权重 + `odds_up` UP 标记 + `is_limited`/`is_exchangeable` |
| F1035 C8024/C3032 卡池动画修复 | `gacha.ts`：`movie_id` 从硬编码→读取 `gacha.movieName`；`seed` 从 `characterId*1000`→预验证种子池随机选取 |
| F1036 装备卡池 CDN 赔率重建 | 91 个装备卡池（type=1）从 CDN `equipment_odds_rarity` 赔率文件构建，含权重/UP/限定 |
| F1037 seed-validator 四态验证 | `seed-validator.ts`：UNKNOWN→PENDING(1x/2x)→VERIFIED/BLOCKED，3 次无 crash 标记安全，C3032 自动 block |
| F1038 gacha-physics 物理引擎 | `gacha-physics.ts`：MT19937 + FallingField + FixedFallingField + CCD 护符检测，CN CDN 种子池生成 |
| F1039 CN 种子池重建 | 从 CN CDN `archive-common-full` 提取 4 个 gacha 物理配置 AMF3，200K seed 扫描生成 `gacha_movie_seeds.json` |
| F1040 种子管理面板 | `/seeds` Web 页面：四态统计 + 进度条 + blocked 列表 + 解除操作 |
| F1041 evolution 修复 | `learn_mana_node` 进化仅在板 1 全部节点学完后触发（对齐 `isAbilitiesEvolution()`） |
| F1042 PURIFIED 惊险种子净化 | C3032 自动捕获 device★ 数据 → `autoPurify()` 移入 PURIFIED 惊险池，0 blocked 残留 |
| F1043 双池模式 + 测试优先级 | 测试池/净化池一键切换，UNKNOWN 可选 ★3/★4/★5 优先测试 |
| F1044 Web nav 统一 | 5 页中文侧边栏：首页/玩家/发送邮件/种子，移除 Source Code |
| F1045 惊险池 Tag + 测试种子 | Tag 四态（未测试/热血/普通/冷血），测试种子每稀有度1个+10min超时，三栏横向 Web UI |
| F1046 净化池跨稀有度修复 | 删除 step③ 无稀有度过滤复用，purified 种子前置到 basePool，getSeed() 只选同稀有度 |
| F1047 forceAnimation 移除 | playProbability 由客户端 RNG 决定不可服务端控制，删除 filterPlayable/getPlayProbability/Web toggle |
| F1048 MersenneTwister int32 修复 | `Math.imul` + `|0` 替代 `>>>0`，匹配 AS3 有符号 int32 溢出行为，精度从 0%→31.9% |
| F1049 AMF3 解码器修复 | 空字符串不写入 string table，class name 用 `rbytes`，`getPurifiedForRarity` 跨池注入 |
| F1050 种子池完全重置 | 清空 purified/verified/pending/blocked，干净状态从头测试 |
| F1051 MoviePool 重构 | 每 movie_id 独立 MoviePool(purified/verified/pending)，testSeeds 全局跨 movie 生效，三卡池隔离 |
| F1052 种子选取优先级 | testSeed(全局) > purified(同稀有度) > testPool(UNKNOWN/PENDING/VERIFIED)，删除跨稀有度兜底 |
| F1053 gacha.ts movieId 修复 | `movieId` 计算提到 `loadMovieSeeds` 之前，GUARANTEE 抽卡正确加载对应池 |
| F1054 多卡池种子池 | 5 个 movie_id 各独立过滤池 + CDN 阈值提取（normal/fes/fes_guarantee/normal_guarantee/rarity_5_guarantee） |
| F1055 CDN URL 动态检测 | CDN 下载地址从请求 `Host` 头自动获取，不再硬编码 IP，多设备/多网段兼容 |
| F1056 C3032 跳过补丁 | `starview/04e-skip-c3032.sh` + APK 构建，`CrashUtil.debugBeacon` 替代 throw |
| F1057 /debug GET C3032 解析 | `GET /debug` beacon 解析 C3032 → `/â(\d)/g` 从乱码提取 ball★+char★ → blockSeed → autoPurify 正确稀有度 |
| F1058 autoPurify 无条件 | 删除 `if (ball)` 门控，blocked 种子始终净化，无 deviceData 默认 ★3 |
| ✅ 种子池 | MoviePool 独立管理，testSeeds 全局不区分 movie，purified 按卡池隔离 |
| ⚠️ CDN 目录要求 | `.cdn/cn/archive-*/*.zip` 必须存在完整 CN CDN ZIP 包，服务端从 `patch/cn/` 前缀提供静态文件 |
| ⚠️ Beacon 日语乱码 | ⚠️→✅ `CrashUtil.debugBeacon` ★→â，用 `/â(\d)/g` regex 从 garbled 字符提取数字 |
| F1059 gacha-physics 完善 | MathCompat cos/sin 移植 + 配置深度合并 + moviePlayable=false 跳帧 + AMF3 阈值提取 |
| ✅ gacha-physics 精度 | rarity ~85%, playMovie ~5%（不可预测，靠 PLAY beacon） |
| F1064 种子池简化 | 删除 pending/verified/blocked，三池: unknown→confirmed/play→purified |
| F1065 purified_r3=0 | ★3+play=1 物理上极难（fes 护符全覆盖，球必升级）。非 bug，confirmed_play 补充 |
| F1066 PLAY beacon 接入 | parsePlayBeacon 在 /debug handler 中运行，confirmed_play 积累 play=1 ground truth |
| F1067 gacha 抽卡去重 | drawGachaSync 返回 number[]（flat array，按原始随机顺序），不再 group 同一角色 |
| F1068 种子池扩容 | fes 400K, normal 400K, guarantee 各 100K。总计 1,000,000 种子 |
| F1069 RARE_POOL item_list 双倍累加 | `lib/quest.ts`：ITEM 和 RARE_POOL 路径的 `givePlayerItemSync` 返回值均为 DB 总计，merge 时误将两个总计相加导致 item_list 膨胀。修复为直接用最新 DB 总计覆盖 |
| F1069 三模式 | natural(默认, 10%播放率) / play(100%播放) / test(全unknown)。模式不持久化 |
| F1070 pendingPlay 池 | 无 patch APK 测试缓存：/crash(r已知)+markSent(r=null)。换 patch 后重测得 play 状态 |
| F1071 净化池 5 列 | ★3 / ★4 / ★4保底 / ★5 / ★5保底——按 movie 来源 (_guarantee 后缀) 分列 |
| F1072 自然模式优先级 | playPool(10%) > confirmPool > testPool。优先保证零 C3032 |
| F1074 drawIndex=0 对齐 | 第 1 抽强制 playPool（客户端 drawIndex=0 永远播动画）。normal_guarantee ~7% 未对齐 |
| F1075 sentSeeds 隔离 | markSent → sentSeeds（不立即确认），clearSent 在 10 连结束后批量确认，避免同 10 连内交叉复用 |
| F1076 addPending → confirm | /crash 种子修正后立即进入确认池，不再堆积 pendingPool |
| F1077 pendingPool 清理 | 移除 addPending 中冗余的 pendingPool.set，/crash 直接 confirm，pending 不再残留 |
| F1078 getSeed 重构 | 提取 pickPlay/confirmR/playHas/pendR/isUnknown helpers，_guarantee 回退统一，68→40 行 |
| ⚠️ R1 连接问题 | 服务端 0.0.0.0 绑定正常，有时 R1。删除存档重建可恢复。未解决 |
| F1060 RNG tempering 修复 | `randomUInt()` tempering 从 post-twist 值改为 pre-twist 值（匹配 AS3），精度 17% → 85% |
| F1061 threshold.amulets 越界 | `?? 0` → `!== undefined`（匹配 AS3 Number(undefined)=NaN），fes_guarantee 37% → 90% |
| F1062 play= beacon 字段 | APK patch: C3032 beacon 加入 `play=1|0`（client moviePlayable），服务端解析存储 |
| F1063 种子池重建 | 清空全部池子，5 movie × 100K 种子重新生成（无 playMovie 过滤），500K 种子总池 |
| F1064 种子池简化 | 删除 pending/verified/blocked，引入 confirmed（1 次无 C3032）。purified 仅接受 play=1。三池: unknown→confirmed→purified |

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

## C2274 详解

### 错误信息

```
ClientError 2274: ID: 141010のキャラクターの entry_count が存在しません
```

### 触发条件（客户端 `PlayerLogic.as:3043`）

| 条件 | 说明 |
|------|------|
| 响应 `character_list` 包含某角色 | `_loc4_ = int(_loc3_.character_id)` |
| 客户端 `hasCharacter()` 返回 `false` | 玩家尚未拥有 |
| `entry_count` 字段为 `Option.None` | 缺失，对**新角色**是必填项 |

### 原因

1. **`2b2bdb9`** 已修复 10 连相同角色重复导致 C2274 的 bug（同 ID 合并逻辑）
2. 这次 C2274 的 `character_id=141010` **不在任何数据源中**（CN/EN character.json、gacha.json、DB 均无）
3. 堆栈含 `Reproduce/executeEvent()`——是**客户端 replay 日志重放**触发，不是服务端实时响应
4. `entry_count` 对**已有角色**不是必填（`hasCharacter=true` 时跳过检查），仅**新角色**触发

### 未修复

标记为 ⚠️ 已知不修复。根因在客户端 replay 日志数据损坏（旧 session 残留在设备存储中），服务端无法处理。重装 APK 可清除。

临时防御：在所有返回 `character_list` 的服务器端点确保每条记录都含 `entry_count`，但当前未实施（不影响核心流程）。

