# 客户端解析契约审计 — 经济链 14 端点（gacha / crazy / shop / mail / mission / sell）

- 审计基线 commit：`34848ccf7193e2726f01293e11daacafc6b87596`（2026-11-05，docs(reference): help-text audits batch 3；`git log -1` 于 worktree starpoint-cn-dev-integration 读取）
- 客户端权威源：`wf-cn-client-as3-20261014/scripts/`（下文以 `client:` 缩写）；服务端源：本仓库（下文以 `server:` 缩写，路径相对仓库根）
- 方法：先读通用响应管线定基线，再逐端点读 `pinball/remote/<域>/<动作>/<Xxx>RealRemote.as` 的 successHandler 解析代码列出客户端字段全集（类名+行号），对照服务端响应构造器（file:line）求差集。所有行号均为反编译 `.as` / TS 源文件真实行号。
- 判定口径：**缺口** = 客户端会读但服务端未发（影响分级：P1 状态推进/经济可见错误、P2 UI 显示缺陷、P3 冗余/无害）；**冗余** = 服务端发但客户端完全不读（一律 P3 记录）。Optional 字段缺失时客户端走 `Option.None` 分支不抛错；标 `[必]` 的字段缺失即抛 ClientError（8700-8707）。

---

## 0. 通用响应管线基线（公共字段）

每个 RealRemote 响应先经通用解析，再进端点专属 successHandler，端点级只列增量：

**Header 契约** — client:`pinball/remote/common/ResponseData.as:39-132`，`data` 必须为 Object（ResponseData.as:14-20 校验由 `context/remote/RemoteResponseFields.as:11-20` 的内联 P-code 还原）：
| 字段 | 类型 | 必需 |
|---|---|---|
| `data_headers.result_code` | Int | **必需**（缺失抛 8700） |
| `data_headers.servertime` | Float | 可选（但部分端点显式要求，见 §1） |
| `data_headers.asset_update` / `force_news` / `short_udid` / `viewer_id` | 各类型 | 可选 |
| `data_headers.force_update` | — | **客户端不解析**（server 每响应都发，见缺口 #C1） |

**公共字段管线**：client:`pinball/context/remote/real/RealRemoteService.as:92-1978`（`earlySuccessHandler` 逐字段校验）→ 1976 行 dispatch `SectionCommand.ReceiveCommonResponse` → `pinball/context/Logic.as:967-998`（case 25）→ `pinball/common/data/player/PlayerLogic.as:3220-3314`（`applyCommonResponse`）+ `pinball/context/global/GlobalLogic.as:1394-1447`（`applyToastFromCommonResponse`，任务/图鉴/超容 toast）。

公共字段全集（client，RealRemoteService.as:92-1978 顺序）：

| 字段 | 结构要点 | 应用点 |
|---|---|---|
| `active_mission_list` | Array `[{mission_id Int[必], progress_value Int[必], stages? [{received Bool[必], stage Int[必]}]}]` | PlayerLogic/GlobalLogic 更新进度+toast（GlobalLogic.as:1778） |
| `character_list` | Array，`character_id Int[必]`，其余 optional（entry_count/evolution_level/exp/stack/over_limit_step/protection/bond_token_list/mana_board_index/mana_board_awake/ex_boost/update_time/join_time） | PlayerLogic.as:3089-3218 |
| `config` | Object | applyConfigFromCommonResponse |
| `crazy_gacha_result_list` | IntMap（gacha_id → Int 数组） | PlayerLogic.as:3078-3088 |
| `encyclopedia_info` | Array | GlobalLogic.as:1436-1443 图鉴 toast |
| `equipment_list` | Array `[{equipment_id[必], protection[必], stack[必], level[必], enhancement_level[必]}]` | PlayerLogic.as:3058-3076 |
| `fund_receive_list` | Array Int | PlayerLogic.as:3043-3057 |
| `item_list` | IntMap（item_id → 数量） | PlayerLogic.as:3018-3042 |
| `mail_arrived` | Bool | PlayerLogic.as:3263-3272（未领邮件>0 时小红点） |
| `mission_info` | Array（`mission_category_id`/`mission_reward_id` 为 toast/成就键，`pinball/common/data/mission/common/MissionRewardIdKindTools.as:14-19`） | GlobalLogic.as:1748-1768 |
| `monthly_charge_bonus_info` | `{bonus_days?, expired_time?, init_time?}` | PlayerLogic.as:2967 |
| `over_max` | Array，元素 `{process_type, item{item_id,number}, amount_sold?, character?{character_id,number}, equipment?{equipment_id,number}, converted_*?, free_mana?, free_vmoney?}`（全部 optional） | RealRemoteService.as:1140-1350 解析；GlobalLogic.as:1726 超容弹窗 |
| `user_daily_challenge_point_list` | Array `[{id Int[必], point Int[必], campaign_list Array[{additional_point Int[必], campaign_id Int[必]}]}]` | logicStatus.applyDailyChallengePointList |
| `user_info` | 24 子字段全 optional：bond_token/boost_point/boss_boost_point/degree_id/enable_auto_3x/exp_pool/exp_pooled_time(Float)/free_mana/free_vmoney/is_bought_fund_*(×5)/month_card_remain_days/monthly_payment_total/paid_mana/rank_point/renewal_gift_remain_days(StringMap)/stamina/stamina_heal_time(Float)/star_crumb/vmoney/weekly_bonus_remain_days | PlayerLogic.as:2708（applyCommonResponseUserInfo）；字段全集见 RealRemoteService.as:1837-1975 的 Option.Some 字面量 |

server 侧对应实现：`server:src/lib/common-response/`（model.ts 片段类型、merge.ts 按 id 合并、entities.ts 白名单投影），与上述契约一致。

---

## 1. gacha/exec（含 type=14 疯狂十连候选）

**客户端解析** — client:`pinball/remote/gacha/exec/GachaExecRealRemote.as` successHandler:72-730：

| 字段 | 类型 | 必需 | 行号 |
|---|---|---|---|
| `data.draw` | Array `[{character_id Int[必], entry_count Int[必], ex_boost_item? {count Int[必], id Int[必]}, movie_id String[必], seed Int[必]}]` | 与 draw_equipment 二选一，两者皆有/皆无→`InvalidDrawResult` 弹窗（:117/:119） | :141-236 |
| `data.draw_equipment` | Array `[{equipment_id Int[必], treasure_up_type Int[必]}]` | 同上 | :238-284 |
| `data.gacha_campaign_list` | Array `[{campaign_id Int[必], count Int[必], gacha_id Int[必]}]` | 可选 | :285-338 |
| `data.gacha_info_list` | Array `[{gacha_id Int[必], is_account_first Bool[必], is_daily_first?, crazy_draw_count?, daily_one_count?, daily_ten_count?, gacha_exchange_point?, comeback_campaign? {period_end_time Float, period_start_time Float}, stars_campaign? 同前}]` | 可选 | :339-530 |
| `data.is_erupt` | Bool | 可选（仅装备抽卡分支消费，:714） | :532-545 |
| `data.mission_tips` | Bool → `devConfig.missionTips` | 可选 | :546-559, :628 |
| `data.need_feedback` | Bool → 结果页反馈引导（GachaResultScene.as:435-451，true 才出问卷入口） | 可选 | :560-573 |
| `data.stars_gacha_campaign_list` | Array `[{campaign_id Int[必], free_one_times Int[必], free_ten_times Int[必]}]` | 可选 | :574-627 |
| `header.servertime` | Float | **必需**（None 抛 `No Value(f8ce8390…)`，:120-129） | :120-130 |
| star_crumb / item 差值 | `get_starCrumb()-beforeStarCrumb`（:63/:119）、`getItemDiff`（:118,:737-764）作为增量传入结果场景；星屑增量>0 时结果页追加「获得星屑」日志（`pinball/scene/gacha/result/common/GachaResultSceneBase.as:376-383`；`pinball/loading/gacha/GachaLoadingTaskBase.as:130` `>0 才显示`） | — | :118-119 |
| 新角色/新装备 diff | 从公共管线已应用的 character_list/equipment_list 求新 id（:645-663/:694-713） | — | — |
| 错误码 | 1351/1361/1366/7004/13004 → 卡池期限类站内提示（:766-822） | — | — |

**服务端发送** — server:`src/routes/api/gacha.ts:30-121` → `src/lib/gacha-owner/response-projector.ts:14-106`：
- 公共：user_info{free_vmoney, vmoney, free_mana}、item_list（票券余额+奖励道具）、mail_arrived、active_mission_list、character_list（角色池）/equipment_list（装备池）、over_max（超容时）、mission settlement 片段（mission_info/degree_list 等，response-fragment.ts:151-169）
- 端点（角色池，:63-90）：`gacha_info_list`（gacha_id/is_account_first/is_daily_first/gacha_exchange_point/daily_one_count/daily_ten_count）、`encyclopedia_info: []`、`draw`（character_id/movie_id/seed/entry_count/ex_boost_item?，构造见 `src/lib/gacha-reward-grant.ts:226-247`）、`gacha_campaign_list`、`stars_gacha_campaign_list`（非空才发）
- 端点（装备池，:91-104）：`gacha_info_list`、`encyclopedia_info: []`、`is_erupt`、`draw_equipment`（equipment_id/treasure_up_type，gacha-reward-grant.ts:296-301）
- type=14 疯狂候选（gacha.ts:64-87 → `src/lib/gacha-owner/crazy-response-projector.ts:23-45`）：`draw`（含 movie_id/seed/entry_count/ex_boost_item，`src/lib/gacha-owner/crazy.ts:174-191`）、`gacha_info_list`（**含 crazy_draw_count** — PR #31 修复点，现已在位）、`crazy_gacha_result_list`、公共 item_list
- data_headers：`src/utils.ts:133-164`（result_code/servertime/viewer_id/short_udid/asset_update/**force_update**）

**差集判定**：
- 客户端读未发：`mission_tips`（P3，devConfig，缺失=None）、`need_feedback`（P3，false=不出反馈引导，私服合理）、`gacha_info_list[i].comeback_campaign`/`stars_campaign`（P3，复刻/Stars 活动未实装，缺失即不显示活动期）、非疯狂卡池的 `crazy_draw_count`（P3，普通池官方即恒 0/99 静态，参见 commit bb9e076b 结论）。均 optional，无崩溃面。
- 客户端读且已发：draw/draw_equipment/gacha_info_list/gacha_campaign_list/stars_gacha_campaign_list/is_erupt/servertime — **全部在位，无缺口**。
- star_crumb 复核：客户端 exec 处 diff 星屑，但服务端 exec 路径不改 `players.star_crumb`（唯一写点 `src/lib/gacha-owner/conversion.ts:110-111` 的过期交换点转换发生在 **load**（`src/routes/cn/load.ts:329-340`），load 的 user_info 携带 star_crumb（`src/data/utils/serialize-player.ts:247`））→ diff 恒 0 → 不出「获得星屑」行，与「转换发生在 load」语义一致，**非缺口**。
- 冗余：`data_headers.force_update`（见 C1）；`encyclopedia_info: []` 走公共管线但空数组无效果（C5）。

---

## 2. gacha/crazy_gacha_save、crazy_gacha_select

**客户端解析**：
- save — client:`pinball/remote/gacha/crazyGachaResult/CrazyGachaResultSaveRealRemote.as:55-89`：`data.crazy_gacha_result_list` = IntMap（gacha_id→Int 数组），经 `Reflect.fields` 解析（字段缺失时 `Reflect.fields(null)` 返回空数组，不崩；但语义上是必需字段）→ dispatch `GachaRemoteInput.GachaSave`（:90）。
- select — client:`pinball/remote/gacha/crazyGachaResult/CrazyGachaResultSelectRealRemote.as:32-46`：**不读任何端点字段**，直接 dispatch `GachaSelect`；全部消费走公共管线。

**服务端发送** — server:`src/routes/api/gacha/crazy-routes.ts:47-134`：
- save → `src/lib/gacha-owner/crazy-response-projector.ts:47-55`：`crazy_gacha_result_list`（槽位→角色 id 数组）。**精确匹配**。
- select → crazy-response-projector.ts:57-95：character_list、item_list、user_info{free_mana,free_vmoney}、mail_arrived、over_max、active_mission_list、`crazy_gacha_result_list: {}`、mission settlement。客户端经公共管线全部消费。
- 错误码 1351/1361 带内返回（crazy-routes.ts:35-45），客户端 defaultErrorHandler 映射期限错误（Save:98-141 / Select:48-92）。

**差集判定**：无缺口。冗余：select 响应的 `crazy_gacha_result_list: {}` 空对象经公共管线 `applyCommonResponseCrazyGachaResultList` 空迭代 no-op（C4，记录）。

---

## 3. shop/buy、shop/bulk_buy、shop/get_sales_list

**客户端解析**：
- buy — client:`pinball/remote/shop/buy/ShopBuyRealRemote.as:55-1232`：自带一套公共字段解析（比通用管线更严）：character_list（**join_time String[必] :323-329、update_time String[必] :421-426**、ex_boost{ability_id_list, status_id}、mana_board_awake IntMap）、crazy_gacha_result_list（:446-490）、equipment_list（:491-559）、fund_receive_list（:561-589）、item_list（:590-620）、mail_arrived（:621-635）、monthly_charge_bonus_info（:636-704）、user_daily_challenge_point_list（:705-791）、user_info 全 24 子字段（:792-1214）。**无任何端点专属字段**。增量字段喂给 `getIncreasedExBoostItems`（ex 强化道具获取记录，:1215-1225）。错误码 2053→ShopPeriodError、3010→ShopStepOverDay（:1264-1283）。
- bulk_buy — client:`pinball/remote/shop/bulkBuy/ShopBulkBuyRealRemote.as:55-60`：不读任何端点字段（公共管线消费）。
- get_sales_list — client:`pinball/remote/shop/getSalesList/ShopGetSalesListRealRemote.as:178-539`：`data.sales_list`（:188-482）元素 `{shop_item_id Int[必], shop_type Int[必], stock_quantity Int[必], today_purchase_num Int[必], total_purchase_num Int[必], this_month_purchase_num?, discount_id?, discount_rate Float?, discounted_price?, group_info? {group_total_purchase_num Int[必], group_total_stock_quantity Int[必], multi_stage Bool[必], other_group_items? [同结构缩减版]}}`；`data.user_notice_list`（:483-529）元素 `{kind Int[必], status Int[必]}`。**不消费公共字段**（Finished 只带这两个字段，:530-533）。

**服务端发送** — server:
- buy/bulk_buy：`src/routes/api/shop/purchase-routes.ts:110-224` → `src/lib/shop/response-projector.ts:29-85`：user_info{vmoney,free_vmoney,paid_mana,free_mana,bond_token,exp_pool}、character_list（含 join_time/update_time — 新角色投影 `src/lib/gacha-owner/acquisition-batch.ts:71-88` 显式含 join_time/update_time，重复角色 ISO 串来自 `src/data/domains/character.ts:479-480`）、equipment_list、item_list、`mission_info: []`、over_max、`degree_list: []`、mission settlement；route 层补 active_mission_list/mail_arrived（purchase-routes.ts:140-149, 205-214）。期限错误带内 result_code（purchase-routes.ts:86-95）。
- get_sales_list：`src/routes/api/shop.ts:57-131` → `src/lib/shop-sales-list.ts:74-87,137-155`：`sales_list` 元素含 shop_item_id/stock_quantity/today_purchase_num/this_month_purchase_num(null)/total_purchase_num/discount_id(null)/discount_rate(null)/discounted_price(null)/group_info{group_total_*, multi_stage}/shop_type；**无 user_notice_list**；无公共字段。

**差集判定**：
- 客户端读未发：`user_notice_list`（P3 — 缺失时 `PlayerLogic.updateUserNoticeList` PlayerLogic.as:137-141 直接早退；官方用于商店内通知状态，当前无功能损失）；`other_group_items`（P3 — 捆绑组其余档位，当前目录无此结构）；`discount_id/rate/discounted_price` 恒 null（P3 — 客户端 optional，None；实装折扣活动时 **discount_rate 必须是 Float** 否则 8701 崩）。
- 必需契约复核：buy 响应 character_list 的 join_time/update_time String 必需 — server 满足（上述两处），无缺口。
- 冗余：`degree_list`（客户端 shop/buy 不读，全客户端仅 `pinball/remote/profile/getDegreeList/ProfileGetDegreeListRealRemote.as` 消费 degree_list 字段，C3）。

---

## 4. mail/receive、mail/receive_all

**客户端解析**：
- receive — client:`pinball/remote/mail/receive/MailReceiveRealRemote.as:50-1340`：**`auto_sale_expired_mail` Bool[必]（:147-153）、`dispose_expired_mail` Bool[必]（:154-160）、`total_count` Int[必]（:161-167）**；`user_periodic_reward_point_list`（[{id Int[必], point Int[必]}]，可选 :168-215）；自带公共字段解析（同 shop/buy 的严格版：character_list join_time/update_time 必需 :410-416/:508-513，user_info 24 子字段 :879-1301 等）。dispose=true→过期销毁弹窗、auto_sale=true→过期变卖弹窗、否则 ReceiveFinished（:1313-1339）。错误码 2001/2002/2004 → 站内 ReceiveError（:1372-1394）。
- receive_all — client:`pinball/remote/mail/receiveAll/MailReceiveAllRealRemote.as:36-250`：**9 个计数全部必需** — `already_mail_count`（:67）、`auto_sale_expired_mail_count`（:74）、`deleted_mail_count`（:81）、`dispose_expired_mail_count`（:88）、`mail_ids` Array[必]（:155-176）、`max_overed_mail_count`（:177）、`outdated_mail_count`（:185）、`total_count`（:181）；`ex_boost_item_list`（[{item_count/item_id/mail_id 均必需}]，可选 :95-150，用于一键领取的角色获取动画 ex 强化标注 — MailListScene.as:342）；`user_periodic_reward_point_list`（可选 :188-230）。消费点 `pinball/scene/mailList/MailListScene.as:298-352`（计数 → 汇总弹窗；mail_ids → setMailReceived）。**不读公共字段**（item_list 等由后续刷新承担）。

**服务端发送** — server:`src/routes/api/mail.ts`：
- receive（:147-277）：`auto_sale_expired_mail`（:266）、`dispose_expired_mail: false`（:267）、`total_count`（:268）+ 公共片段 mail_arrived/over_max/character_list/equipment_list/item_list/user_info（:245-270，邮件发星屑时 user_info.star_crumb 由 `src/lib/mail-reward-grant.ts:338` 注入）。2001/2002/2004/2005 带内 result_code（:210-238）。
- receive_all（:279-471）：9 计数 + mail_ids + `ex_boost_item_list: []`（:453-463）+ 公共片段（:433-452）。

**差集判定**：
- 客户端读且已发：全部必需字段在位。**无 P1/P2 缺口**。
- 客户端读未发：`user_periodic_reward_point_list`（P3 — 周期奖励点活动未实装，缺失=None 早退 PlayerLogic.applyPeriodicRewardPointList:2482）；receive_all 的 `ex_boost_item_list` 恒空数组（P3，待真机 — 邮件同时含强化道具与新角色时，一键领取动画缺「同时获得强化道具」标注，仅显示细节）。
- 冗余：无（receive_all 公共片段虽不被该 remote 类消费，但 earlySuccessHandler 仍校验且场景经其它路径刷新，记为一致性发送，不算冗余缺口）。

---

## 5. mission 系（active_mission/receive、active_mission/receive_incentive、mission/get_mission_progress）

**客户端解析**：
- active_mission/receive — client:`pinball/remote/activeMission/receive/ActiveMissionReceiveRealRemote.as:28-45`：**不读任何端点字段**（data 仅校验为 Object）；奖励/进度全走公共管线（item_list/user_info/active_mission_list/mission_info/mail_arrived）。
- active_mission/receive_incentive — client:`pinball/remote/activeMission/receiveIncentive/ActiveMissionReceiveIncentiveRealRemote.as:29-97`：**`data.active_mission_incentive` Object[必]**（缺失抛 8707），内含 `ingame_reward_id Int[必]`（:53-58）、`real_reward_id?`（:59-72）、`url? String`（:73-86）。错误码 2479→OutOfPeriod、2480→AlreadyReceived（:99-133）。
- mission/get_mission_progress — client:`pinball/remote/mission/getMissionProgress/MissionGetMissionProgressRealRemote.as:164-252`：`data.mission_progress_list`（可选但业务必需）元素 `{mission_category Int[必], mission_id Int[必], progress_value Float[必], stage Int[必]}`（:213-243）。

**服务端发送** — server:
- active_mission/receive：`src/routes/api/activeMission.ts:26-140` — active_mission_list（{mission_id, progress_value, stages:[{stage, received:true}]}，:97-107/:135）+ 公共片段（user_info 含 exp_pooled_time、character_list、equipment_list、item_list、mail_arrived、over_max，:114-129）+ `degree_list`（:137）。
- receive_incentive：**服务端无路由**（grep 全 src/ 无 `receive_incentive`；仅 activeMission.ts:26 一个 `/receive`）→ 客户端收到 HTTP 错误走 defaultErrorHandler，弹通用错误框（H404 惯例，AGENTS.md）。
- get_mission_progress：`src/routes/api/mission.ts:41-220` — mission_progress_list（mission_category/mission_id/progress_value Number()/stage，:155-172）+ mission_info/item_list/character_list/equipment_list/degree_list/mail_arrived + settlement 片段（:161-218）。

**差集判定**：
- **缺口（P2→P3 复核修正 2026-11-08）#G1**：`active_mission/receive_incentive` 未实现。客户端契约要求 `data.active_mission_incentive`（ActiveMissionReceiveIncentiveRealRemote.as:43-58）。
  **真机复核修正（服务器日志+客户端架构双证）**：日志中 7 次任务领取全部走 `active_mission/receive`（200），零次 receive_incentive——成长任务(44)/内容指南(17)/回归任务(25)架构上就不走该端点。初版"17 项内容指南任务带 real incentive"系列匹配假阳性（列值 "1" 误作外键），特此更正。
  **正确触发面**：real incentive 挂在 active_mission_event.real_reward_id（客户端 `RealIncentiveActiveMissionScene.as:187` 独立实奖任务板），CN 1.4.54 唯一实奖事件=**100万円Present企画**（event 3，10 任务：编成角色/通关主线第1章/参加「大家一起选」等；real_reward 4 行=现金奖，ingame_reward 27 行=★5破星结晶等安慰奖）。该企画为现金奖励活动，私服无兑现路径 → **端点当前不可达，降级 P3 条件缺口：仅当未来启用实奖任务板时必须先补本端点**。
- get_mission_progress 契约匹配（progress_value server 端显式 `Number()` 转换，满足客户端 Float 校验）。
- 冗余：active_mission/receive 与 get_mission_progress 的 `degree_list`（同 C3）。

---

## 6. sell 系（equipment/sell_equipment、sell_stack、bulk_sell_stack）

**客户端解析**：
- sell_equipment — client:`pinball/remote/equipment/sell/EquipmentSellEquipmentRealRemote.as:28-36`：**不读任何端点字段**，dispatch `EquipmentSold(sellId)`；场景本地移除缩略图+`applySellEquipment`（`pinball/scene/equipmentList/EquipmentListScene.as:486-506`、PlayerLogic.as:2224）。
- sell_stack — client:`pinball/remote/equipment/sell/EquipmentSellStackRealRemote.as:28-36`：同上，不读。
- bulk_sell_stack — client:`pinball/remote/equipment/sell/EquipmentBulkSellStackRealRemote.as:27-35`：同上，不读。
- 三者的库存/锻块/星砂变更全部依赖公共管线（equipment_list/item_list/user_info/mail_arrived/over_max/mission settlement）。

**服务端发送** — server:`src/routes/api/sell.ts`：
- sell_equipment（:152-230）、sell_stack（:233-315）、bulk_sell_stack（:318-394）→ 共用 `dissolveResponseData`（:118-147）：equipment_list（`buildFullEquipmentList` 全量投影）、item_list（锻块/星砂/灵魂）、mail_arrived、over_max（超容）、user_info.free_mana（超容变卖时）、mission settlement（锻块任务）。bulk 空集走精简分支（:364-374）。

**差集判定**：客户端读公共管线消费，server 全部在位 — **无缺口**。记录（非缺口）：sell 系响应发全量 equipment_list 而非受影响 patch（客户端 `applyCommonResponseEquipmentList` PlayerLogic.as:3058-3076 按 equipment_id 全覆盖，行为正确但载荷偏重）。

---

## 缺口与冗余清单

### P1（状态推进/经济可见错误）
无。

### P2（UI 显示缺陷 / 功能未实现）
| # | 端点 | 内容 | 客户端证据 | 服务端证据 | 影响 |
|---|---|---|---|---|---|
| G1 | `active_mission/receive_incentive` | 服务端无路由，客户端必需 `data.active_mission_incentive`（ingame_reward_id[必]） | client ActiveMissionReceiveIncentiveRealRemote.as:43-58 | grep src/ 无 receive_incentive 路由 | **复核修正(P3)**：仅服务独立实奖任务板（100万円Present企画 event3/10 任务），常规任务全走 receive；私服无现金兑现路径，当前不可达——启用实奖板前必须先补 |

### P3（冗余 / 无害记录）
| # | 端点 | 内容 | 说明 |
|---|---|---|---|
| C1 | 所有响应 | `data_headers.force_update` 客户端不解析 | client ResponseData.as:39-132 仅解析 asset_update/force_news/result_code/servertime/short_udid/viewer_id；server `src/utils.ts:136,151` 恒发。无害，官方协议兼容字段 |
| C2 | gacha/exec | `mission_tips`、`need_feedback`、`gacha_info_list[i].comeback_campaign/stars_campaign` 未发 | 全 optional：need_feedback=false 即不出反馈问卷（GachaResultScene.as:435-451，私服合理）；复刻/Stars 活动期显示缺失，实装对应活动时需补 |
| C3 | shop/buy、active_mission/receive、get_mission_progress | `degree_list` 客户端这些路径不读 | 全客户端仅 profile/getDegreeList 消费该字段；称号达成提示实际走 mission_info |
| C4 | gacha/crazy_gacha_select | `crazy_gacha_result_list: {}` 空对象 | 公共管线空迭代 no-op |
| C5 | gacha/exec | `encyclopedia_info: []` 空数组 | 公共管线读但空数组无效果 |
| C6 | shop/get_sales_list | `user_notice_list` 未发 | updateUserNoticeList None 早退（PlayerLogic.as:137-141），无功能损失；月卡/补货提醒类通知实装时需补 |
| C7 | shop/get_sales_list | `other_group_items` 未发；`discount_id/discount_rate/discounted_price` 恒 null | 折扣/捆绑未实装；实装时 **discount_rate 必须为 Float**（客户端 8701 校验 ShopGetSalesListRealRemote.as:338-350） |
| C8 | mail/receive_all | `ex_boost_item_list` 恒 `[]`；两端点 `user_periodic_reward_point_list` 未发 | 前者影响一键领取动画的 ex 强化标注（待真机）；后者周期奖励点活动未实装 |
| C9 | equipment/sell 系 | 响应发全量 equipment_list 而非 patch | 行为正确，载荷偏重，记录 |

### 复核为非缺口
- **gacha/exec star_crumb diff**：客户端 diff 星屑（GachaExecRealRemote.as:63,119）但服务端 exec 不改 star_crumb；过期交换点→星屑转换在 load 完成（`src/routes/cn/load.ts:329-340`，conversion.ts:110-111），load user_info 携带 star_crumb（serialize-player.ts:247）→ diff 恒 0 不出「获得星屑」行，语义自洽。
- **疯狂抽卡 gacha_info_list**（PR #31 修复点）：type=14 候选响应已含 `gacha_info_list` + `crazy_draw_count`（crazy-response-projector.ts:35-41），在位。
- **shop/buy character_list 的 join_time/update_time 必需**：新角色投影显式携带（acquisition-batch.ts:77-86），重复角色 ISO 串（character.ts:479-480），满足。

---

## 结论

覆盖 14 端点（gacha/exec 含 type=14、crazy_gacha_save、crazy_gacha_select、shop/buy、shop/bulk_buy、shop/get_sales_list、mail/receive、mail/receive_all、active_mission/receive、active_mission/receive_incentive、mission/get_mission_progress、equipment/sell_equipment、sell_stack、bulk_sell_stack）。经济链端点的「客户端读但我们没发」仅 1 项（G1，receive_incentive 未实装，且触发面待主数据核对）；此前修复的 crazy select/type=14 gacha_info_list 已在位；必需字段（mail 9 计数、shop character_list 时间串、gacha draw 五元组、servertime）全部满足，无崩溃面。冗余侧 9 条均为 P3 记录，其中两条留有未来实装提醒：折扣活动必须发 Float discount_rate（C7）、商店通知需补 user_notice_list（C6）。
