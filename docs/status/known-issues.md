# 已知问题
> 状态: 持续更新   关键文件: -   相关端点: -

## 活动扭蛋最终箱无法重置 ✅ 已修复并通过客户端验收 (2026-07-19)

**症状**：活动 28 的箱 5 抽完 2732 个胶囊后，客户端点击“库存重置”请求 `POST /api/index.php/box_gacha/reset`，服务端因路由不存在返回 H404。

**修复**：从国服箱规则资产读取 `requiredBoxId`、`resetKind`、`resetLimit` 和 JST 开放期；使用账号当前存档解析玩家数据，开放期统一按全局服务器时间校验；在单个 SQLite 同步事务内恢复库存、增加重置次数、重新开放箱子并精确删除该玩家该箱的已抽记录。重置不扣活动道具、不回收奖励，也不影响其他箱。期间错误返回业务码 `4608`，立即重复重置会失败且不留下部分状态。

**客户端验收**：活动 28 箱 5 点击重置后不再返回 H404，页面保持当前箱，库存恢复为 2732，重置次数增加为 1；库存非空时再次请求会被拒绝，重新 load 后库存和重置次数保持。当前未发现其他最终箱重置问题。

详见 [箱式扭蛋](../systems/box-gacha.md)。

## 土俑奖励动画 C8601 key=0 ✅ 已修复并通过客户端验收 (2026-07-17)

**症状**：土俑挑战结算及累计奖励发放成功，返回活动页面准备播放奖励动画时报 `C8601`，内部信息为“指定的 Key 不存在，key=0”。

**根因**：真实结算请求的队伍结构没有独立 `party.leader` 字段，服务端因此返回 `leader_character_id=0`。客户端在 `CarnivalEventHighScoreDialog` 中用该 ID 创建像素角色并加载角色 0 的资源，触发 C8601；奖励行与 CDN 文件本身没有缺失。

**修复**：领队 ID 优先读取 `party.leader.id`，缺失时使用 `party.characters[0].id`。回归测试覆盖真实请求结构，确保首位角色 101 不再被序列化为 0。

**客户端验收**：彻底重启客户端以清除修复前遗留在内存中的 `leader_character_id=0` 后，土俑结算正常显示最高分弹窗，未再出现 C8601。活动 `250601` 的累计最佳分 `5,490,701` 对应 24 档累计分奖励，服务端领取记录与主数据逐条一致。

## 歼灭者讨伐战最高难度不解锁 ✅ 已修复并通过房主流程验收 (2026-07-18)

**症状**：完成歼灭者活动前置后，最高难度 `200076009` 仍不显示；重新 load 后更容易复现。

**根因**：客户端要求 `200076002/005/006` 三关都具有房主通关状态。最初服务端多人结算固定返回 `host_finished=true`，却没有把该字段保存到 quest progress，load 响应也不包含它。补齐持久化后又暴露出多存档账号的身份漂移：房间创建与 TCP 握手取账号玩家列表首项，战斗 start/finish 取当前默认存档；默认存档不是首项时，房间房主 ID 与结算玩家 ID 不一致，真实房主会被判成成员并写入 `host_finished=0`。

**修复**：为 quest progress 增加可选 `host_finished`；多人结算只按服务端房间房主判断，不信任客户端身份上报；状态只允许从 false 提升为 true，并在结算与 load 中返回。联机房间创建、TCP 握手、战斗 start/finish 统一通过 session 和账号默认存档解析玩家身份，不再从玩家列表首项取身份。旧表首次加列时，Advent 已完成记录按旧响应语义一次性补为房主通关，之后不重复回填。

**客户端验收**：三关房主通关、最高难度即时解锁和重新 load 后保持均已通过。成员不解锁路径因暂无双客户端测试条件而降为低优先级客户端回归；服务端测试已确认成员结算不会写入房主完成状态。

详见 [歼灭者讨伐战最高难度解锁](../systems/boss-epuration-unlock.md)。

## 歼灭者最高难度门票不扣 ✅ 已修复，待客户端验收 (2026-07-19)

**症状**：最高难度 `200076009` 可以正常开始和结算，但歼灭心核 `10000072` 的背包数量不减少。

**根因**：入口消耗生成器没有配置 Advent 主数据的门票字段，`quest_entry_costs.json` 因此把该关生成成 `itemId=0`、`itemCount=0`、`stamina=30`。服务端开始事务本身具备门票校验与扣除逻辑，但收到的生成配置只要求扣体力。

**修复**：按国服 `AdventEventQuestValues` 使用列 `61/62/63/75` 重建入口消耗数据。包括歼灭者在内的 5 个 Advent 最高难度关卡恢复各自的 1 张门票和 30 体力消耗；生成器也不再过滤零体力的 `Always` 门票关。active quest 现会持久化预扣门票 ID 和数量；abort 在同一事务内核对 `play_id/quest_id/category` 后原子返还一次但不返体力，延迟的旧 abort 不影响新战斗；CN load 会恢复有效 active quest，失效多人房间则按同一取消语义返还后清理。continue 和成功 finish 均不会二次扣票。

迁移前 `entry_item_count=NULL` 的旧记录只兼容当前明确为 1 张的配置，同时要求门票 ID 一致；未来非 1 数量不会根据主数据猜测返还。abort 已显式设置 MsgPack 响应头，active quest 状态也已从路由模块抽离为独立 service，避免 load 与单人战斗路由形成运行时依赖。

**客户端验收重点**：开始 `200076009` 后歼灭心核立即预扣 1，完成并重新 load 后保持；主动放弃会返还门票但不返还体力；数量为 0 时无法开始且体力不应单独减少。

详见 [歼灭者讨伐战最高难度解锁](../systems/boss-epuration-unlock.md)。

**剩余风险**：单人 finish 仍会在完整奖励流程前删除 active quest。若之后发生异常，无法恢复本次结算；此次为避免重复奖励风险，没有把 finish 扩成大事务。

## 土俑累计分奖励无动画且未到账 ✅ 已修复并通过客户端验收 (2026-07-19)

**症状**：战斗分数与累计最佳分可以更新，但返回活动页面时没有累计分奖励动画，道具也未发放。

**根因**：服务端没有加载 `carnival_event_total_score_reward`，结算中的 `reward_ids` 和 `new_degree_ids` 固定为空，也没有已领取记录。客户端要求 `is_record_valid=true` 且 `reward_ids.length>0` 才进入奖励提示流程。

**修复**：从国服主数据生成 19 个活动、1451 档奖励；按累计最佳分自动发放尚未领取的档位；在同一事务中更新分数、发放道具/装备/星导石/玛纳/经验池/称号并登记奖励行 ID；响应返回奖励行 ID 触发官方动画。旧高分存档会在下一次成功挑战时补发遗漏档位。

**存档与边界**：完整存档会保留各 folder 分数、领取记录和称号，恢复后不会重复发奖。当前只保证土俑子流程原子化；整个单人结算尚未统一为一个总事务，详见系统文档。

**客户端验收**：累计分奖励正确到账，返回活动页面时正常播放奖励动画；再次挑战不会重复发放已经登记的奖励档位。当前土俑累计分奖励流程未发现其他问题。

详见 [土俑累计分奖励](../systems/carnival-score-rewards.md)。

## 狂热激战配队重新进入后恢复默认 ✅ 已修复，待客户端验收 (2026-07-17)

**症状**：狂热激战配队编辑请求成功，数据库也已保存 category 4 的新队伍，但退出配队页面后重新进入仍显示默认队伍。

**根因**：`/event/rush/party` 将每个配队组内部的槽位 `1` 至 `10` 直接作为 `party_id` 返回，导致 12 个组重复使用同一批 ID。客户端把所有 Rush 队伍存入以全局 `party_id` 为键的 Map，后返回的组会覆盖前面的组，通常表现为第 12 组默认队伍覆盖第 1 组已保存队伍。

**修复**：响应使用全局 ID：`(party_group_id - 1) * 10 + slot`。组 1 返回 `1` 至 `10`，组 2 返回 `11` 至 `20`，组 12 返回 `111` 至 `120`。回归测试验证 120 个 ID 全部唯一；无需修改客户端或迁移数据库。

## 狂热激战常驻商店为空 ⚠️ 已启用推测性兼容，待客户端验收 (2026-07-19)

**历史症状**：常驻活动批次 `700011-700017` 的兑换列表为空，曾被误判为服务端缺少商品，并推测应共享 `700001-700007` 的商店和文件夹奖励。

**CDN 结论**：国服最终 CDN `v1.4.54` 中，常驻活动批次确实没有活动代币、文件夹代币奖励或 `event_item_shop` 商品。原始活动批次 `700001-700007` 才有 209 件商品，数量依次为 `33/31/29/29/29/29/29`，服务端协议 `event_type=11`。这说明空列表不是提取或转换丢失，但不能单独证明官方服务端没有动态复用。

**兼容决定**：保留 `700011-700017 → 700001-700007` 的运行时回退，同时覆盖商品和完整文件夹通关奖励（代币及配套素材）。常驻活动自身的非空 CDN 数据始终优先；空商品对象和空奖励数组继续视为未补全。未来 CDN 补丁层增加非空精确数据后会自动覆盖对应回退，并关闭旧商品的常驻期直购。兼容商品保留原始开放期，并额外使用常驻活动的 `2025-06-26 12:00:00` 至 `2025-08-14 23:59:59`（JST）开放期。该映射缺少官方服务端抓包支持，明确标记为推测实现。

**购买一致性**：普通购买继续执行正整数校验、多开放期校验及 SQLite 总事务；过期直接购买返回 `result_code=2053`，扣币、完整发奖和累计购买数任一步失败均整体回滚。

**关卡奖励一致性**：文件夹奖励只在首次写入通关记录时发放；通关记录、Rush 状态清理和发奖位于同一 SQLite 事务，重复通关不会重复获得代币或素材。

**待验收**：当前全局服务器时间位于常驻活动开放期。验证 `700011` 显示 33 件商品、文件夹通关发放 `2370001`、购买后代币与奖励库存正确、库存上限生效，以及重新 load 和服务重启后累计购买数保持。

## 土俑挑战后配队恢复默认 ✅ 已修复，待客户端验收 (2026-07-17)

**症状**：在土俑配队页面编辑后重新进入可以看到新配队；使用该配队完成一次挑战后，再进入配队页面却恢复为旧队伍或默认队伍。

**根因**：国服客户端会按模式发送独立的 `party_category`：普通关卡为 `1`、土俑为 `2`、战阵为 `3`、狂热激战为 `4`。服务端保存土俑配队时保留了 `2`，但 `/carnival_event/index` 和 `/get_party` 固定读取 `4`。挑战结算没有删除或覆盖配队，只是页面重新请求后用错误分类的数据覆盖了客户端缓存。Raid 的 `3` 还会被保存端强制改成 `4`，因此 Raid 与 Rush 也会互相覆盖。

**修复**：

- 明确 `PartyCategory.CARNIVAL=2`、`RAID=3`、`RUSH=4`，保存端不再把 `3` 映射为 `4`。
- 三种特殊关卡按各自分类读取；配队组颜色按请求中的分类更新，并在重新进入时返回持久化颜色。
- `/party/edit` 与 `/party_group/edit` 仅接受协议定义的整数分类 `1` 至 `4`，拒绝协议外分类。
- 对历史数据采用只补不改策略：目标分类已有记录优先，旧 `category=4` 数据补充缺失槽位，默认队伍最后补齐到 12 组 × 10 槽；使用 `INSERT OR IGNORE` 保证现有土俑配队不会被兼容数据覆盖。
- 回归测试覆盖分类编号、稀疏配队合并优先级和 SQLite 只插入缺失记录。

**影响范围**：土俑全部 19 个活动、57 个 folder、171 个关卡的配队重新加载流程；同时解除 Raid/Rush 的活动配队共享。客户端验收仍需分别测试三种模式的编辑、退出重进、完成挑战后重进和配队组颜色保存。

## 土俑结算分数固定为难度分 ✅ 已修复 (2026-07-17)

**症状**：关卡 `250604002` 的战斗结算显示 `3,033,723`，活动页面记录却只有固定难度分 `2,000,000`。

**根因**：CDN `carnival_event_quest` 第 100 列 `battle_time_limit` 的单位是 60 FPS 帧数。客户端按 `round(frames × 1000 / 60)` 换算成毫秒，服务端转换器却直接把 `72,000` 帧写成 `72,000 ms`，导致耗时 `166,277 ms` 被判定没有时间奖励。

**修复**：转换器统一把帧数换算为毫秒并重建 171 个土俑关卡。完整公式为 `difficulty_score + floor(max(0, timeLimitMs - round(clearTimeMs)))`；该关正确计分为 `2,000,000 + (1,200,000 - 166,277) = 3,033,723`。回归测试覆盖资产单位、耗时取整、时间奖励下限和最终写库参数。

## Signup 空账号 ✅ 已修复 (2026-06-27)

**症状**: 部分客户端每次访问生成 6 个空账号（account 有记录、player 为空），重新登录再生成 6 个。

**根因**: `insertPlayerSync` 中 INSERT 列顺序与 VALUES 数组不匹配，`total_stamina_used`/`total_powerflips`/`total_dashes` 与 `account_id`/`tutorial_*` 之间 4 列错位。客户端 `RETRY_LIMIT=5` 放大为 6 次失败 signup。

**修复**:
- `insertPlayerSync` 改为命名绑定（`@column`），列名与值在同一处，消除顺序错位风险
- `insertDefaultPlayerSync` 加事务包裹（原子性）
- `getDefaultPlayerData` 补 `timeOffset: null`
- `tool.ts` signup 关键区改为同步调用（防御性）

详见 `docs/status/changelog.md` 第十六节。

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
| 客户端不做 ZIP 请求级 SHA256 校验 | 服务端仍返回 Catalog 摘要；文件路由不重复计算请求级哈希 | 已知边界 |
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
| 首页立绘 F1010/8703/8704 | `favorite_party_group_list` 从空数组/空值改为从 `user_party_group_list` 构建真实数据，字段名对齐 `fromPartyInfo`（`name→party_name`, `edited→party_edited`） |

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

## 无限演武（ScoreAttackEvent）核心流程 ✅ 已修复，待客户端验收 (2026-07-19)

**历史根因**：服务端曾把无限演武错误映射到 category 9，并把关卡分数阈值当作耗时阈值；同时把分数奖励的 `reason_id=16001` 误认成道具 ID，只发最高一档的第一项奖励。category 9 实际是教程关卡，国服 1.8.1 客户端完整支持 category 27 和 `score_attack_event` 结算响应。

**修复**：按 `ScoreAttackEventQuestValues` 重建 123 个关卡，全部使用 category 27 和 10 体力；移除虚构的首通、S+ 与普通掉落奖励。按 `ScoreAttackBorderRewardValues` 重建 11,100 档奖励，保留奖励行 ID、分数线、原因 ID 和最多 6 个奖励槽。当前奖励 kind 扫描结果仅为 `{0}`，服务端完整发放现有道具槽并明确拒绝未出现类型。成功结算按 `(旧最高分, 新最高分]` 发放所有跨越档位，按分数计算 C/B/A/S/SS；category 27 的基础玩家更新、普通掉落、任务统计、角色经验、档位奖励、进度和 active 删除全部位于同一事务。响应返回 `score_attack_event.main_character_ids` 与奖励行 ID 列表。

**客户端验收重点**：检查 10 体力扣除、跨多档奖励、重复或低分不重复发奖、专用结算卡与奖励动画，以及重新 load 后最高分和评级保持。

**剩余低优先级**：`/history/score_attack_event_battle` 仍返回空履历。核心开战、结算和奖励不依赖该接口；没有完整字段依据前不猜测实现。

详见 [无限演武](../systems/score-attack-event.md)。

## 战阵（RAID_EVENT / 编队系统）— 待客户端重测

> 战阵不是常规多人房间。国服客户端由 `SingleQuestStartFlow` 启动玩家本地三队 Raid，不创建、搜索或加入 `multi_battle_quest` 房间。下列项目记录历史修复内容，不代表客户端已经验收。

### 问题链

| # | 症状 | 根因 | 修复 |
|---|------|------|------|
| 1 | 无法进入战阵之宴 | `/event/raid/summary` 为 stub，缺 `raid_boss`/`auto_start_point` 等必填字段 | 补齐 5 个必填 raid 字段 |
| 2 | 按钮灰色，提示"队伍内存在已使用的角色" | `/event/raid/party` stub 返回 60 个 NORMAL party，同一角色跨多个 party 重复 | 改为返回 1 group × 3 party |
| 3 | 编辑配队后重进不持久 | 早期实现把客户端的 `category=3` 错误映射成 NORMAL，破坏了 Raid 独立分类 | 取消映射，按原生 `PartyCategory.RAID=3` 持久化 |
| 4 | 重新进入报错 | 缺少 `getServerDate` import → H500 | 补 import |
| 5 | 战斗结束 H400 | `/event/raid/battle/start` stub 未写 `activeQuests` | 写入 `activeQuests` + 推算 eventId |
| 6 | `/finish` 500 UNIQUE | 重复挑战同一关 played party 冲突 | `INSERT OR REPLACE` |
| 7 | 通关后无 rank/exp/mana 奖励 | `raid_event_quest.json` 奖励字段全为 0 | converter 修复 [82-98] 字段 |
| 8 | 分数掉落在战阵之宴用独立系统 | `scoreRewardGroupId` 不存在，需事件级奖励系统 | 待后续 |

### 关键修复文件

| 文件 | 变更 |
|------|------|
| `src/routes/api/raidEvent.ts` | `/summary`、`/party`、`/battle/start`、`/select_folder`、`/reset` 全部重写 |
| `src/routes/api/party.ts` | `/party/edit` 按原生 `PartyCategory.RAID=3` 保存 |
| `src/routes/api/singleBattleQuest.ts` | RAID_EVENT played party 记录 + eventId 支持 |
| `src/data/domains/rushEvent.ts` | `INSERT OR REPLACE` 防重复 |
| `scripts/converter.py` | `convert_raid_event_quest` 从 CDN 提取完整奖励字段 |
| `assets/raid_event_quest.json` | 50 关全部恢复 battle 数据 |

### 当前配队流程

```
进战阵之宴 → /event/raid/party 读取 RAID category 的本地三队 → 显示
编辑配队 → 内存修改（不发请求）
退出编队组编辑 → /party/edit {category:3} → 持久化
选择关卡 → SingleQuestStartFlow → /event/raid/battle/start
战斗与结算 → 本地三队 Raid → /finish → played party 记录
```

验收目标是三队配队、Raid 启动、战斗和结算，不再寻找常规共斗入口。
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

## Mana Board F1009 崩溃（服务时间 vs Board2 解锁窗口） 🔧 已知局限

**症状**: 打开部分角色的玛纳板时 `F1009: TypeError #1009`，崩溃点 `ManaNodeTreeChartView/changeActiveManaBoard()`。

**崩溃角色特征**:
- 已学完 board 1 全部节点（23 个），角色 `mana_board_index >= 1`
- `evolution_level = 1`
- board 2 节点 ID 均为 int32 大数（>3 亿，非 int16 的 2xxx）

**正常角色**:
- Albus(1)：节点 ID 2201~2418（int16），board 2 开放时间 2015-03-01（永远有效）
- 未学任何节点的角色：无 mana_node_ids → 不访问 board 2 层

### 根因

`ManaBoard2OpenConditionTable` 中不同角色的 board 2 开放时间不同：

| 角色 | board 2 开放时间 |
|------|-----------------|
| 1 (Albus) | 2015-03-01 15:00 |
| 151165 | 2025-04-03 12:00 |
| 153001, 151147 | 较晚日期 |

当服务时间 < board 2 开放时间时，客户端 `canManaBoard2Open()` 返回 false：

```
canManaBoard2Open(151165) = false (时间未到)
  → allBoardIndexes = [1]          ← 只渲染板1
  → run() 只创建 boardLayers[1]
  
但存档中 mana_board_index = 2     ← 板2已学完
  → initialize() → changeActiveManaBoard()
  → 尝试访问 boardLayers[2]       ← null!
  → F1009
```

源码证据：`GeneralCharacterLogic.as:970-1017` `canManaBoard2Open()`，通过 `ManaBoard2OpenConditionTable` 的 `start_time/end_time` 与 `AppTimeConfig.currentServerTime` 比较。

### 为什么是客户端 bug（非服务端 bug）

服务端数据完全正确——`bond_token_list`, `mana_board_index`, `evolution_level` 均合法。客户端在时间锁定时应优雅降级（显示板1 + 板2锁定提示），但实际抛出了空指针。

### 兼容方案

| 方案 | 操作 | 优劣 |
|------|------|------|
| **A: 对齐时间** | 服务时间调到 ≥ 2025-04-03 | ✅ 最简单，所有角色 board 2 均开放 |
| **B: 服务端过滤** | load 响应中，若时间 < board2_start，将 `mana_board_index` 降为 1 | 需查 CDN 表获取每个角色的开放时间，维护成本高 |
| **C: 客户端修复** | 修改 CN 客户端 APK（starview patch） | 技术上可行但需额外开发 |
| **D: 标记已知** | 接受当前限制，告知玩家调时间 | 零开发成本 |

**当前采用方案 A**（已在服务时间设置中体现）。

### 相关角色排查方法

```sql
-- 查所有角色的 board2 开放时间
-- 数据在 wf-assets-cn/orderedmap/mana_board/mana_board2_open_condition.json
-- 字段：[0]=start_time, [1]=end_time
```

---

**最后更新：2026-07-01**（详细变更见 [CHANGELOG.md](./CHANGELOG.md)）

## 参考文档

| 文件 | 说明 |
|------|------|
| `docs/generated/gacha_timeline.csv` | 581 条卡池时间线（含 UP 角色） |
| `docs/generated/character_table.csv` | 505 条角色对照表（元素已修正） |
| `docs/generated/quest_timeline.csv` | 17,014 条副本活动期 |

生成脚本：`scripts/gen_gacha_timeline.js`, `scripts/gen_character_table.js`, `scripts/gen_quest_timeline.js`

（详细变更见 [CHANGELOG.md](./CHANGELOG.md)）
