# 已知问题
> 状态: 持续更新   关键文件: -   相关端点: -

## C8601 / C2262 / 日期弹框 ✅ 已修复

**历史问题链：**
1. **C8601 key=10** — bundle stub 缺少 character key → 服务端改用 k_id=2（code=10）默认角色 + CDN 全量表加载 → 修复
2. **C2262 角色ID10未拥有** — 默认队伍引用 code=10 但角色不存在 → 默认队伍与角色一致 → 修复
3. **"日期变了"弹框循环** — `stubMsgpackReply` 硬编码 `Date.now()` 返回系统时间，与 `getServerTime()` 模拟时间不一致 → 改用 `getServerTime()` → 修复

**最终方案：**
- `servertime` = 模拟时间（所有端点统一）
- 弹框仅在时间变更时出现一次（正常行为）
- 之后不再弹框

## 标题画面 logo 缺失（8100）

**症状**: 首次启动（未下载 CDN）时标题画面报 `ERR:C8100|未找到素材 scene/title_bundled/logo/logo.movie.amf3.deflate`。

**根因**: 该文件仅存在于 CDN ZIP 中，不在 bundle 内。首次启动 `needsDownloadAsset()=false` 跳过 CDN 下载，直接进入标题画面 → 文件缺失。

**影响**: 提示性错误，非阻塞。下载 CDN 后消失。

## CDN 下载循环

**症状**: 下载完成后立即提示重新下载 / "不足的数据"。

**根因**: `version_info.files_list` CSV 包含版本 1.4.43~1.4.54 的 diff 文件路径，这些文件不在 1.4.0 基版 CDN 中。`AssetSufficiencyChecking` 下载 CSV 检测到缺失文件 → 写入 `assetRecoveryInfo` → `isAssetComplete()` = false → 触发 recovery 下载 → 独立文件也不存在 → 循环。

**修复**: `files_list` 指向 `empty.csv`（空文件，HTTP 200），sufficiency check 发现 0 个缺失文件 → `isAssetComplete()` = true → 不触发 recovery。

## character_level_up_effect 缺失

**症状**: 游戏加载动画阶段 `notify_asset_recovery 未找到素材 scene/general/animation/character_level_up_effect.frame.amf3.deflate`。

**根因**: `cn_cdn.rar` dump 版本止于 1.4.54，但游戏 APK（versionCode=1.8.1）引用更高版本的基料。该文件在 CDN dump 中不存在。

**当前状态**: 通过 `files_list: empty.csv` 跳过 sufficiency check → recovery 不再触发 → 游戏可继续加载。动画缺失不影响核心玩法。

## FileReader.as FFDec 导入限制

**FFDec 无法重新编译 FileReader.as**。修改后导入回 SWF 时被静默丢弃。Step 5b（SWF 重验证）可检测此问题并中止构建。涉及动 `notifyFileNotFoundError` 的补丁**必须走 DevConfig** 路径（如 `enableAssetSufficiencyCheck = false`），而非直接修改 FileReader。

## Tutorial 跳过 ✅ 已修复

**症状：** 每次登录弹出前置剧情 + 教程弹框

**根因：** `user_tutorial = { tutorial_step: 0 }` 告诉客户端教程未完成

**修复：** 默认存档设 `triggeredTutorial = [12]` → `serializePlayerData` 返回 `user_tutorial: null` → 客户端认为教程已完成

## 调试工具

### 错误捕获信标

APK 注入的 `CrashUtil.debugBeacon()` 将每个异常发送到 `/debug` 端点：

```bash
tail -f /tmp/cn-server*.log | grep BEACON
```

信标标签含义：
```
ERR:{code}|{msg}          — CrashUtil.handle() 截获所有异常（含 C8701-8707）
RD:servertime check        — ResponseData 中 servertime Float 校验通过
RD:viewer_id check         — ResponseData 中 viewer_id Float 校验通过
GL:loadedHandler START     — load 数据到达 GlobalLoading
GL:applyLoad START         — 进入资源加载决策
GL:startLoading START      — 开始加载资源
GL:notifyComplete START    — 加载完成
GL:completeHandler START   — 全局完成回调
RMB:init slices=N file=... — RootMasterBinary 解析 N 个 binary slice
RMB:getIntMap entries=N    — 解析出 N 个条目（CharacterTable 应为 505）
CLOCK:applyServerTime servertime=X     — 时钟收到服务端时间
CLOCK:checkNewDay old=X new=Y           — 新旧时间对比（不同日触发弹框）
CLOCK:checkClockState stateIdx=X avail=Y — 时钟状态检查
```

### 崩溃报告

游戏崩溃时自动 POST 到 `/crash` 端点，包含完整调用栈和设备信息。

### APK 构建

详见 [CDN 文档](../cdn/overview.md) 第六章。构建脚本位于 [starview](https://github.com/duosii/starview)(单独仓库,需自备)。

- `build-debug.sh` — 全量构建（含信标）
- `build-quick.sh` — 增量构建（复用 SWF 补丁）
- `build-release.sh` — 生产构建（无信标）

**⚠️ AIR SWF 缓存**：覆盖安装 APK 后必须**清除应用缓存**（设置 → 存储 → 清除缓存），SWF 修改才会生效。不清除会导致旧 SWF 继续运行，所有信标和配置修改均无效。

---

## 已知但未修复

| 问题 | 说明 | 优先级 |
|------|------|:--:|
| 🟡 **联动卡池图片缺失** | CDN dump 中部分联动活动资源被清理（如 gacha 1615 feature_content 图片） | 已知 |
| 漫画图片尺寸 | 针对 3200×1440 设备调优，其他分辨率可能不适配 | 已知 |
| 🟡 **邮箱状态获取和更新** | `mail_arrived` 计算方式、未读计数同步可能有问题 | 待修复 |
| 🟡 **抽卡后队伍空位自动填充** | 默认编队 `[1, null, null]` 在抽到新角色后被客户端自动补位 | 待调查 |
| 🟡 **存档导入** | 缺少模板和配置说明，`insertMergedPlayerDataSync` 可能缺少字段 | 待补全 |
| 🟡 **Web 时间设置控件** | 时间选择器交互问题，可能影响时间穿越 | 待修复 |
| 🟡 **存档独立时间 UI** | per-save 时间设置在 Player 页还没有 UI | 待做 |
| 🟡 **教程跳过 Web UI** | dashboard 移到 `toggle triggeredTutorial` 而非 `tutorialSkipFlag` | 待做 |
| 🟡 **账号切换/存档系统** | 整体待重构，当前 `check_enable_gift` 仅用于礼包码入口 | 待重构 |
| 🟡 **礼包码兑换** | `enable_gift: true` 按钮亮起但兑换逻辑未实现 | 待做 |
| 🟡 **通行证完整实现** | PassCard 仅 MVP stub，后续需加载 master data + 发放奖励 | 待做 |
| `versionCheck.ts` 返回官服地址 | 被 `sdkDummy=true` 跳过，实际不影响 | 低 |
| `/tool/custom_notify` 返回空 `{}` | 可能触发客户端特殊逻辑 | 低 |
| SHA256 字段为空 | CDN 文件无完整性校验（不影响） | 低 |
| 不支持多语言/多平台 | 仅 CN Android | — |
| `character_level_up_effect` 不在 CDN | CDN dump 不完整 | 中 |
| 漫画详情图 F3766 | PNG 格式 + GPU 纹理 ≤2048px 限制 | ✅ |
| 漫画列表 C2035/C8704 | 倒序排列 + 字段名对齐客户端 | ✅ |
| 漫画翻页 C2035 | 页码 0-based (`page_index ?? 0`) | ✅ |
| ⚠️ 邮件领取道具未更新 `givePlayerItemSync` | `/mail/receive` 中 item.reload 调用可能不对 | 待验证 |

## 已修复

| 问题 | 修复方式 | 
|------|---------|
| 教程内联 stub | 注册 `tutorialApiPlugin`，完整的 step 15/16 + finish_trigger |
| 教程 C2262 (角色未拥有) | step=16 改为 `givePlayerCharacterSync` 直接给 243001 |
| 公告 404 + C8700/C8704/C7606 | 从 CN 客户端反编译确认精确格式，6 个端点齐全 |
| 邮件 404 | `mail/index`、`receive`、`receive_all` 全部实现，含 13 种附件类型 |
| 邮件 `mail_arrived` 硬编码 false | 改为动态检测未读邮件 |
| 修行之道 H404 + C8704 | `Pass_card/get_pass_card` 修正响应格式 + 新增 `receive_all` |
| 切换账户 H404 | `check_enable_gift` 加 stub |
| `tutorialApiPlugin` 已导入未注册 | 注册插件，移除内联存根 |
| 角色 ★5 概率 7.5%→5% | `characterGachaRankRates` 修正 |
| ★4 UP 概率爆炸 6.78% | per-tier 独立计算 odds |
| 装备 rarity 溢出 30/68 件抽不到 | `cn_eq_pool` 规范化 |
| 卡池模板混入限定 | 改用 `character_table.json` 常驻池 |
| 日期弹框循环 | `stubMsgpackReply` 用 `getServerTime()` |
| codeMap 转换存废 | 已改 identity 函数 |
| 月卡 404 | stub 已加 |

## 新增功能

| 功能 | 端点 | 状态 |
|------|------|:--:|
| Web 发邮件 | `/mail` (Web) + `POST /api/mail/send` | ✅ |
| Web 新建存档 | `POST /api/server/newAccount` | ✅ |
| 公告管理 | `assets/news.json` 编辑即生效 | ✅ |
| 邮件领取通知 | `/load` 动态计算 `mail_arrived` | ✅ |
| 个人资料 | `profile/*` 6 个端点（资料/称号/改名/留言） | ✅ |
| 领取记录 | `history/receive` 近 7 天 500 条，全自动追踪 | ✅ |
| 漫画 | 422 张图片自动裁剪缩放，3 尺寸输出 | ✅ |
| ~~角色 ★5 概率 7.5%~~ | `characterGachaRankRates` 错误，改为 5.0%（与官方一致） | ✅ 已修复 |
| ~~★4 UP 概率爆炸~~ | ★4 UP 共用 ★5 池的 odds 值，混合卡池 per-tier 独立计算 | ✅ 已修复 |
| ~~装备池 rarity 溢出~~ | `cn_eq_pool` 硬编码 rarity 总和>1000，30/68 件抽不到 | ✅ 已修复 |
| 道具入场扣减 | `single_battle_quest/start` 扣减 entry item（示宝金钥匙等） | ✅ |
| 每日挑战次数系统 | 282 CDN 条目自动初始化 + 每日重置 + Web 恢复按钮 | ✅ |
| 装备强化商店 | shop_type=10 追忆装备强化，191 件商品 + 分类过滤 + 购买升级 | ✅ |

## 时间偏移持久化 ✅ 已实现

**问题：** 每次服务重启后 `serverTime` 归 null（系统时间），需重新设置。

**方案：** 改为偏移量（毫秒）方式，持久化到 `active_account.json`：
- 设置时间 → 计算 `offset = targetTime - Date.now()` → 保存
- 重启 → 读 offset → `setServerTimeOffset(offset)` → 自动恢复
- `getServerTime()` = `Date.now() + offset`（每次调用实时计算，时间自然流逝）

**`getServerTime` 双模式：** 无参返回模拟时间，有参（传 Date）返回该 Date 自身 epoch（用于序列化存档时间戳）。

### 安全时间范围

| 数据源 | 最早 | 最晚 |
|--------|:----:|:----:|
| CDN (v1.4.0) | ≈2022-03 | ≈2024-12 |
| 卡池 gacha.json | 2020-01 | 2025-08 |
| **推荐区间** | **2022-06** | **2025-08** |

早于 2022 会因 CDN 版本不匹配进不去游戏。详见 [CHANGELOG.md §7](./CHANGELOG.md)。

## 每日挑战次数系统 ✅

### 数据来源

从 `wf-assets-cn/orderedmap/quest/event/daily_challenge_point.json` 提取，共 **282 条目**。预处理为 `assets/daily_challenge_point_lookup.json`：

```json
{
  "1": {"maxPoint": 9999, "isRecovery": true, "name": "单人挑战讨伐战斗挑战次数"},
  "251": {"maxPoint": 999, "isRecovery": true, "name": "追忆试炼挑战次数"},
  "5001": {"maxPoint": 9999, "isRecovery": true, "name": "极时试炼挑战次数\n对象关卡：极时试炼"},
  ...
}
```

### 关键条目

| ID | 名称 | CDN max_point | 说明 |
|----|------|:-----------:|------|
| 1 | 单人挑战讨伐战斗 | 9999 | ExpertSingleEvent 所有关卡 + 28 故事活动 expert 关 |
| 2-7,251 | 指定单人挑战 | 1/999 | 画龙、前鬼后鬼、追忆试炼等 |
| 8-417 | 纪念关卡 | 1 | 开服N天/周年/新年/情人节等 |
| 5001 | 极时试炼 | 9999 | SoloTimeAttackEvent |

### 初始化

- **新账号**：注册时 `insertDefaultPlayerSync` → `getDailyChallengePointDefaults()` 建全部 282 条目，`point = CDN max_point`
- **已有账号**：`/load` 触发 `dailyResetPlayerDataSync` → 空条目时自动补建

### 每日重置

`dailyResetPlayerDataSync`（`/load` 时调用）:
1. 检查 `daily_challenge_point_list_entries` 是否为空 → 空则补建全部 282 条目
2. 非空则遍历重置 `point = CDN max_point + campaign bonus`
3. 检测 CDN 新增条目 → 自动补建

**重置时机**：每次 `/load`，当 `loginDate`（默认 `new Date()` = 真实系统时间）跨日时触发。

### Web 恢复按钮

Player 页面 `/player/:id` → 「恢复挑战次数」按钮：
- 空条目 → 从 CDN 补建全部 282 条目
- 已有条目 → 重置 `point` 到 CDN `max_point`
- API: `POST /api/player/:id/reset_challenge`

### TODO：时间系统完善后

- [ ] 对 `max_point >= 999`（无限次）的条目加时间窗口限制。虚拟时间 < 2025-06-26 时用有限值（单人3次、追忆2次、极时2次），>= 后用 CDN 原值
- [ ] `dailyReset` 改用 `getServerDate()`（虚拟时间）而非 `new Date()`（真实时间），与时间旅行系统统一
- [ ] CDN 条目按 `isRecovery` 区分每日恢复 vs 一次性条目，后者不应每日重置

## 技能演武（SCORE_ATTACK_EVENT / 无限演武）🟡

### 已完成

| 功能 | 实现方式 |
|------|---------|
| 关卡数据转换 | `convert_score_attack_event_quest` 输出 `eventId`/`folderId`/`scoreRewardGroupId`/`sPlusRewardId` |
| 分数奖励档位 | `convert_score_attack_border_reward` 从 `score_attack_border_reward.json`（11100 条）生成 123 组 `{event_folder: [{score, rewardItemId, coinItemId, coinCount}]}` |
| 道具发放 | `/finish` 中查 border 表 → 按 `body.score` 匹配最高档位 → `givePlayerItemSync` 发放 reward item + coin item |
| 完成判定 | `is_accomplished` 对比 border reward 最低档位分数，达标才算完成 |
| 详细日志 | `[SCORE_ATTACK]` 标签打印请求 body、questData、borderReward 匹配结果、响应字段 |

### 已知未解决：奖励弹窗

**症状**：道具正常发放（`items={"16001":1,"40501":1}`），但客户端不播放结算动画/奖励弹窗，退出战斗直接结束。

**根因分析**：

1. CN 客户端（APK 1.8.1）中 `SingleQuestIdKind` 枚举最大 index=18（SoloTimeAttackEvent）。`SCORE_ATTACK_EVENT (category=27)` 在 CN 客户端中没有对应的 QuestLogic 类。

2. 尝试复用 `solo_time_attack_event` 响应字段 → 客户端处理代码 `SingleOrMultiBattleQuestFinishProcess.execute()` 第 276 行执行 `_loc21_.soloTimeAttackEvent.eventId`，其中 `_loc21_` 是 QuestLogic。因 score_attack 的 QuestLogic 不是 `SoloTimeAttackEventQuestLogic`，`soloTimeAttackEvent` 属性不存在 → TypeError #1034 (F1034)。

3. 尝试 `drop_score_reward_ids` → 客户端查本地 CDN binary 的 group_id=4 → C8601（key 不存在）。

4. EN 全局版有完整的 `ScoreAttackEventQuestLogic`/`ScoreAttackEventScoreCardLogic`/`BattleQuestFinishResponseScoreAttackEvent` 等类，但 CN 客户端 v2.1.125 反编译源码中**完全没有**这些类——仅有战斗内视觉效果资源（`battle/common/score_attack/`）。

### 后续研究方向

- [ ] 分析 APK 1.8.1 二进制中是否有 ScoreAttackEvent 相关类（反编译缺失但实际 APK 可能有）
- [ ] 确认 CN 客户端的 `QuestIdGroupKindTools.fromCategoryAndId()` 是否在二进制中支持 category 27
- [ ] 如客户端确实有 ScoreAttackEvent 支持，需确定 `data.score_attack_event` 响应字段的精确格式（参考 EN 全局版的 `BattleQuestFinishResponseScoreAttackEvent`）
- [ ] 如客户端无专门支持，考虑在 `/start` 端点将 category 映射为 SoloTimeAttackEvent(25) 并用 `solo_time_attack_event` 字段（需确认不会破坏关卡场景加载）

### 关键文件

| 文件 | 说明 |
|------|------|
| `assets/score_attack_border_reward.json` | 123 组 (event_folder) 分数档位数据 |
| `scripts/converter.py` | `convert_score_attack_border_reward` / `convert_score_attack_event_quest` |
| `src/routes/api/singleBattleQuest.ts` | `/finish` 中 `SCORE_ATTACK_EVENT` 分支（行 ~245-285） |
| `wf-2.1.125-cn-decompiled/.../SingleOrMultiBattleQuestFinishProcess.as` | 客户端结算处理，`solo_time_attack_event` 分支（行 239-305） |
| `wf-2.1.125-cn-decompiled/.../BattleQuestFinishRealRemote.as` | 客户端响应解析，`solo_time_attack_event` 字段（行 2224-2341） |
| `wf-assets-cn/orderedmap/quest/event/score_attack_border_reward.json` | CDN 原始档位数据（11100 条） |
| `wf-assets-cn/orderedmap/quest/event/score_attack_event_quest.json` | CDN 关卡数据 |

### 已知未解决：border reward item 16001 C8601

`score_attack_border_reward.json` 中所有档位的 `rewardItemId` 均为 **16001**，但该 ID **不存在于 CDN item 表**（`wf-assets-cn/orderedmap/item/item.json` 中无此条目）。

- **影响**：`/finish` 通过 `givePlayerItemSync(playerId, 16001, 1)` 写入玩家道具栏 → `/load` 时客户端查本地 CDN binary → `C8601 (key=16001 不存在)`
- **不受影响**：`coinItemId`（40501 无限金币、40502 无限紫币、49100 普莉莉艾勋章）均存在于 CDN
- **临时处理**：手动删除 `players_items` 表中 `id=16001` 的行
- **后续修复**：在 `/finish` 的 borderReward 分支中跳过 `rewardItemId` 发放，仅发放 `coinItemId`

## 战阵之宴（RAID_EVENT / 编队系统）✅

### 问题链

| # | 症状 | 根因 | 修复 |
|---|------|------|------|
| 1 | 无法进入战阵之宴 | `/event/raid/summary` 为 stub，缺 `raid_boss`/`auto_start_point` 等必填字段 | 补齐 5 个必填 raid 字段 |
| 2 | 按钮灰色，提示"队伍内存在已使用的角色" | `/event/raid/party` stub 返回 60 个 NORMAL party，同一角色跨多个 party 重复 | 改为返回 1 group × 3 party |
| 3 | 编辑配队后重进不持久 | `/party/edit` 客户端发 `category=3`（EMPTY3），DB 存 `category=1`（NORMAL），update 找不到行 | `category: 3 → 1` 映射 |
| 4 | 重新进入报错 | 缺少 `getServerDate` import → H500 | 补 import |
| 5 | 战斗结束 H400 | `/event/raid/battle/start` stub 未写 `activeQuests` | 写入 `activeQuests` + 推算 eventId |
| 6 | `/finish` 500 UNIQUE | 重复挑战同一关 played party 冲突 | `INSERT OR REPLACE` |
| 7 | 通关后无 rank/exp/mana 奖励 | `raid_event_quest.json` 奖励字段全为 0 | converter 修复 [82-98] 字段 |
| 8 | 分数掉落在战阵之宴用独立系统 | `scoreRewardGroupId` 不存在，需事件级奖励系统 | 待后续 |

### 关键修复文件

| 文件 | 变更 |
|------|------|
| `src/routes/api/raidEvent.ts` | `/summary`、`/party`、`/battle/start`、`/select_folder`、`/reset` 全部重写 |
| `src/routes/api/party.ts` | `/party/edit` 加 `category: 3→1` 映射 |
| `src/routes/api/singleBattleQuest.ts` | RAID_EVENT played party 记录 + eventId 支持 |
| `src/data/domains/rushEvent.ts` | `INSERT OR REPLACE` 防重复 |
| `scripts/converter.py` | `convert_raid_event_quest` 从 CDN 提取完整奖励字段 |
| `assets/raid_event_quest.json` | 50 关全部恢复 battle 数据 |

### 当前配队流程

```
进战阵之宴 → /event/raid/party 读 NORMAL party → 显示
编辑配队 → 内存修改（不发请求）
退出编队组编辑 → /party/edit {category:3→1} → 存 NORMAL
重进 → /event/raid/party → 读 NORMAL → 编辑持久 ✅
打关 → /finish → played party 记录 ✅
```
---

## 关卡高分显示截顶（>2,147,483,647） ✅ 已修复

**历史根因**: MsgPack `uint32(0xCE)→int32(0xD2)` 全局字节替换误伤数据字节，导致值变化甚至溢出。

**修复**: 实现 MsgPack 结构感知 walker（`cn-server.ts:fixUint32Tags`），单次遍历 buffer：
- 值 < 2^31 → int32 (0xD2)，数据字节原样
- 值 ≥ 2^31 → float64 (0xCB)，8 字节 IEEE 754，精度至 2^53 无损
- 数据字节永不被误替换

**影响**: 已彻底解决，分数上限由 game config 的 `max_score=99999999999` 决定，完整传输。

---

## 早期日服卡池特辑图片缺失（C2032） 📋 已知局限

**症状**: 调整服务器时间到 2021-2022 年早期，进入抽卡界面时 `C2032: 与扭蛋ID:63相匹配的特辑图片不存在`。

**根因**: CN CDN 最终版本 1.4.54 中，41 个早期卡池（2020-2022 年，ID 44-81 区间）的 `gacha_feature_content` 表条目缺失。该数据在更高 CDN 版本的 GL 中存在，但 CN CDN 从未包含。CN 官服真机同样会触发此问题。

**影响范围**:
- 仅在手动调整时间为 2021-2022 年早期时触发
- 现代时间（CN 运营中期以后）不受影响
- 共 41 个卡池：ID 44, 61-69, 72-86, 5008-5015

**技术约束**: CDN 数据为官服最终版（1.4.54），不可修改。客户端卡池列表完全从本地 CDN 加载，服务端无切入点干预。

**修复方向**: 不支持修复。标记为 CDN 版本固有限制。

## 活动加成掉落缺失 📋 待办

**症状**: 部分 `score_reward` 组（如 group 12856）中存在位置间隙（3, 4, 7），预期由活动 campaign 系统在运行时填充，当前未实现。

**影响**: 活跃活动期间副本掉落比官服少 2 个加成位。

**待办**: 后续实现 campaign 掉落加成逻辑。

## EX Boost 词条概率 ✅ 已修复

**症状**: 概率硬编码粗糙（3 层比例 70/20/10），不分 A/B 组，金率不精确。

**修复**: 从 orderedmap `ex_ability.json` 读取 63 个能力名称，按 A/B 组 + 三级稀有度 (`_r3/_r4/_r5`) 构建 6 个池。独立双抽使用官服精确金率表（6 种材料 × A/B 金率），5★ 不出棕，4★ 优先银。

## EX Boost 等级检查 ✅ 已修复

**症状**: 服务端要求 Lv100，客户端只要求满突破 → 满突破未满级时 H400。

**修复**: 对齐客户端 `isMaxOverLimitStep()`，删除经验值检查。

## 关卡体力消耗表 ✅ 已修复

**症状**: `quest_entry_costs.json` 手工维护，仅 410 条目覆盖 8 类别。

**修复**: 从 orderedmap quest 数据自动生成 3,021 条目覆盖 17 类别。

## 存档复制 Party 数据一致性 ✅ 已修复

**症状**: clone 后编队界面 C2337（PartyId 找不到），C8601（color_id=0 无效）。

**根因**: `deserializePlayerData` 未将 globalPartyId 转回 group-local slot；party group 自动创建时 color_id 硬编码为 0。

**修复**: 
- `utils.ts:713` — 反序列化时 `slot = (globalPartyId - 1) % 10 + 1`
- `party.ts:127` — color_id 默认值 `0` → `15`

## 副本通关装备不立即显示 ✅ 已修复

**症状**: 首次通关奖励装备保存到 DB 但响应中缺失，重登后才显示。

**根因**: `equipment_list` 仅含评分奖励装备，通关/S+通关/狂热奖励装备未合并。

**修复**: `singleBattleQuest.ts:558`, `multiBattleQuest.ts:829` — 合并所有来源。

---

**最后更新：2026-06-23**

## 参考文档

| 文件 | 说明 |
|------|------|
| `docs/generated/gacha_timeline.csv` | 581 条卡池时间线（含 UP 角色） |
| `docs/generated/character_table.csv` | 505 条角色对照表（元素已修正） |
| `docs/generated/quest_timeline.csv` | 17,014 条副本活动期 |

生成脚本：`scripts/gen_gacha_timeline.js`, `scripts/gen_character_table.js`, `scripts/gen_quest_timeline.js`

（详细变更见 [CHANGELOG.md](./CHANGELOG.md)）
