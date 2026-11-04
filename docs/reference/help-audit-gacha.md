# 帮助文本对照审计 — 扭蛋（Gacha）

- 口径：CN 主数据 **1.4.54**（wf-assets-cn）；服务端 **commit c9613534**（worktree starpoint-cn-dev-integration，`feat(tools): add in-game help extractor`）。
- 官方帮助正文：`docs/help/Gacha.md`（来源 rich_text/help_gacha，全文 50 行）。
- 实现基准：`src/lib/gacha-owner/*`（execute/crazy/model/save-validation/conversion/exchange）、`src/lib/gacha-ticket.ts`、`src/lib/gacha-rules.ts`、`src/lib/gacha-exec-plan.ts`、`src/lib/gacha-catalog/`、`src/routes/api/gacha.ts`、`src/lib/star-crumb-exchange/`、`src/lib/special-exchange/`、`src/data/domains/gacha*.ts`。
- 客户端对照证据取自 `wf-cn-client-as3-20261014/`（1.8.1 补全版反编译），交叉核对 `wf-2.1.125-cn-decompiled/`、`wf-0.0.81-en-decompiled/` 与 `wf-assets-cn/` 内容表。
- 判定分级：**一致 / 偏差 / 未实现 / 不可对照**（客户端表现或外部依赖未实装）。file:line 均为该 commit 下的真实位置。
- 术语对齐（客户端证据）：`star_crumb` 玩家计数器 = **星之碎片**（`DummyPlayerLogic.as:420`「星之碎片不足 拥有: get_starCrumb()」）；道具 **990008** = **星之粒**（`wf-assets-cn/orderedmap/item/item.json` star_grain）。两种币种在 CN 数据里并存且分属两个商店页，本审计严格按此口径。

## 一、对照表

### 1. 基础抽取（Gacha.md L5-L13）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「使用星导石或者扭蛋券来进行扭蛋抽取」(L5) | 石：`src/lib/gacha-exec-plan.ts:131-151`（FREE_VMONEY 有偿兜底 @136-138；VMONEY 纯有偿 @149）；券：`src/lib/gacha-exec-plan.ts:153-193`；入口 `src/routes/api/gacha.ts:89`（/exec） | 一致 | 三条支付路径（无偿石+有偿石混合、纯有偿石、券）均实现；扣款与发奖同事务（`src/lib/gacha-owner/execute.ts:79,240-244`） |
| 「有"1天1次限定付费扭蛋"、"1次抽取"、"10连抽取"等选项」(L7) | 1天1次：`src/lib/gacha-exec-plan.ts:142-151`（execType 5=DAILY_SINGLE，费用 `paidVmoneyCost` @69-80 取 page.kind===0 的 `dailyPaidCost`，主数据 gacha.json 行 7，如 normal_1=50）；单抽/十连：`src/lib/gacha-exec-plan.ts:133-139`（VMONEY_SINGLE/VMONEY_MULTI，十连 pullCount=10）；枚举 `src/lib/gacha-rules.ts:10-25` | 一致 | 「等选项」含疯狂十连（execType 14，`src/lib/gacha-owner/crazy.ts`）与账号限次十连（execType 7），帮助未展开，不单列 |
| 「1天1次限定付费扭蛋」每天限 1 次 | 门槛：`src/lib/gacha-exec-plan.ts:143-144`（`!isDailyFirst` → 拒绝）；消费后置 false：`src/lib/gacha-owner/execute.ts:304-308`；每日重置：`src/data/domains/gacha-state.ts:217-230`（is_daily_first=1）由 `src/data/domains/player.ts:1318` 在跨日登录结算时调用 | 一致 | **注意：限次闸门是 `players_gacha_info.is_daily_first`，不是 `daily_one_count`**（见 §4 P3 说明）；且该抽只能扣有偿石（@149 `plan.paidVmoney -= cost`，不向无偿石溢出） |
| 「重复获得的角色或装备会增加对应的角色或装备的重复数」(L9) | 角色重复→stack+1：`src/lib/character.ts:107-116` → `src/lib/character-growth/commands/grant-character-stack.ts:62-101`（@74 stack+1；@16-26 同时发放重复补偿觉醒道具 14001-14018，3★/4★=1、5★=3）；装备重复→stack+1：`src/lib/equipment.ts:83-86` | 一致 | 重复数即 characters/equipments 的 `stack` 列；超出上限的转换见 §4 星之粒行 |
| 「一键跳过按钮／跳过已成为伙伴的★3、★4、★5角色的登场动画」(L11-13) | 服务端只产出登场动画计划：`src/lib/gacha.ts:53-72`（planCharacterGachaMovies，movieId+seed）；跳过判定 `isAllSkippable` 由客户端计算（`wf-cn-client-as3-20261014/scripts/pinball/loading/gacha/GachaLoadingTaskBase.as:190-230`） | 不可对照 | 客户端表现行为；服务端无对应条款可实现（已按不可对照标注） |

### 2. 扭蛋券（Gacha.md L15-L32）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「"扭蛋券"有1次抽取和10连抽取两种」(L19) | `src/lib/gacha-ticket.ts:83-119`（单抽 `pullCount=useTicketCount` @107-115；十连 `pullCount=useTicketCount*10` @98-106）；券道具族 `GACHA_TICKET_ITEM_IDS` @4-10；通用券类型表 `wf-assets-cn/orderedmap/item/gacha_ticket_type.json`（1/10 连 × 角色/装备 4 类） | 一致 | 单抽券可 1~10 张连用（`src/lib/gacha-rules.ts:163-169` numberOfExec≤10） |
| 「如果同时持有星导石和扭蛋券，将优先使用扭蛋券」(L21) | 服务端按客户端上送的 `payment_type`/`type` 结算：`src/routes/api/gacha.ts:18-24,30-43`；付款→执行类型匹配门 `src/lib/gacha-rules.ts:107-118`；券选择（配置券→通用券回退）`src/lib/gacha-exec-plan.ts:153-192` | 不可对照（客户端行为）／服务端一致 | 「优先用券」是客户端按钮默认策略：`GachaLogic.getPaymentType`（`wf-cn-client-as3-20261014/scripts/pinball/common/data/gacha/GachaLogic.as:951-975`）把券类 exec（3/4/9/10/12/13/14/20）映射 paymentType=3、石类（1/2）→1、付费（5/7）→2，持有券时券按钮才出现/可点（`wf-cn-client-as3-20261014/scripts/pinball/scene/gacha/top/common/GachaSceneBase.as:1080-1100` drawGacha）。服务端两条支付路径并存、互不强制，与该条款无冲突 |
| 「1天1次限定付费扭蛋无法使用扭蛋券」(L23、L30) | 结构性强制：DAILY_SINGLE（execType 5）只允许 paymentType=VMONEY（`src/lib/gacha-rules.ts:111-117` paymentMatches；TICKET 要求 `getTicketDrawKind(execType)≠null` @41-56，5 不属券类）；账号限次页（pageKind=1）只允许 VMONEY+ACCOUNT_PAID_MULTI（@127-129） | 一致 | 客户端同构：`GachaLogic.getPaymentType` 5→2（付费石）。通用券道具描述亦自证「只能用付费星导石抽取的扭蛋池无法使用」（`wf-assets-cn/orderedmap/item/item.json` 999001/999003 说明列） |
| 「部分活动中可能会发放活动专用扭蛋券」(L25、L32) | 配置券路径：`src/lib/gacha-ticket.ts:67-81`（`onceTicketItemId`/`tenTicketItemId`/`crazyTenTicketItemId` 来自主数据 `src/content/converters/gacha.ts:441-443`）；专用券池页（TICKET_ONLY/ONE_TIME_TICKET_ONLY/TEN_TIMES_TICKET_ONLY/CRAZY）`src/lib/gacha-rules.ts:130-146` | 一致 | 券的发放端在任务/活动奖励链（不在本篇范围）；抽取端按池配置票实现完备 |
| 「持有复数扭蛋券时系统将优先显示剩余时间最短的扭蛋券的有效时间」(L27) | — | 不可对照 | 纯客户端展示排序。服务端券为计数道具（players_items 数量），无逐张有效期模型；券有效期存于道具主数据（item.json 起止列），展示排序无服务端语义 |
| 「扭蛋券中同时存在无限期扭蛋券」(L29) | 通用券为长期道具：`wf-assets-cn/orderedmap/item/item.json` 999001/999003/999004/999005 有效期 2015-12-31→2199-12-31；服务端不过滤道具有效期，持券即可用（`src/lib/gacha-exec-plan.ts:154-192`） | 一致 | 另有「持券延长卡池」机制：`src/lib/gacha-catalog/request-plan.ts:69-76`（banner.ticketExpiryTime 内持券可抽）、`src/lib/gacha-owner/availability.ts:54-58`，帮助未提及，不判偏差 |

### 3. 星之碎片（Gacha.md L34-L44）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「使用付费星导石抽取扭蛋…时可获得（星之碎片）」(L36) | 付费抽取扣费链：`src/lib/gacha-owner/execute.ts:144`（buildGachaExecPlan 调用，VMONEY 分支在 `src/lib/gacha-exec-plan.ts:142-151`）与扣费落库 @240-244 —— 全路径**无任何 star_crumb 发放**；`grep -rni "star_fragment|starFragment|星之碎片" src/` 0 命中 | 未实现 | 见 P2-1。客户端已具备接收面：exec 响应后 diff `get_starCrumb()-beforeStarCrumb`（`GachaExecRealRemote.as:63,119`）并弹「获得了星之碎片×N」 |
| 「购买附带扭蛋券的礼包…可获得」(L36) | IAP 履约不存在：`src/routes/cn/load.ts:133`（`simple_payment_item_list=[]`）、`:152`（rebate stub） | 不可对照（IAP 未实装） | 主数据已定义礼包内容：`wf-assets-cn/orderedmap/payment/android_payment.json` stonepack_GachaTicket「…购买后获得星之碎片×20」；邮件原因 45「扭蛋券购买特典的星之碎片」（`orderedmap/mail/reason.json`） |
| 「购买特别角色兑换扭蛋套装时可获得」(L36) | 特别交换购票只扣有偿石并发券：`src/lib/special-exchange/owner.ts:201-235`（@204 余额校验、@211-212 扣 `player.vmoney`、@224-233 发放自选券+十连券）——无 star_crumb 发放 | 未实现 | 归入 P2-1（同一获取链缺失） |
| 「每累计使用75个付费星导石可获得1个"星之碎片"」(L38) | 全库无付费石累计消耗计数器：`grep -rn "totalPaid|paid_total|paidUsed|stoneUsed" src/` 0 命中；亦无 75 阈值常量 | 未实现 | 见 P2-1 |
| 「1天1次限定付费扭蛋中，角色抽选可获得2个，装备抽选可获得1个」(L40) | DAILY_SINGLE 成功路径 `src/lib/gacha-owner/execute.ts:246-275`（奖励发放）无按 execType 5 的 star_crumb 加发 | 未实现 | 同 P2-1 |
| 「获得的星之碎片可通过邮件领取」(L42) | 领取链就绪：`src/data/domains/mail.ts:15`（MailType.STAR_CRUMB=7）→ `src/lib/mail-reward-grant.ts:288-289`（入 starCrumb 余额）、@305-315（超 `max_star_crumb` 容量拒绝）、@337-338（回包 `user_info.star_crumb`）；溢出改邮件 `src/lib/mail-overflow.ts:145` | 一致（链路）／未实现（来源） | 现存唯一发放方是池关闭转换溢出邮件（`src/lib/gacha-owner/conversion.ts:84-90`）——即 P1 所述错币种链路；官方三类来源（抽取累计/礼包/套装）均无 |
| 「收集到的星之碎片，可以在"商店"→"星之碎片兑换"中兑换角色或装备道具」(L44) | `src/routes/api/exchange.ts:32-67`（POST /exchange/star_crumb）→ `src/lib/star-crumb-exchange/owner.ts:133-158`（@136-138 余额校验扣减）← `src/lib/star-crumb-exchange/catalog.ts:44-50,81-94`（star_crumb_exchange.json 2636 条 + 费用表：角色 300/600、装备 200/400）；客户端页 `StarCrumbExchangeScene`（`pinball/scene/shop/starCrumbExchange/`） | 一致 | 商店与币种映射正确（star_crumb=星之碎片）；「重复拥有拒绝」@139-146 为服务端防重，帮助未述 |

### 4. 星之粒（Gacha.md L46-L50）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「将扭蛋池中获得的重复角色转换为经验值…时获得（星之粒）」(L48) | `src/lib/character-growth/commands/stack-to-exp.ts:70-93`（`STACK_CONVERSION_REWARD_ITEM_ID=990008` 定义于 `src/lib/character-growth/limits.ts:31`）；990008=星之粒（item.json） | 一致 | 客户端同文案：「※转换扭蛋中获得的角色时将获得星之粒」（ui_string.json） |
| 「分解扭蛋池中获得的重复装备时获得」(L48) | 分解计算 `src/lib/equipment-dissolve.ts:40-44`（obtain_source===0 时发 `dissolve_star`）；发放 `src/routes/api/sell.ts:55-70`（@70 以 `starGrainItemId()` 即 990008 入包）、@206、@290 | 一致 | 客户端同文案：「※分解在扭蛋中得到的装备时将获得星之粒」（ui_string.json） |
| 「可使用兑换点数「兑换角色」的扭蛋池关闭时剩余的兑换点数也将被转换为星之粒」(L48) | 点数消费端（池内兑换）：`src/lib/gacha-owner/exchange.ts:85-88,121-122`（1 抽=1 点累计 `src/lib/gacha-owner/execute.ts:207`）；转换触发：`src/routes/cn/load.ts:329-334` → `src/lib/gacha-owner/conversion.ts:31-120`（@71-76 仍有合法 draw/exchange 路径则跳过，fail-closed 依据 `src/lib/gacha-owner/availability.ts:43-59`；@91-94 点数清零；@95-100 记 `players_gacha_conversions`，upsert 见 `src/data/domains/gacha-lifecycle-state.ts:201-222`；通知下发 `src/routes/cn/load.ts:433`）——**但 @78-83,110-112 把点数 1:1 记入 `player.starCrumb`（星之碎片）** | **偏差（P1）** | 官方目的地是**星之粒道具 990008**：三份客户端一致用 `config.star_grain_item_id` 弹「获得道具」toast＋「兑换点数 x N 已转换为星之粒」对话框（`wf-cn-client-as3-20261014/scripts/pinball/scene/home/HomeScene.as:1057-1061`；`wf-2.1.125-cn-decompiled/.../HomeScene.as:1070-1071`；`wf-0.0.81-en-decompiled/scripts/pinball/scene/home/HomeScene.as:976`）。星之碎片/星之粒价差 5~15 倍，详见 P1 |
| 「收集「星之粒」后可在「商店」内的「星之粒兑换」页面中兑换曾经活动中的角色、装备道具及强化道具」(L50) | 星之粒商店走通用商店购买链：`src/content/converters/shop.ts:46,132-133,415`（star_grain_shop.json），购买时以道具 990008 为货币校验扣减（item 购买路径） | 一致 | 主数据 `wf-assets-cn/orderedmap/shop/star_grain_shop.json` 75 条（4★ 角色 40 粒、觉醒材料 1~600 粒），商品为往期角色/装备/强化道具，与条款一致 |

## 二、差异与问题清单

### P1 — 池关闭兑换点转换目的地错误：发成「星之碎片」而非「星之粒」（偏差，建议修正）

- **官方规格**：Gacha.md L48「…剩余的兑换点数也将被转换为星之粒」。
- **客户端证据（三版本一致）**：`wf-cn-client-as3-20261014/scripts/pinball/scene/home/HomeScene.as:1057-1058` 取 `config.star_grain_item_id`（=990008 星之粒，`wf-assets-cn/orderedmap/item/item.json`）弹 GetItem toast；`:1061` 对话框文案键 `converted_exchange_point_dialog_description`=「兑换点数 x ::count:: 已转换为星之粒」（`wf-assets-cn/orderedmap/string/ui_string.json`）。`wf-2.1.125-cn-decompiled/scripts/scripts/pinball/scene/home/HomeScene.as:1070-1071`、`wf-0.0.81-en-decompiled/scripts/pinball/scene/home/HomeScene.as:976` 相同。
- **本服实现**：`src/lib/gacha-owner/conversion.ts:77-83`（1:1 记入 `player.starCrumb`）、`:110-112`（落库 players.star_crumb）；溢出走星之碎片邮件 `:84-90` → `src/lib/mail-overflow.ts:145`。
- **影响**：星之碎片是高价值币种（`star_crumb_exchange_cost.json`：5★ 角色 600、4★ 角色 300），星之粒是低价值币种（`star_grain_shop.json`：4★ 角色 40 粒、强化材料 1~600 粒）。错发使玩家每次池关闭按 1:1 白得 5~15 倍价值的星之碎片，可直接在「星之碎片兑换」套现 5★ 角色——资产经济失衡。
- **修正方向**（仅记录，未改码）：转换时改发道具 990008×点数（含容量溢出邮件语义随之改为道具溢出），`players_gacha_conversions` 记录结构可保持（客户端只消费 `gacha_id`+`gacha_exchange_point`，`InitializeRealRemote.as:2849-2899`）。

### P2-1 — 「星之碎片」获取链整体未实现（未实现）

- **官方规格**：Gacha.md L36/L38/L40/L42：付费石抽扭蛋获得、礼包获得、特别角色兑换套装获得；每累计 75 付费石=1 个；1天1次限定付费扭蛋角色 2 个/装备 1 个；邮件领取。
- **本服证据**：
  - 全库 `grep -rni "star_fragment|starFragment|星之碎片" src/` 与付费石累计计数器（totalPaid/paid_total 等）均 0 命中；
  - 付费抽取路径无发放：`src/lib/gacha-owner/execute.ts` 全文无 starCrumb；成功回包 `user_info` 也不含 `star_crumb`（`src/lib/gacha-owner/response-projector.ts:24-31`），而官方客户端在 exec 后 diff star_crumb 弹获得提示（`GachaExecRealRemote.as:63,119`）——即协议面也已预留、本服未接；
  - 特别交换购票不发放：`src/lib/special-exchange/owner.ts:201-235`；
  - 礼包购买（IAP）未实装：`src/routes/cn/load.ts:133,152`，主数据已备（payment/android_payment.json stonepack_GachaTicket 星之碎片×20；mail/reason.json 原因 45/46）。
- **已完成部分**：余额/容量/邮件领取链就绪（`mail-reward-grant.ts:288-289,305-315,337-338`；容量键 `max_star_crumb` 于 `src/lib/config-content.ts:111`），后台可手工调账（`src/routes/web_api/player.ts:119`）；新建号默认 2（`src/data/utils/default-player.ts:23`）。
- **影响**：付费向保值机制（75 石/碎片、每日付费扭蛋 2/1 加发）缺失，星之碎片在本服实际不可获得（除非触发 P1 错发或后台发放）；「星之碎片兑换」商店有货无币。

### P3 — `daily_one_count`/`daily_ten_count` 已冻结不递增（记录性，非缺陷）

- **位置**：`src/lib/gacha-owner/execute.ts:127-134`（裁定注释+读取原值回写）、`:317-324`（upsert 原值）；上限配置 `src/lib/gacha-owner/daily-limits.ts:3-16`（`gacha_one_max_count`/`gacha_ten_max_count`，`src/lib/config-content.ts:112-113`）；存档校验 `src/lib/gacha-owner/save-validation.ts:55-56`。
- **口径回答（任务重点核实项）**：`daily_one_count` **不是**「1天1次限定付费扭蛋」的限次器。它是普通池「每日单抽/每日十连次数」计数（官方语义 99/99），2026-10-29 裁定起保留字段但不再递增；「1天1次限定付费扭蛋」的限次由 `players_gacha_info.is_daily_first` 承担（`src/lib/gacha-exec-plan.ts:143-144`，每日重置 `src/data/domains/gacha-state.ts:220-221`）。客户端在抽取按钮/结算面板以「剩余=上限−dailyCount」格式渲染（`wf-cn-client-as3-20261014/scripts/pinball/scene/gacha/top/common/GachaSceneViewBase.as:516-543`、`scene/gacha/result/common/panel/ResultBottomPanelView.as:311-328`），冻结 0 即恒显「99/99」，与官服实测「99/99 恒定不递减」展示一致。

### 其他备注（不判级）

- **券优先于石**：无服务端可对照条款（客户端按钮策略），服务端无需改动；但若未来做「服务端强制」防作弊口径，注意不要破坏「券不足→配置券回退通用券」（`src/lib/gacha-exec-plan.ts:162-181`）与「持券延长卡池期」（`request-plan.ts:69-76`）两条既有机制。
- **疯狂十连**：帮助「等选项」未展开；本服有独立生命周期（`src/lib/gacha-owner/crazy.ts`、`save-validation.ts:111-173`），官方条款无对应句，不列入对照。
- **重复补偿道具**（觉醒材料 14001-14018，`grant-character-stack.ts:16-26`）与「重复数转换星之粒」提示（ui_string「已超出最大重复数…将被转换为星之粒」）：帮助文本未覆盖，实现与主数据一致，不判偏差。

## 三、结论

- 对照表共 **22 行**（覆盖正文 19 个条款句）：一致 **12**、偏差 **1**（P1 池关闭转换币种）、未实现 **4**（P2-1 星之碎片获取链；另有 1 行半判定「邮件领取：链路一致／来源未实现」）、不可对照 **4**（一键跳过、多券展示排序、券优先默认——客户端行为；IAP 礼包——IAP 未实装）。
- 扭蛋主体链（支付三路径、券种类/回退、每日付费限次、重复数与补偿、兑换点、疯狂十连）与官方帮助条款吻合度高。
- 两处需跟进：**P1**（转换目的地改为道具 990008，经济影响直接）与 **P2-1**（星之碎片 75 石累计 + 每日付费扭蛋 2/1 加发；若接通，需在 exec/exchange 回包 `user_info` 补 `star_crumb` 以驱动客户端获得提示）。
