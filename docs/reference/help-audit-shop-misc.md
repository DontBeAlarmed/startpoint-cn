# 帮助文本对照审计 — 商店 + 杂项（Shop / Player / Menu / Other / 回归加成 / Home / Encyclopedia / WorldFlipper）

- 口径：CN 主数据 **1.4.54**（wf-assets-cn）；服务端 **commit 679f2c67e6bc61111fc916dd21dd7791f3c015c1**（worktree starpoint-cn-dev-integration，`docs(reference): help-text audits — stamina/gacha/multi vs official help pages`，2026-11-05）。
- 官方帮助正文：`docs/help/Shop.md`（78 行）、`Player.md`（46 行）、`Menu.md`（139 行）、`Other.md`（28 行）、`Other_Comeback_Bonus.md`（24 行，即任务所称 Other_Return「回归加成」）、`Home.md`（66 行）、`Encyclopedia.md`（19 行）、`WorldFlipper.md`（10 行）；参考节低优先：`Battle_Enemy.md` / `Battle_Skill.md` / `Battle_Ability.md` / `Battle_Yakumono.md` / `Battle_Field_Effect.md`。
- 实现基准：商店链 `src/routes/api/shop.ts`、`src/routes/api/shop/purchase-routes.ts`、`src/lib/shop/*`（purchase-plan/purchase-period/effective-offer/catalog/sales-stock）、`src/lib/shop-sales-list.ts`、`src/content/converters/shop*`；兑换链 `src/routes/api/exchange.ts`、`src/routes/api/specialExchange.ts`、`src/lib/{star-crumb-exchange,bond-token-exchange,special-exchange}/*`；售卖 `src/routes/api/item.ts`、`src/lib/item-sell.ts`、`src/routes/api/sell.ts`；玩家链 `src/lib/stamina.ts`、`src/lib/player-rank-content.ts`、`src/data/domains/player.ts`、`src/routes/api/profile.ts`；任务/练习 `src/lib/quest-content.ts`、`src/lib/stamina-cost.ts`、`src/data/domains/practice-battle-history.ts`、`src/lib/mission/active-*`；回归链 `src/lib/login-bonus.ts`、`src/content/converters/login-bonus.ts`、`src/lib/gacha-owner/player-period.ts`、`src/routes/cn/load.ts`。
- 判定分级：**一致 / 偏差 / 未实现 / 不可对照**（纯客户端行为或无服务端面）/ **一致（数据面）**（由主数据行驱动、服务端提供通用机制）。file:line 均为该 commit 下真实可查位置。
- 装备线已记条款不重复计缺口：特殊装备强化「玩家等级 90 解锁」服务端不校验 = 装备线 P2-1（`docs/reference/help-audit-equipment.md:48,97`），Shop.md 对照中仅交叉引用。

## 一、Shop.md（商店/兑换所/珍奇品商店/礼包/玛纳购买）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「可以购买星导石或玛纳、兑换道具、购买优惠商品」(L5) | 商店类型全集 `src/lib/types/shop.ts:11-23`（11 类）；商品目录 `src/lib/shop/catalog.ts:28-35`；购买 `src/routes/api/shop/purchase-routes.ts:110-158`（/buy）、`160-223`（/bulk_buy）；列表 `src/routes/api/shop.ts:57-131`（get_sales_list） | 一致 | 六张通用商店表 + 活动币/领主币/追忆装备强化/星之粒全部可购；批量购买限 EVENT_ITEM/BOSS_COIN（`purchase-plan.ts:142-148`） |
| 交易所「可以将各种道具兑换成其他道具」(L9) | `src/routes/api/exchange.ts:32-77`（/star_crumb 星之碎片兑换）、`79-119`（/bond_token 信赖之证兑换装备）、`121-152`（列表）；特殊交换 `src/routes/api/specialExchange.ts:33,81,146,206`（enter_campaign/buy_ticket/exchange_character/exchange_equipment）；星铁粒→星铁钢走通用商店道具费用行 | 一致 | 兑换所四族（星之碎片/信赖之证/星铁粒/活动勋章）分别落在专属端点与通用商店道具费用行上，机制全覆盖 |
| 破星结晶碎片兑换「★3、★4、★5 共3种稀有度，无法兑换不同稀有度的破星结晶」(L13) | 商品/费用行数据：`wf-assets-cn/orderedmap/shop/general_shop.json`（11001-11003）；费用校验 `src/lib/shop/purchase-plan.ts:356-372`（costs 按行绑定） | 一致（数据面） | 碎片→结晶的稀有度绑定由商品行本身保证（每行 cost→reward 固定同稀有度），服务端按行扣费发奖，不存在跨稀有度兑换路径 |
| 星铁粒兑换「收集一定数量的星铁粒后即可兑换『★5星铁钢』。星铁钢的库存数量将随今后的更新而追加」(L17-19) | `wf-assets-cn/orderedmap/shop/general_shop.json` 行 210001（★5星铁钢，费用 13001×10）；服务端通用购买/库存 `src/lib/shop/sales-stock.ts:4-13` | 一致（数据面） | 「库存随更新追加」= 内容更新追加商品行，服务端机制无需变更 |
| 普·莉莉艾的勋章兑换「库存数量将在每次举办『竞速活动』『战阵之宴』『狂热激战』时重置…请在各活动的详细通知中查看」(L21-25) | 49100 商品行分布于 `event_item_shop.json` / `general_shop.json`；周期过滤 `src/lib/shop-sales-list.ts:118`（isShopItemAvailable）+ `src/lib/shop/period.ts` | 一致（数据面） | 「每次活动重置」由每期活动发放新周期商品行实现（availableFrom/Until 按期配置）；服务端按时窗过滤展示与购买 |
| 信赖之证兑换「开放角色的所有玛纳板，并将角色等级提高到最高值，即可获得信赖之证（※不包括上限突破）」(L27-29) | 领取：`src/lib/character-growth/commands/receive-bond-token.ts:56-63`（板未完成拒领 BOND_TOKEN_NOT_EARNED）、`86-90`（+1/板）；兑换装备：`src/lib/bond-token-exchange/owner.ts:91-95` | 一致（服务端面） | 信赖之证按玛纳板完成度逐板可领、计数入 player.bondToken；「不包括上限突破」= 门槛不含突破层数（板完成判定本身）；兑换所按 equipped 列表周期开放 |
| 珍奇品商店「可以使用玛纳购买道具。也可以出售道具」(L33) | treasure_shop（ShopType.TREASURE）`src/lib/shop/catalog.ts:29`；玛纳扣费 `src/lib/shop/purchase-plan.ts:268-274`；道具出售 `src/routes/api/item.ts:99-154` + `src/lib/item-sell.ts:34-107`；装备出售 `src/routes/api/sell.ts:152-394` | 一致 | 珍奇品商店玛纳消费还进累计任务事实（`src/lib/shop/purchase-owner.ts:196-218` treasure_mana / 称号 cat5 cond45） |
| 「每种道具设有库存数量」(L35) | stock/dailyStock/monthlyStock/maxFrequency 解析 `src/content/converters/shop/parser.ts:199-200`；余量计算 `src/lib/shop/sales-stock.ts:4-13`；购买校验 `src/lib/shop/purchase-plan.ts:220-235`（validateLimit） | 一致 | stock=-1 表示无限；daily/monthly/total 三维限额齐全 |
| 「每天凌晨5点更新商品」(L37) | `src/routes/api/shop.ts:54`（dailyResetHour 默认 5）；日桶 key `src/lib/shop/purchase-period.ts:19-27`；全局默认 `src/runtime/config.ts:517-519` | 一致 | 每日购买计数按 5 点业务日翻桶，珍奇品每日限量商品随之补满 |
| 购买特殊礼包「可以使用付费星导石购买…无法使用免费星导石购买」(L41-43) | 转换器强制 `src/content/converters/shop/extended-products.ts:77-79`（priceKind 必须为有偿石）、`87`（userCost=PAID_BEADS）；扣费仅扣有偿余额 `src/lib/shop/purchase-plan.ts:288-293` | 一致 | 服务端双保险：主数据转换校验 + 扣费只看 player.vmoney（有偿），免费星导石不可能被消耗 |
| 「部分道具套装设有购买期限或购买次数限制。限定每日…每日早上5点更新。限定每月…每月1日早上5点更新」(L45-47) | 礼包限额列解析 `src/content/converters/shop/extended-products.ts:96-103`（maxFrequency/dailyStock/monthlyStock）；周期 `84-85`；月/日桶 `src/lib/shop/purchase-period.ts:19-29` | 一致 | 月桶按 5 点业务日所属月份生成，1 日 5 点翻转 |
| 领主币兑换「同领主币可兑换的道具种类也有所不同。各道具均有兑换上限。每月1号的凌晨5点将库存数量补充至最大值。持有的道具超过上限时即使有库存也无法兑换」(L51-53) | 上限/月补：BOSS coin 布局 monthlyStock `src/content/converters/shop.ts:117-130`（col 31）+ 月桶 `purchase-period.ts:28-29`；**持有超上限不阻断**：发放走溢出策略转邮件/转玛纳 `src/lib/reward-grant-item-overflow.ts:38-76` | 偏差 | 月度限额与 1 日 5 点补满一致；「持有超上限无法兑换」未实现——兑换照常成功、超量部分按道具策略转溢出邮件或转免费玛纳（见 P3-1，对玩家更宽松） |
| 「每月可兑换的道具种类可能有所不同」(L55) | 月别费用/商品行 `src/content/converters/shop/cost-schedule.ts`；生效行选择 `src/lib/shop/effective-offer.ts:53-65`（costScheduleId + 当月行，缺失/歧义即拒） | 一致（数据面） | scheduleRowsByMonth 按虚拟月取行，同时兜底「缺行/多行」错误 |
| 星之碎片兑换「但是无法兑换已成为伙伴的角色或已持有的装备道具」(L61-63) | 防重校验 `src/lib/star-crumb-exchange/owner.ts:139-146`（playerOwnsCharacterSync/playerOwnsEquipmentSync 拒绝） | 一致 | 与帮助明文一致（gacha 线已记星之碎片经济链 P1，此处不重复） |
| 「※兑换获得的角色与装备道具的数值状态皆为Lv1时的数值状态」(L63) | 奖励发放 `src/lib/shop/purchase-owner.ts:154-163` → reward-grant 角色默认初始值入档 | 一致（服务端面） | 角色入档即 Lv1/0 突破基线；商店商品无携带强化度的语义 |
| 星之粒兑换「使用星之粒可兑换曾在活动中登场的角色以及装备道具及强化道具。※获得的角色或装备道具为Lv1状态」(L67-69) | `src/lib/shop/catalog.ts:33`（star_grain_shop.json）；币种 990008 星之粒（`wf-assets-cn/orderedmap/item/item.json`）；周期内购买同通用链 | 一致（数据面） | 星之粒商店复用通用购买机制，费用行绑定 990008 |
| 玛纳购买「使用付费星导石购买将获得付费玛纳，使用免费星导石购买时将获得免费玛纳」(L75) | mana_shop `src/content/converters/shop/extended-products.ts:108-148`（userCost=BEADS）；扣费免费优先 `src/lib/shop/purchase-plan.ts:275-280`；**玛纳奖励一律入免费玛纳** `src/lib/reward-grant/execution-engine.ts:118-121`（currencyForReward: MANA→freeMana） | **偏差** | 付费星导石部分买到的玛纳也记为免费玛纳——玩家档存在 paidMana 字段且消费链免费优先（`purchase-plan.ts:268-274`），但无任何发放入口产生付费玛纳，帮助明文的免费/付费玛纳分账缺失（见 P2-2） |
| 「无法在『城镇』『主城』『扭蛋』或『菜单』页面购买玛纳」(L77) | — | 不可对照 | 玛纳购买入口限制是客户端页面 UI 约束；服务端面即 mana_shop 购买端点，已实现 |

## 二、Player.md（玩家ID/级别/体力/星导石/玛纳）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「开始游戏后将自动获得9位数的『玩家ID』，玩家ID无法变更」(L7) | `src/utils.ts:112-115`（randomInt(100000000, 999999999) 恒 9 位）；viewer_id 无任何变更端点 | 一致 | 与官方 9 位数口径一致 |
| 「可在『菜单』的『个人资料』中查看玩家ID。玩家ID可用于玩家搜索」(L9) | `src/routes/api/profile.ts:42-104`（get_my_profile）；搜索/关注 `src/routes/api/follow.ts:1-15`（read: lists/search_id，write: add/delete） | 一致（服务端面） | ID 展示与按 ID 搜索关注的服务端面齐备 |
| 「玩家的体力上限会随着表示玩家成长度的『级别（Rank）』提升而增加」(L13) | `src/lib/stamina.ts:11-13`（getMaxStamina）；Rank→上限/恢复加速表 `src/lib/player-rank-content.ts:55-62` | 一致 | 上限随 degreeId（Rank 档）提升 |
| 「每6分钟回复1点体力」(L19) | `assets/config.json:5`（stamina_recovery_seconds=360，APK 官方真值对齐注记）；实时结算 `src/lib/stamina.ts:19-29` | 一致 | 360 秒/点，按真实时间流逝补足 |
| 「玩家级别升级、使用道具或星导石也可以回复体力」(L19) | 升级回复：`src/lib/quest/finish/single-settlement-writes.ts:135-141`；道具：`src/routes/api/item.ts:28-96`（use_item）；星导石：`src/routes/api/shop.ts:133-214`（recover_stamina，费用 50 石/100 点 `assets/config.json:4,6`） | 一致 | 三条回复路径齐全 |
| 「另外，达到一定玩家级别（Rank）时，体力的恢复速度也会提高」(L21) | `src/lib/stamina.ts:21-22`（healRate 折减 recoverySeconds）；分档数据 `src/lib/player-rank-content.ts:27-33,62` | 一致 | 高 Rank 档 healRate 提升回复速度 |
| 「如果体力小于体力最大值，体力条中则会显示回复至体力最大值的所需时间」(L23) | — | 不可对照 | 体力条倒计时为客户端渲染；服务端提供 stamina_heal_time（`src/routes/api/shop.ts:207` 等） |
| 「如果使用回复道具后超出最大值，将停止自动回复体力。可保留的体力上限为999」(L27) | `src/lib/stamina.ts:26-28`（超上限即停止自然回复：maxStamina 取 max(rankMax, 当前)）、`:5`（STAMINA_OVERFLOW_MAX=999）+ `assets/config.json:7`（max_stamina_overflow=999） | 一致 | 自然回复与道具/石回复全部封顶 999 |
| 「玩家级别提升时如体力尚未耗尽，则可超过体力上限进行回复」(L29) | `src/lib/stamina.ts:7-9`（addStaminaWithOverflowCap：min(当前+增加量, 999)，可超 Rank 上限）；升级落库 `single-settlement-writes.ts:135-141,172` | 一致 | 升级回复量=新档上限，可越过旧上限至 999 |
| 「通关关卡可获得『级别经验』。级别经验达到一定值后玩家的级别将会提升」(L33) | `src/lib/quest/finish/battle-settlement-values.ts:112-116,130-131`（rankPoint 累加 + didLevelUp） | 一致 | 体力线审计已记同一条链（help-audit-stamina.md），此处引用 |
| 星导石「分为…『免费星导石』和…『付费星导石』。如果同时持有…将优先使用免费星导石」(L39-41) | 统一扣费原语 `src/lib/economy/free-first-deduction.ts:16-37`；扭蛋 `src/lib/gacha-exec-plan.ts:134-141`（free 先扣、溢出入 paid）；商店 `src/lib/shop/purchase-plan.ts:275-280`；体力回复 `src/routes/api/shop.ts:174-179`；特殊交换购票只扣有偿 `src/lib/special-exchange/owner.ts:204-212` | 一致 | 全部星导石消费点均免费优先；仅特殊交换购票按官方语义只认有偿 |
| 玛纳「如果同时持有付费玛纳和免费玛纳，将优先使用免费玛纳」(L45) | `src/lib/shop/purchase-plan.ts:268-274`（MANA 走 planFreeFirstDeduction(freeMana, paidMana)） | 一致（消费面） | 消费侧正确；但付费玛纳无产出入口（见 Shop.md L75 偏差 P2-2） |

## 三、Menu.md（练习/领取记录/道具/个人资料/关注/设置/成长任务）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 练习「不仅能不消耗体力尝试挑战，并且能确认角色的技能与能力」(L9) | 练习关读取 `src/lib/quest-content.ts:317-320`（getPracticeQuestSync，category 15）；练习行 stamina=0 不入费用表 `src/content/converters/quest.ts:923`；无费用行时 cost=0 `src/lib/stamina-cost.ts:6-8` | 一致 | 体力线审计已记参照（help-audit-stamina.md）；本线核实练习关零体力路径完整（start/finish 不扣、失败不退即无扣） |
| 「练习战斗的结果能在战斗记录中查看。战斗记录中将只保存最新的10场战斗」(L15-17) | 记录：`src/lib/quest/finish/single-settlement-writes.ts:265-270`（PRACTICE finish 落库，未通关记 clearRank=null）；查询：`src/routes/api/history.ts:51-71`；保留 100 条/单次返回 30 条 `src/data/domains/practice-battle-history.ts:14-15` | **偏差** | 记录/查看语义一致，但容量为保留 100、返回 30——比帮助「最新 10 场」宽松（见 P3-2，不影响公平性） |
| 「※中断战斗并未继续挑战则该场战斗不会被记录。※若中断战斗后需要退出战斗…务必返回战斗画面并选择退出」(L19-21) | 仅 finish（accomplished 或失败局）写练习史（`single-settlement-writes.ts:265-270`）；abort 路径无练习史写入 | 一致（服务端面） | 中断/退出不产生记录；「务必返回战斗画面退出」为客户端操作引导 |
| 领取记录「可以查看最近的500条记录。获得道具或角色一周后，历史记录将被删除」(L27-29) | `src/data/domains/mail.ts:326-356`（getReceiveHistorySync/PageSync：7 天窗 + LIMIT 500）；后台保留任务 `src/lib/receive-history-retention.ts:3-5`（默认 31 天/500 行批量清理） | 一致（服务端面） | 查看面 = 最近 7 天、至多 500 条，与帮助一致；后台物理保留 31 天仅为清理节奏（记录性，不构成偏差） |
| 道具「可以查看拥有的道具清单和数量，也可以进行交易出售」(L35) | 出售：`src/routes/api/item.ts:99-154` → `src/lib/item-sell.ts:34-107`（sellable 校验、数量校验、能力魂保护 3 个、玛纳容量口径） | 一致 | 出售所得入免费玛纳并结算累计任务 |
| 「道具的稀有度为★1到★5，可以通过道具图标的背景颜色来进行判断」(L37) | — | 不可对照 | 稀有度图标/底色为客户端渲染 |
| 装备觉醒/一览「显示『角色』的『装备觉醒/一览』」(L43) | 装备线已全量对照：`docs/reference/help-audit-equipment.md` | 引用 | 不重复 |
| 持有星导石/玛纳「同时拥有免费和付费星导石/玛纳时会优先使用免费」(L49) | 同 Player.md L39-41/L45 两行 | 一致 | 同上 |
| 个人资料「可以查看玩家自身的角色ID以及进行称号替换，玩家名和简介信息的编辑」(L53) | 改名 `src/routes/api/profile.ts:399-427`（20 字截断）；简介 `368-396`（100 字截断）；称号读取/替换 `240-314`（未持有所属称号即拒） | 一致 | 三件套齐备；长度上限与官方文案限制见 `assets/config.json`（name/comment 长度已按 APK 校正） |
| 「编辑完成的角色资料将成为角色资料卡…其他玩家可以看到您的玩家名和简介信息」(L55-57) | 他人档案 `src/routes/api/profile.ts:107-214`（get_profile：name/comment/rank/degree/follow_state） | 一致（服务端面） | 未知目标回退 stub 档案防客户端崩溃（134-166 注释） |
| 关注/被关注「可以看到自己关注的玩家和关注自己的玩家。还可以输入玩家角色ID，搜索并关注对方」(L61-63) | `src/routes/api/follow.ts:1-15`（lists/search_id/add/delete/delete_followed/bulk_edit）；关系存储 `src/data/domains/social-follow.ts` | 一致 | SNS(Twitter) 搜索不在范围（follow.ts:8 注释，跨服不可解析） |
| 「…一起合作战斗挑战领主，将额外获得『关注奖励』的分数奖励。互相关注的玩家…次数越多…越多」(L65-67) | `src/lib/follow-bonus.ts:19-38,46-79`（每局 +10、上限 1,000,000、start 响应 follow_bonus_info） | **偏差** | 官方=互关才有奖励；本服任一方向关注边即计分（multi 线 P2-2 已记，`docs/reference/help-audit-multi.md:67`），交叉引用不重复计 |
| 设置（声音/游戏设置/通知设置/救援请求设置）(L71-107) | — | 不可对照 | 全部为客户端本地设置；服务端仅 user_option 透传（`src/routes/cn/load.ts:115-119`） |
| 下载设定（全部下载/部分下载）(L109-117) | — | 不可对照 | 客户端资源下载策略；服务端面为 CDN/版本校验（CN 线另有实现） |
| 成长任务「分为『入门篇』『初级篇』『中级篇』『高级篇』4各阶段。必须完成所有当前阶段的任务后才能够继续挑战下一阶段的任务」(L124-126) | 成长任务=active_mission 域：`wf-assets-cn/orderedmap/active_mission/active_mission.json`（11010-14110 组 stage 列 1-4，每组 11 任务）；前置引用 `src/lib/mission/active-plan.ts:38-52`（need/show → {missionId, stage}）；评估/发放 `src/lib/mission/active-core.ts:61-116`、`src/routes/api/activeMission.ts:26,116` | 一致（数据面） | 4 阶段与「先完成当前阶段」由主数据 need 链驱动；服务端负责进度评估与奖励领取 |
| 「玩家可在成长任务画面中查看任务内容及领取奖励」(L132) | `src/routes/api/activeMission.ts`（receive/领奖 + 列表） | 一致 | — |
| 「※在完成所有任务并领取奖励后主城画面中将不再出现成长任务浮窗」(L134) | — | 不可对照 | 主城浮窗为客户端 UI（load.ts:131 `mission_tips=false` 为 CN 开关） |
| 「※成长任务中指定的『领主战斗』不包括活动领主战斗」(L138) | 任务条件按 pattern/questRange 派生（`src/lib/mission/active-fact-evaluator.ts:129`） | 不可对照（数据面） | 条件适用范围由主数据 questRange 定义，服务端按表评估，不含活动领主为数据事实 |

## 四、Other.md（日期变更/官方网站/睡眠模式/清除缓存）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 日期变更「每天凌晨5点」(L7) | `src/runtime/config.ts:517-519`（DAILY_RESET_HOUR 默认 5）；各链统一传入（`src/cn-server.ts:366-387`） | 一致 | 全服业务日 5 点翻桶 |
| 「『登录奖励』、『珍奇品商店』和『1天1次限定付费扭蛋』等内容会在这个时间更新」(L9) | 登录奖励：`src/routes/cn/load.ts:242-270`（settleLoginBonusesSync 按日桶）；珍奇品商店：`src/routes/api/shop.ts:54` + `src/lib/shop/purchase-period.ts:19-27`；每日付费一次扭蛋：日状态重置 `src/data/domains/player.ts:1318` → `src/data/domains/gacha-state.ts:217-229`，购买校验 `src/lib/gacha-exec-plan.ts:143-144` | 一致 | 三者均锚定 5 点业务日 |
| 官方网站「可在官网查看…最新信息」(L11-13) | — | 不可对照 | 客户端外链 |
| 睡眠模式（版本更新/自动播放等不进入休眠）(L15-17) | — | 不可对照 | 设备行为，客户端 |
| 清除缓存（标题菜单按键，不删除玩家数据）(L19-27) | — | 不可对照 | 客户端缓存管理；服务端无面 |

## 五、Other_Comeback_Bonus.md（回归奖励——复核后判定）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「玩家在一天中的第一次登录距离上一次登录已超过60天的情况下，将为玩家发动『回归奖励』」(L5) | 全库 grep（回归/return_bonus/return-bonus/comeback/regression/rejoin + is_comeback + inactivity）：唯一登录时知悉间隔的链路是登录奖励 `src/lib/login-bonus.ts:150-167`（comebackInactivityDays，天数由主数据配置，非固定 60）；`user_info.is_comeback` 恒 false（`src/routes/cn/load.ts:108`）；无 60 天硬编码、无回归状态置位 | **未实现** | 回归判定本身缺失：is_comeback 永不为真，回归态无服务端载体（见 P2-1） |
| 回归扭蛋「回归玩家能够抽取期限为3天的特殊扭蛋」(L9-11) | 机制底座已备：isComeback 池定义 `src/content/converters/gacha.ts:453`；玩家期读取 `src/lib/gacha-owner/player-period.ts:40-48`（无期即不可抽）；存储/校验 `src/data/domains/gacha-state.ts:131,156-180`、`src/lib/gacha-owner/save-validation.ts:41-66`；**发放触发缺失**：`grantPlayerComebackGachaPeriodSync`（`player-period.ts:65-77`）全库无调用方（仅 `src/lib/gacha-owner/index.ts:28` re-export 与 `tools/gacha_write_transaction.test.cjs:78,544,1035` 测试） | **未实现（触发缺失）** | 回归扭蛋可被表达、可被抽取（含 3 天期窗口语义由 period 起止承载），但没有任何 60 天回归触发会为玩家开期——实际永远不可达（见 P2-1） |
| 回归加成「1天3次的『领主加成点数』将变为5倍，即1天15次。包括回归当天在内…持续7天」(L13-17) | 加成点数每日硬编码回 3：`src/data/domains/player.ts:1305-1306,1362-1363`；消耗：`src/lib/quest/finish/battle-settlement-values.ts:136-139`；load 响应 `comeback_campaign_boss_boost` 恒 `{period_start_time:0, period_end_time:0}`（`src/routes/cn/load.ts:154`）；无 5 倍/7 天回归窗任何代码 | **未实现** | 加成点数日常 3 次/天已实现，回归期 5 倍（15 次/天）×7 天完全缺失；客户端协议字段被占位为 0（见 P2-1） |
| 回归礼物「回归玩家将收到特别道具套装作为礼物。『回归礼物』将在回归加成发动的第一天赠送给玩家」(L19-23) | Comeback 类登录奖励组：类型 `src/content/converters/login-bonus.ts:26-30`（Comeback/ComebackAlways/ComebackCn/ComebackJp）；不活跃天数条件 `333-337` + 校验 `108-118`；资格判定 `src/lib/login-bonus.ts:150-167`（含条件期 + ≥N 天未登录）；接入登录流程 `src/routes/cn/load.ts:242-270` | 部分实现 | 唯一落地的回归链路：主数据若配置 Comeback 登录奖励组（含 comebackInactivityDays 与道具套装条目），回归首登即可发礼；但依赖运营数据且与「回归加成发动」无耦合（回归加成本身未实现，见 P2-1） |

**复核结论（对应任务 4）**：`grep -rniE "回归|return.?bonus|comeback|rejoin"` 全库复核后，服务端**没有任何以 60 天未登录为触发的回归奖励实现**：`is_comeback` 恒 false、`comeback_campaign_boss_boost` 恒零、加成点数每日恒回 3。存在的只是两块可复用底座——①Comeback 登录奖励组（可承接「回归礼物」，数据驱动、已接入登录）；②isComeback 扭蛋池与玩家期存储（可承接「回归扭蛋」，但触发函数零调用）。按任务口径记 **P2 缺口（回归玩家加成）**。

## 六、Home.md（主城）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「《世界弹射物语》的基础界面…显示角色」(L5-13) | — | 不可对照 | 主城 UI/角色展示/语音为客户端 |
| 公告「可以查看目前进行中的活动信息、更新信息以及Bug修正情况」(L17) | `src/routes/api/news.ts:52-124`（index/get_info/system_index/get_system_info） | 一致（服务端面） | 公告内容分发；内容运营面 |
| 邮件「游戏内的礼品等将被发送至『邮件』。已到达领取期限的邮件会根据先旧后新的原则进行自动删除」(L21-23) | 邮件域 `src/data/domains/mail.ts`；过期清理 `129-130`（deleteExpiredPlayerMailsSync）；未领取计数 mail_arrived（动态） | 一致（服务端面） | 「先旧后新删除」= 按期限过期清理，已实现 |
| 任务「可以通过满足对应任务条件来获得任务奖励」(L27) | mission 体系（成长任务见 Menu.md 节；日常/周常/称号/活动任务 `src/lib/mission/`） | 一致 | 引用 Menu.md 成长任务行 |
| 登录奖励「每天登录一次，即可领取道具奖励」(L31) | `src/routes/cn/load.ts:242-270`（每日首登结算，5 点业务日桶） | 一致 | — |
| 救援请求「可以通过点击页面左上方显示的铃铛标志，来查看参加领主战以及活动关卡的救援请求」(L35-37) | `src/routes/api/attention.ts:40-188`（check/action/logger，attention_key 发放与校验）；多人接入 `src/multi/http/battle.ts:94-106` | 一致（服务端面） | 铃铛/招募链路在 multi 线已对照（help-audit-multi.md） |
| 「主线章节关卡通关后，可以收到该章节对应解锁领主的『救援请求』」(L37) | 招募创建/解锁触发在 multi/attention 链 | 不可对照（本线） | 归 multi 线；本线不逐条核对 |
| 「响应救援请求而加入领主战时不会消耗体力」(L53) | `src/multi/http/battle.ts:264-266`（guest 只按关注关系计费，无 rescue 免体力分支） | **未实现（交叉引用）** | 与 Battle_Boss.md L33 同一条款，multi 线 P1 已记（`docs/reference/help-audit-multi.md:30,84-86`），不重复计数 |
| 史黛拉的弹射讲座/弹射小世界（漫画）(L57-61) | `src/routes/api/comic.ts:26`（漫画分发，`web/public/comic/` gitignored） | 不可对照（内容分发） | 阅读为客户端 |
| 城镇（L63-65） | — | 不可对照 | 客户端 UI |

## 七、Encyclopedia.md（图鉴）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「能够收集…关键字并在图鉴中阅览」(L5) | `src/routes/api/encyclopedia.ts:55-87`（/index 全量下发 `encyclopedia.json`，`src/lib/encyclopedia-content.ts:10-33`） | 偏差（记录性） | 服务端把全部关键字按 `read:true` 恒定下发——不持有解锁状态，图鉴解锁显示完全依赖客户端本地判定（见 P3-3） |
| 「关键字…随着『获得新角色』『阅读特定的主线故事、活动故事及角色故事』、『解锁特定关键字』等相继解锁」(L13) | 无服务端解锁模型（/index 恒全开；`read_keyword` `src/routes/api/encyclopedia.ts:22-53` 仅回显 read:true） | 未实现（服务端面） | 解锁条件判定与状态无服务端载体；纯客户端行为下不影响单机体验（见 P3-3） |
| 「记录秘钥：每使用一个即能解锁一个未满足开放条件的关键字。记录秘钥能通过活动获取或在商店中兑换获得」(L17-19) | 道具 49200 encyclopedia_point 存在（`wf-assets-cn/orderedmap/item/item.json`）且 star_grain_shop 有其兑换行；「使用记录秘钥」无服务端消耗端点（use_item 仅体力类等） | 未实现（服务端面） | 道具可获得、可持有；「使用解锁关键字」无服务端语义（随 P3-3） |
| 「是否获取部分联动角色将不影响图鉴收集率」(L7) | — | 不可对照 | 收集率计算在客户端 |

## 八、WorldFlipper.md（世界观）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 全文为世界观故事介绍（L5-9） | — | 不可对照 | 纯文本，无服务端面 |

## 九、参考节 — 战斗机制余篇（Battle_Enemy / Battle_Skill / Battle_Ability / Battle_Yakumono / Battle_Field_Effect）

按任务口径不做逐条对照，仅列**可服务端落地的点**：

1. **结论先行**：5 篇均为客户端战斗演算规格（本服采用 seed 校验架构，服务端不复算战斗过程），无新增服务端落地缺口。
2. 唯一服务端可见结算点：Battle_Yakumono.md L91「通关关卡后可领取战斗中获得的玛纳」——场地玛纳入结算：`src/lib/quest/finish/battle-settlement-values.ts:110-111`（fieldMana 并入 manaObtained）+ `single-settlement-writes.ts:145-173`（容量口径与溢出邮件）。**已实现**。
3. Battle_Enemy.md（行动变化/行动转换/弱点/强弱点/眩晕/伤害检测/伤害共享/防御性攻击）、Battle_Skill.md（技能槽 200% 上限、充能加速上限、棺柩计数、协力球等）、Battle_Ability.md（区域延续/棺柩状态能力）、Battle_Field_Effect.md（领域效果/连击加成/能量转换）——全部由客户端演算并随主数据（`wf-assets-cn/orderedmap/battle/`、`ability/`、`skill/`）分发，服务端只承担内容分发与 seed 防作弊（`docs/protocol/seed-verification.md`），无需按帮助条款另建服务端逻辑。

## 十、差异与问题清单

### P2

- **P2-1 回归玩家加成整链缺失**（Other_Comeback_Bonus.md L5/L9/L13-17）。
  - 证据：`src/routes/cn/load.ts:108`（is_comeback 恒 false）、`load.ts:154`（comeback_campaign_boss_boost 恒 {0,0}）、`src/data/domains/player.ts:1305-1306,1362-1363`（加成点数每日硬编码回 3）、`src/lib/gacha-owner/player-period.ts:65-77`（回归扭蛋开期函数零调用，全库仅测试引用 `tools/gacha_write_transaction.test.cjs:78,544,1035`）。
  - 影响：回归玩家拿不到回归扭蛋（3 天期限池）、领主加成点数 5 倍 ×7 天、回归礼物仅在主数据恰好配置 Comeback 登录奖励组时才可能发放；回归用户体验整体缺位。
  - 备注：机制底座（isComeback 池 + 玩家期存储 + Comeback 登录奖励组）均已就位，缺口集中在**触发与倍率**——需要「上次登录距今 ≥60 天 → 置 is_comeback、开回归扭蛋期（3 天）、写 comeback_campaign_boss_boost（7 天）、加成点数日重置改为回归窗内 15」。
- **P2-2 星导石购买玛纳不区分免费/付费玛纳**（Shop.md L75）。
  - 证据：`src/lib/shop/purchase-plan.ts:275-280`（BEADS 免费优先混扣）+ `src/lib/reward-grant/execution-engine.ts:118-121`（MANA 奖励恒入 freeMana）；player.paidMana 字段与免费优先消费链存在（`purchase-plan.ts:268-274`）但无产出。
  - 影响：与帮助明文「付费星导石购买将获得付费玛纳」不符；因本服玛纳消费恒免费优先，玩家实际不受损，属规格保真缺口而非经济漏洞。

### P3

- **P3-1 商店兑换「持有超过上限时无法兑换」未按帮助阻断**（Shop.md L53，领主币节；同类语义覆盖各商店）。
  - 证据：购买不校验持有容量，超量按道具策略转溢出邮件或转免费玛纳：`src/lib/reward-grant-item-overflow.ts:38-76` + `src/lib/shop/purchase-owner.ts:154-163`。
  - 影响：对玩家更宽松（兑换不失败），无资产损失；与官方「无法兑换」语义不同，记录性偏差。
- **P3-2 练习战斗记录容量 100/30**（Menu.md L17「只保存最新的10场」）。
  - 证据：`src/data/domains/practice-battle-history.ts:14-15`（RETAIN 100 / RETURN 30）。
  - 影响：比帮助宽松，纯记录展示差异。
- **P3-3 图鉴关键字解锁与记录秘钥无服务端建模**（Encyclopedia.md L13/L17）。
  - 证据：`src/routes/api/encyclopedia.ts:22-53`（read_keyword 回显）、`55-87`（index 恒全开）、`src/lib/encyclopedia-content.ts:10-33`。
  - 影响：解锁显示依赖客户端本地数据；改机客户端可「全图鉴已读」，无资产/进度风险（关键字仅观赏性内容）。

### 记录性（不计缺口）

- 领取记录后台物理保留 31 天/500 行（`src/lib/receive-history-retention.ts:3-5`），查看面 7 天/500 条与帮助一致。
- Menu.md 关注奖励单向计分偏差 = multi 线 P2-2（`help-audit-multi.md:67`）；救援响应免体力缺失 = multi 线 P1（`help-audit-multi.md:30,84-86`）；本线不重复计数。
- Shop.md 特殊装备强化「等级 90」服务端不校验 = 装备线 P2-1（`help-audit-equipment.md:48,97`）。
- 星之碎片（star_crumb）兑换点数转换目的地错发问题 = gacha 线 P1（`help-audit-gacha.md:51,59-62`），不在本线范围。

## 十一、结论

1. 本线 8 篇帮助逐条对照（战斗参考 5 篇只列参考点，不计数）共 **72 条**：一致 43（其中标注「服务端面」10、「数据面」6）、部分实现 1（回归礼物·登录奖励链路）、偏差 5（P3-1 领主币持有上限、P2-2 玛纳购买分账、P3-2 练习记录容量、图鉴 index 恒开、关注奖励交叉引用=multi 线 P2-2）、未实现 6（回归判定/回归扭蛋触发/回归加成 5 倍、救援免体力交叉引用=multi 线 P1、图鉴解锁/记录秘钥）、不可对照 16（纯客户端 UI/设备行为/世界观文本）、引用 1（装备觉醒/一览→装备线）。另交叉引用既有审计结论 2 处（multi 线 P1/P2-2、装备线 P2-1），均不在本线重复计缺口。
2. **回归加成判定（任务 4 明确要求）**：复核 grep 后确认服务端**没有** 60 天回归触发、回归扭蛋自动开期与领主加成点数 5 倍 ×7 天的任何实现（is_comeback 恒 false、comeback_campaign_boss_boost 恒零、加成点数日重置恒 3）；仅 Comeback 登录奖励组（可承接回归礼物）与 isComeback 扭蛋机制底座存在。记 **P2-1 缺口**。
3. 商店线整体实现度高于预期：11 类商店、三维限额、日/月 5 点翻桶、月别费用表、特殊礼包强制有偿石、星之碎片防重、信赖之证按板领取——与帮助条款逐一对得上；已知装备线 P2-1（等级 90）之外无新增 P1/P2 级商店缺口。
4. 玩家线（ID/体力/免费优先）与帮助完全对齐，且恢复/上限数值有 APK 官方真值锚定（`assets/config.json` 注记）。
