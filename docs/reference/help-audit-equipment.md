# 帮助文本对照审计 — 装备强化线（特殊 / 追忆 / 歼灭 / 机兵 / 勋章）

- 口径：CN 主数据 **1.4.54**（wf-assets-cn）；服务端 **commit 679f2c67**（worktree starpoint-cn-dev-integration，`docs(reference): help-text audits — stamina/gacha/multi vs official help pages`）。
- 官方帮助正文（5 篇，`docs/help/`）：`Equipment_Enhancement.md`（特殊装备强化·总述）、`Equipment_Enhancement_Anamnesis_Weapon.md`（追忆）、`equipment_enhancement_epuration_weapon.md`（歼灭）、`Equipment_Enhancement_Steam_Robot_Weapon.md`（机兵）、`Equipment_Enhancement_Score_Attack_Event.md`（勋章）。帮助树（`docs/help/manifest.json`）：`Equipment_Enhancement_List`（特殊装备强化）→ 5 子页，与主数据 `equipment_enhancement_shop_category` 的 help_id 列逐条对应（含 cat2 全小写 `equipment_enhancement_epuration_weapon`）。
- 实现基准：`/shop/get_sales_list` + `/shop/buy`、`/bulk_buy`（shop_type=10）主链 `src/lib/shop/*`、`src/lib/shop-sales-list.ts`、`src/content/converters/shop.ts`；觉醒链 `src/routes/api/equipment.ts`、`src/routes/api/sell.ts`；持久化 `src/data/domains/equipment.ts`、`src/data/initializers/wdfpData.ts`。
- 客户端证据取自 `wf-1.8.1-cn-decompiled/`（1.8.1 全量反编译，0 错误）为主，`wf-cn-client-as3-20261014/`（补全版）抽查一致（`ShopBuyRealRemote.as` 仅 int 强转差异，`EquipmentEnhancementLogic.as` 逐字节一致）。
- 判定分级：**一致 / 偏差 / 未实现 / 不可对照**（纯客户端行为或无服务端面）。file:line 均为该 commit 下真实可查位置；客户端证据给类名/文件路径。

## 一、5 系实装状态总表（核心悬案判定）

三重证据：a) 帮助文本 b) 客户端 1.8.1 反编译 + CN 主数据 1.4.54 c) 本服端点/数据实现。

| 系统 | 帮助有 | 客户端有 | 我们有 | 判定 |
|---|---|---|---|---|
| 特殊装备强化（总述） | ✓ `Equipment_Enhancement.md` | ✓ 强化商店整套类 + game_system_unlock 解锁链 | ✓ shop_type=10 全链（目录/购买/持久化/回包） | **已实装+已实现** |
| 追忆装备强化（anamnesis_weapon） | ✓ | ✓ cat1（15 装备/75 阶段）+ 客户端类 | ✓ 同链复用 | **已实装+已实现**（含真机验收 2026-07-17，`docs/systems/equipment-upgrade-audit.md`） |
| 歼灭装备强化（epuration_weapon） | ✓ | ✓ cat2（2 装备/2 阶段）+ 客户端类 | ✓ 同链复用 | **已实装+已实现** |
| 机兵装备强化（steam_robot_weapon） | ✓ | ✓ cat3（6 装备/36 阶段）+ 客户端类 | ✓ 同链复用 | **已实装+已实现** |
| 勋章装备强化（score_attack_event） | ✓ | ✓ cat4（6 装备/78 阶段）+ 客户端类 | ✓ 同链复用 | **已实装+已实现** |

判定依据（三列证据的落点）：

**客户端有（1.8.1 CN）**
- 商店类型：`ShopKind.as:20` 枚举含 `EquipmentEnhancementShop`（index 7），`pinball/remote/shop/ShopTypeIdTools.as:56-57` 将其映射为协议 shop_type **10**。
- 端点：`pinball/remote/shop/getSalesList/ShopGetSalesListRealRemote.as:130-136` 请求 `shop/get_sales_list` 携带 `equipment_enhancement_shop_category_ids`（case 7 收集，108-117 行）；`pinball/remote/shop/buy/ShopBuyRealRemote.as:48-51` 请求 `shop/buy` 携带 `shop_type/shop_item_id/number`。
- 数据逻辑：`pinball/common/data/equipmentEnhancement/`（`EquipmentEnhancementLogic`、`EquipmentEnhancementShopCategoryLogic`、`EquipmentEnhancementShopProductLogic`、`EquipmentEnhancementStatusLogic`、`EquipmentEnhancementConfigLogic`）+ master 生成表 12 个 `pinball/master/generated/EquipmentEnhancement*`（6 表 × Table/Values），主数据经 CDN（`master/equipment_enhancement/*.orderedmap`，1.4.54 六表齐备）下发。
- 场景/UI：`pinball/scene/equipmentEnhancement/{top,shop,searchResult}/`、`pinball/dialog/equipmentEnhancement/{EquipmentEnhancementResultDialog,HowToGetEquipmentDialog}.as`、`pinball/ui/dialog/content/DialogEquipmentEnhancementAbilityView.as`、`pinball/ui/component/list/shop/{EquipmentEnhancementTopListLogic,adapter/EquipmentEnhancementTopListAdapter}.as`。
- 运行时消费：`pinball/common/data/player/PlayerLogic.as:3080`（读档解析 `enhancement_level`）、`:3406-3415` `addEquipmentEnhancement()` 每购买 1 次 +1；`pinball/common/data/item/BattleEquipmentLogic.as:36-39`（超出 master 上限抛错 2287）、`:74`（能力按强化等级解锁）、`:123`（外观按强化等级切换）；`pinball/common/data/cooperation/SummonMateTools.as:56,106`（联机 mate 数据解析 `enhancement_level`）。

**我们有（服务端 commit 679f2c67）**
- 协议常量：`src/lib/types/shop.ts:22` `TREASURE_EQUIPMENT = 10 // CN: 追忆装备强化 / 特殊装备强化`。
- 目录：`src/routes/api/shop.ts:57,66,96`（get_sales_list 受理 `equipment_enhancement_shop_category_ids`）→ `src/lib/shop-sales-list.ts:33-90`（按 `category:group:equipment` 分组、以 `enhancement_level` 推当前阶段与剩余库存 `stock_quantity = 阶段上限 - 当前强化等级`）、`:112-124`（目录过滤）。
- 购买：`src/routes/api/shop/purchase-routes.ts:38-47,110,160`（`/buy`、`/bulk_buy` 白名单含 shop_type 10）→ `src/lib/shop/purchase-plan.ts:104-111,301-313`（equipmentEnhancement 效果）→ `src/lib/shop/equipment-enhancement-adapter.ts:21-60`（当前阶段校验 + `planEquipmentEnhancementPurchase`）→ `src/lib/equipment-enhancement.ts:5-25`（新等级 = 当前 + number，限阶段上限、需觉醒等级达标）。
- 持久化与回包：`src/data/initializers/wdfpData.ts:715`（`players_equipment.enhancement_level` 列）；`src/data/domains/equipment.ts:27,89-91,105`；`src/lib/equipment.ts:15-22`（equipment 实体回传 `enhancement_level`）；`src/lib/shop/response-projector.ts:17-28,47-50`（buy 回包 equipment_list）；存档 `src/data/utils/serialize-player.ts:176-181,294` / `deserialize-player.ts:249-256`；联机 `src/multi/types.ts:74`、`src/multi/snapshot/player-snapshot.ts:229,273`、`src/multi/hub/response-validator.ts:248`、NPC `src/multi/npc/builder.ts:24`。
- 数据转换：`src/content/converters/shop.ts:49-51,161-172,373-405,417`（equipment_enhancement_shop/category 两表解析，阶段列、最多 4 组费用列、equipment_id/enhancement_max_level/require_awakening_level）；`src/content/sync/table-registry.ts:687-697`（CDN scope 注册）；`src/lib/shop/catalog.ts:34,276-296,342-350`（目录组装 + 组内按 stage 排序）。
- 测试：`tools/equipment_enhancement.test.cjs`（阶段规划 5 断言）、`tools/shop_purchase_owner.test.cjs:335-373`（当前阶段校验+绝对值回包+落库）、`tools/shop_catalog.test.cjs:76-90`、`tools/shop_sales_list_bulk_reads.test.cjs:70`、`tools/shop_response_projector.test.cjs`、`tools/equipment_batch_reads.test.cjs`、`tools/equipment_dissolve.test.cjs`；内部审计 `docs/systems/equipment-upgrade-audit.md`（跳级缺陷修复记录 + 真机验收通过 2026-07-17）。

主数据侧 4 系齐备（1.4.54，`wf-assets-cn/orderedmap/equipment_enhancement/`）：`equipment_enhancement_shop_category.json` cat1 `anamnesis_weapon`「领主币兑换装备强化」2024-05-23 起、cat2 `epuration_weapon`「歼灭装备强化」2024-07-18 起、cat3 `steam_robot_weapon`「机兵装备强化」2024-08-16 起、cat4 `score_attack_event`「普·莉莉艾的勋章装备强化」2024-09-27 起；`equipment_enhancement.json` 29 件装备（强化上限 99/120，附「·改/·追忆/・无双」名称与外观切换列）；`equipment_enhancement_shop.json` 191 行全部为强化购买（productKind=1）；`equipment_enhancement_status/ability/config.json` 提供逐级 HP/ATP/能力。

## 二、每篇对照表

### 1. Equipment_Enhancement.md（特殊装备强化·总述，26 行）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「使用特殊装备强化道具……不同特殊装备道具强化项目内的可强化装备道具不同」(L5) | 目录 4 分类：`src/content/converters/shop.ts:386`（shopCategoryId）；分组 `src/lib/shop-sales-list.ts:45-52`；阶段序列 `src/lib/shop/catalog.ts:342-350` | 一致 | 分类即 shop_category 1-4，每分类绑定各自装备集合与强化道具（见各篇） |
| 「强化装备道具即可赋予其新能力」(L7) | 服务端持久化 `enhancement_level`：`src/data/domains/equipment.ts:27,105`；能力计算在客户端 `wf-1.8.1-cn-decompiled/scripts/pinball/common/data/equipmentEnhancement/EquipmentEnhancementLogic.as:237-250`（getAbility → EquipmentEnhancementAbilityLogic.createForEquipment） | 一致（服务端面） | 服务端只存/回传等级；新能力数值与解锁由客户端按 master（equipment_enhancement_ability/status）计算，战斗内能力门 `BattleEquipmentLogic.as:74` |
| 「玩家等级达到90后方可解锁特殊装备强化」(L9) | 客户端：`game_system_unlock_condition.json` `condition_equipment_enhancement` 第 16 列 = 90，经 `EquipmentEnhancementShopCategoryLogic.as:143-166`（getUnlockedMessage → game_system_unlock `equipment_enhancement`）本地判定；商品列 `release_rank=90`（`EquipmentEnhancementShopValues.as:57,87,298`）。服务端：**未解析 release_rank**（`src/content/converters/shop.ts:161-174` EQUIPMENT_LAYOUT 无该列），`/shop/buy` 无玩家等级校验（`src/routes/api/shop/purchase-routes.ts:110-155`） | 偏差 | 解锁门槛纯客户端；改机客户端可低于 90 级直接购买（P2-1） |
| 「能进行特殊装备强化的装备道具皆拥有强化等级，对特殊装备进行强化能提升其强化等级」(L13) | `src/data/initializers/wdfpData.ts:715`；`src/lib/equipment-enhancement.ts:19`（newLevel = current + purchaseAmount） | 一致 | 与客户端逐级 +1 语义一致（`PlayerLogic.as:3406-3415`、`ShopBuyDummyRemote.as:132` 按 number 循环调用） |
| 「随着强化等级的提升，能力也将得到进一步强化」(L15) | 逐级数值：主数据 `equipment_enhancement_status.json`（如 5010073: level 98/99/120 → HP/ATP 增量）；客户端 `EquipmentEnhancementStatusLogic` getHpAt/getAtkAt（`EquipmentEnhancementLogic.as:163-170,214-221`） | 不可对照（计算）/一致（存储） | 数值进阶纯客户端；服务端责任面（等级持久化+回包+联机 mate 透传）已实现 |
| 「在达到一定强化等级后，装备将获得新能力，其名称与外观也将发生变化」(L17) | 主数据 `equipment_enhancement.json`（如 5010073 → 「朱安里克·改」+ `sword_0073_raid_lv70` 外观列）；客户端 `EquipmentEnhancementLogic.as:107-147`（getPixelart/getName 按 level 阈值）、`BattleEquipmentLogic.as:123` | 不可对照（显示） | 名称/外观切换纯客户端；29 件装备的改名校验通过（·改/·追忆/・无双） |
| 「在强化特殊装备时需要消耗的道具」(L21) | 费用列解析 `src/content/converters/shop.ts:166`（costStarts [14,16,18,20]，最多 4 组道具费用）；扣费 `src/lib/shop/purchase-owner.ts`（同事务 inventory.deduct） | 一致 | 191 行商品费用全部落转换表（`tools/shop_repository.test.cjs:31` 覆盖该表） |
| 「该类道具能在『追忆试炼』、『极时试炼』及各项活动中获取」(L23) | 素材定义 `wf-assets-cn/orderedmap/item/item.json`（14040 星空记忆晶、14033-14046 记忆石/记忆晶、40401-40412 齿轮/蒸气核、40313 皮那水晶、40503/40504 勋章）；掉落查询 `orderedmap/search/item_quest_search.json`；活动族转换 `src/content/converters/event-family.ts:69`（expert_single_event=追忆试炼）、`:129`（solo_time_attack_event=极时试炼）、`:119`（score_attack_event=无限演武）、`:79`（hard_multi_event=共同决战） | 一致 | 素材由关卡/活动结算的通用奖励链发放；获取途径属主数据/关卡数据面 |
| 「详细请参见各特殊装备强化项目内的帮助内容」(L25) | cat 表 help_id 列（`EquipmentEnhancementShopCategoryValues.as:22`）→ 4 子页帮助 id 与 `docs/help/` 文件一一对应 | 一致 | 帮助内容由 CDN rich_text 下发（`rich_text/help_equipment_enhancement*`），服务端 CDN 透传 |

### 2. Equipment_Enhancement_Anamnesis_Weapon.md（追忆装备强化，14 行）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「可对部分领主币兑换商店内的装备道具及部分活动追加的装备道具进行强化」(L7) | cat1 `anamnesis_weapon`（主数据 shop_category 1，15 件装备/75 阶段，如 5010060 无妨剑→无妨剑·追忆）；服务端统一按 cat 分组 `src/lib/shop-sales-list.ts:45-52` | 一致 | 强化对象集合由主数据下发；服务端按 `equipment_enhancement_shop.json` 全量受理 |
| 「强化后名称将发生变化，并获得新能力。能力将随强化等级提升而获得强化」(L9) | 名称：`equipment_enhancement.json`（无妨剑·追忆 等）；能力：客户端 `EquipmentEnhancementLogic.as:128-147,237-250`；服务端等级持久化同上 | 一致（服务端面） | 同总述 L15/L17 口径 |
| 「强化所必须的特殊装备强化道具能在『追忆试炼』、『极时试炼』及各项活动中获取」(L11) | cat1 费用素材：14040 星空记忆晶（45 行）、14033-14038 记忆石、14041-14046 记忆晶、30028 深渊物质（主数据 `equipment_enhancement_shop.json` 费用列统计） | 一致 | 素材获取属关卡掉落/活动数据面（`item_quest_search.json` 有映射） |
| 「『追忆装备强化』中获得的新能力及装备的新名称将不会显示在能力魂珠之上」(L13) | 魂珠文本为静态主数据：`item/item.json` 5010060 = 「无妨剑魂珠」（不含强化后名称/能力） | 不可对照 | 纯客户端/数据显示面：魂珠物品文案与能力取静态 item/ability soul master，不引用 equipment_enhancement 表；服务端无涉及面 |

### 3. equipment_enhancement_epuration_weapon.md（歼灭装备强化，14 行）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「可对活动『歼灭者讨伐战』中追加的装备道具进行强化」(L7) | cat2 `epuration_weapon`（主数据 shop_category 2，2 件装备：5010070 解放者、5020043 终结者，各 1 阶段）；服务端同链 `src/lib/shop-sales-list.ts:45-52` | 一致 | 歼灭者讨伐战 = world story boss event（epuration）族，事件活动数据齐备 |
| 「装备道具得到强化后其能力也将得到强化」(L9) | 同总述（客户端 status/ability 表 + 服务端等级持久化） | 一致（服务端面） | cat2 商品 max_enhance=99（`equipment_enhancement.json`） |
| 「强化所必需的特殊装备强化道具能在活动『歼灭者讨伐战』中获取」(L11) | cat2 费用素材：40313 皮那水晶（2 行），掉落配置于 `orderedmap/quest/event/world_story_event_boss_battle_quest.json`，并可于 `orderedmap/shop/event_item_shop.json` 兑换 | 一致 | 活动商店（event_item_shop）服务端已实现（`src/lib/shop/catalog.ts` EVENT_ITEM 族） |
| 「另外，歼灭装备将不会生成能力魂珠」(L13) | 主数据 `orderedmap/item/equipment.json`：5020043 终结者 `generate_ability_soul=false`；**但 5010070 解放者 `generate_ability_soul=true`**。服务端觉醒发放按该标志：`src/routes/api/equipment.ts:188-213`（dissolveInfo.generate_ability_soul 门） | 偏差 | 帮助与主数据不一致：解放者数据上可生成魂珠（其 `max_level=1` 实际无法觉醒，故运行时不可达）；服务端忠实按数据实现（P3-1） |

### 4. Equipment_Enhancement_Steam_Robot_Weapon.md（机兵装备强化，14 行）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「可对机兵系列中追加的装备道具进行强化」(L7) | cat3 `steam_robot_weapon`（主数据 shop_category 3，6 件装备/36 阶段：5010073 朱安里克、5020042 哈尔波曼、5070044 亚弗登特、5080032 凯斯莫里、5090047 阿罗朗德涅莫、5100020 哈里萨尔瓦；强化上限 120） | 一致 | 真机已验证的同链（追忆跳级修复即发生在该链路，`docs/systems/equipment-upgrade-audit.md`） |
| 「装备道具得到强化后其能力也将得到强化」(L9) | 同总述 | 一致（服务端面） | — |
| 「强化所需的特殊装备强化道具能在活动『共同决战』中获取」(L11) | cat3 费用素材：40401-40406 属性齿轮、40407-40412 蒸气核、10000095 全能齿轮、10000096 融珠蒸气核 + 追忆素材；共同决战 = hard_multi_event（`src/content/converters/event-family.ts:79`） | 一致 | hard multi advent 关卡族数据齐备（`docs/help/Help_hard_multi_advent_steam_robot_*.md` 同族） |
| 「『机兵装备强化』中获得的新能力及装备的新名称将不会显示在能力魂珠之上」(L13) | 魂珠静态主数据（`item/item.json` 5010073 = 「朱安里克魂珠」，不含「·改」） | 不可对照 | 同追忆篇 L13：纯客户端/数据面 |

### 5. Equipment_Enhancement_Score_Attack_Event.md（勋章装备强化，16 行）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「可从本项目中强化于『普·莉莉艾的勋章』页面中兑换所得的装备道具」(L7) | cat4 `score_attack_event`「普·莉莉艾的勋章装备强化」（主数据 shop_category 4，6 件装备/78 阶段：5010032 天府剑→天府剑・无双 等，强化上限 120）；勋章兑换页为 score attack 活动商店（event_item_shop 内 40503/40504） | 一致 | 无限演武（score_attack_event）活动族服务端已转换（`src/content/converters/event-family.ts:119`、`src/content/converters/quest.ts:37,124,148`） |
| 「强化后名称将发生变化，并获得新能力。能力将随强化等级提升而获得强化」(L9) | 名称：`equipment_enhancement.json`（・无双 系列）；其余同总述 | 一致（服务端面） | — |
| 「强化所需的特殊装备强化用道具主要可从『无限演武』中获取」(L11) | cat4 费用素材：40503 普·莉莉艾的紫勋章（24 行）、40504 普·莉莉艾的黑曜勋章（36 行）+ 记忆石/记忆晶 + 12002 ★5星铁钢 | 一致 | 勋章由 score attack 评价/分数线奖励发放（`orderedmap/quest/event/score_attack_border_reward.json` 等） |
| 「将装备强化至特定等级时，或需要于『追忆试炼』或其他活动中获取的特殊道具」(L13) | 多段费用实证：shop 2002（cat3 阶段2）= 40401×10 + 40407×1 + 14040×10；服务端最多 4 组费用列 `src/content/converters/shop.ts:172`，同事务扣取 `src/lib/shop/purchase-owner.ts` | 一致 | 高阶阶段混入追忆素材（星空记忆晶/记忆晶），与帮助「特定等级需特殊道具」吻合 |
| 「『勋章装备强化』中获得的新能力及装备的新名称将不会显示在能力魂珠之上」(L15) | 魂珠静态主数据（5010032 = 「天府剑魂珠」族，不含「・无双」） | 不可对照 | 同前两篇 |

## 三、差异与问题清单

**P2（应修，有实际协议面影响）**

- **P2-1 玩家等级 90 解锁门槛服务端不校验**（帮助总述 L9）。
  - 证据：客户端权威门槛 = `game_system_unlock_condition.json` `condition_equipment_enhancement` 值 90（客户端 `EquipmentEnhancementShopCategoryLogic.as:143-166` 经 game_system_unlock `equipment_enhancement` 本地判定）；商品行 `release_rank=90`（`EquipmentEnhancementShopValues.as:298` parseAt24）。服务端 `src/content/converters/shop.ts:161-174` EQUIPMENT_LAYOUT 未解析 release_rank 列（落在了 stock 列 25 之外的 24 列），`src/routes/api/shop/purchase-routes.ts:110-155` `/buy` 对 shop_type 10 无玩家等级检查。
  - 影响：正常客户端被 UI 挡住；改机客户端可绕过 rank 门槛直接购买强化（低危——私服作弊面，但与「帮助=规格」不符）。
  - 建议：converter 解析 column 24 为 `releaseRank`，`planEffect`/`prepareEquipmentEnhancementWithinTransactionSync` 内校验 `player.rank >= releaseRank`。

**P3（记录在案）**

- **P3-1 「歼灭装备不会生成能力魂珠」与主数据不一致**（歼灭篇 L13）。`orderedmap/item/equipment.json` 中 5010070 解放者 `generate_ability_soul=true`（5020043 终结者=false）。服务端 `src/routes/api/equipment.ts:188-213` 按标志发放，行为正确；因解放者 `max_level=1` 无法觉醒，运行时不可达。属官方帮助文本与官方数据的历史口径差，不需要改代码，备案即可。
- **P3-2 强化目录（category）期限与解锁仅客户端把关**。cat 表 start/end（2024-05-23/07-18/08-16/09-27）与 `game_system_unlock_id` 均未进服务端转换层（`src/content/converters/shop.ts` 仅用 cat 表做引用完整性校验 `requireCategory`，`:378`）；目录开放由客户端请求的 `equipment_enhancement_shop_category_ids` 驱动，商品级 `availableFrom/availableUntil` 在购买时有服务端校验（`src/lib/shop/purchase-plan.ts:164` resolveEffectiveShopOffer 按虚拟时间取有效期报价）。风险低：即使客户端报了未开放目录，商品仍在自身时间窗外时拒购。
- **P3-3 productKind=0（Normal 商品：直接售卖物品/装备本体）服务端会拒购**。`src/lib/shop/purchase-plan.ts:301-305` 对 shop_type 10 一律要求 `equipmentId` 为正整数，kind=0 行无该列 → 400。1.4.54 数据 191 行全部为 kind=1（强化购买），无实际触发面；若未来主数据出现 kind=0 行需补「普通商品」分支。
- **运行备注（非缺陷）**：默认服务器时间 `timeOffset=2024-08-14 12:00 UTC` 下，机兵目录（2024-08-16 起，商品 `availableFrom` 最晚 2024-10-11）与勋章目录（2024-09-27 起）尚未开放——数据驱动行为与官方时间线一致；调时间策略即可开放，两链路代码完全复用追忆链（已真机验收）。

## 四、结论

1. **核心悬案判定：5 个强化系（特殊/追忆/歼灭/机兵/勋章）在 1.8.1 CN 全部已实装**——帮助文本、客户端 1.8.1 反编译（整套 `EquipmentEnhancement*` 类 + CDN 主数据 6 表）、CN 主数据 1.4.54（4 分类 29 件装备 191 阶段商品）三重证据互洽；本服已按同构协议（shop_type=10 购买 + `enhancement_level` 持久化）实现并通过单元测试与追忆线真机验收。
2. 5 篇逐条对照共 **26 条**：一致 13、一致（服务端面）8、不可对照（纯客户端/数据展示面）5（能力数值进阶、名称/外观切换、魂珠不显示类条款）、偏差 1（rank 90 服务端不校验，P2-1）、偏差 1（歼灭魂珠帮助 vs 数据口径差，P3-1）。无一「未实现」。
3. 服务端责任面（目录下发、阶段校验、多段费用、事务扣费、等级持久化、回包/存档/联机 mate 透传、how-to-get 关联）已闭环；唯一值得补的规格缺口是 **release_rank=90 的服务端校验（P2-1）**，其余为记录性偏差。
