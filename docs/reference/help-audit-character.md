# 帮助文本对照审计 — 角色线（角色 / 队伍编成 / 等级强化 / 能力学习 / 装备道具 / EX突破）

- 口径：CN 主数据 **1.4.54**（wf-assets-cn）；服务端 **commit 679f2c67**（worktree starpoint-cn-dev-integration，`docs(reference): help-text audits — stamina/gacha/multi vs official help pages`，2026-11-05）。
- 官方帮助正文（`docs/help/`，来源 rich_text/help_character_* 与 help_character_ex_boost；行号按各文件实际行号）：
  `Character_Character.md`（78 行）、`Character_Party.md`（124 行）、`Character_Strengthen.md`（48 行）、`Character_Ability.md`（30 行）、`Character_Equipment.md`（94 行）、`Ex_Boost.md`（68 行）。
- 实现基准：角色成长 `src/lib/character-growth/**`（commands/limits/exp-caps/exp-calculation）、玛纳板 `src/lib/character-mana-mutation-plan.ts`、`src/lib/mana-board-availability.ts`、进化 `src/lib/character-evolution.ts`；路由 `src/routes/api/character.ts`、`src/routes/api/character/{mana,mana-awake,bond}.ts`、`src/routes/api/expod.ts`、`src/routes/api/exBoost.ts`、`src/routes/api/equipment.ts`、`src/routes/api/sell.ts`、`src/routes/api/party.ts`、`src/routes/api/partyGroup.ts`；编成校验 `src/lib/party-loadout-validation.ts`、`src/lib/special-event-parties.ts`、`src/lib/validate/*`；协力槽 `src/multi/snapshot/player-snapshot.ts`、`src/multi/npc/builder.ts`。
- 主数据交叉核对：`wf-assets-cn/orderedmap/character/{level_cap,character_level,experience_conversion_rate}.json`、`orderedmap/mana_board/{mana_board2_open_condition,board_open_condition,mana_node}.json`、`orderedmap/item/item.json`、`orderedmap/party/party_group_color.json`、`orderedmap/shop/star_grain_shop.json`；服务端内容种子 `assets/character_level.json`（5 张稀有度经验表）、`assets/ex_boost.json`。EXP 上限与 `assets/character_level.json` 逐值一致。
- 客户端对照证据取自 `wf-cn-client-as3-20261014/`（1.8.1 补全版反编译）：突破素材规则 `scripts/pinball/common/data/character/parameter/OwnedOverLimitLogic.as:94-125`，二板开启条件 `scripts/pinball/common/data/character/BattleCharacterLogic.as:1315-1341`，魂珠属性限制 `scripts/pinball/common/data/party/PartyLogic.as:517-547` + `party/abilitySoul/UnusableAbilitySoulReason.as`，队伍代码 remote `scripts/pinball/remote/party/{publish,refer}/`（refer 调 `party/refer`：`PartyReferRemote.as:28`）。
- 判定分级：**一致 / 偏差 / 未实现 / 不可对照**（纯客户端行为或无服务端面）/ **帮助未覆盖**（帮助未给出可对照口径）。file:line 均为该 commit 下真实可查位置。
- 口径声明（任务给定）：协力位（合击角色）语义 = **sub 技能生效、主+sub 一个单位**；战斗内数值/演出归客户端，服务端面只审数据交付与规则校验。

## 一、角色（Character_Character.md）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「角色一览…查看持有的角色和重复数」(L5) | 重复数即 stack：`src/lib/character-growth/commands/grant-character-stack.ts:62-95`；持有列表经 `src/data/domains/character.ts:213-295` | 一致 | 一览/排序/长按为客户端 UI；服务端按角色持久化 stack 并在 load 交付 |
| 「攻击/HP 随能力、装备道具、技能变化」(L15-21) | 编成数据交付：`src/data/domains/party.ts:158-178`（3 主位+3 协力位+装备+魂珠）；快照 `src/multi/snapshot/player-snapshot.ts:212-289` | 一致 | 数值合成在战斗客户端；服务端交付 exp/evolution_level/mana_node_ids/ex_boost 全量 |
| 「生命值为 0 时进入棺柩状态」(L19) | — | 不可对照 | 战斗内状态机，纯客户端 |
| 「Lv 显示成长度…随等级提升增加」(L25) | exp 与等级换算：`src/lib/character-growth/node-command-support.ts`（characterLevelFromContent）；上限表 `src/lib/character-growth/exp-caps.ts:1-7` | 一致 | exp 累积口径与 `assets/character_level.json` 逐级一致（379988=Lv100@★5 等） |
| 「最大等级取决于稀有度，可通过上限突破增加」(L27) | `src/lib/character-growth/limits.ts:1-7`（1★:12/2★:10/3★:8/4★:6/5★:4 次） | 一致 | 与主数据 `level_cap.json`（1★[40,12,5]/2★[50,10,5]/3★[60,8,5]…）逐值一致：基础 40/50/60/70/80 + 每次突破 +5 → 全稀有度上限 100 |
| 「类型 5 种…强化弹射动作不同」「技能召唤的角色没有类型」(L31-35) | — | 不可对照 | 战斗内动作/类型语义纯客户端 |
| 「技能预览…200% 技能槽开始」(L39-45) | — | 不可对照 | 纯客户端演出 |
| 「技能 Lv…通过学习『提升技能Lv』的能力来提升」(L49-51) | 节点学习/强化持久化：`src/lib/character-growth/commands/learn-mana-nodes.ts:197-201`、awake：`commands/awake-mana-nodes.ts:79-115`；协力快照按 `mana_node_ids: {nodeId: awakeLevel}` 交付 `src/multi/snapshot/player-snapshot.ts:189-197` | 一致 | 技能效果数值由内容+客户端解释；服务端持久化节点学习与强化等级 |
| 「属性 6 种」「种族影响能力和队长特性」(L55-59) | 内容层 element/race：`src/lib/character-content.ts`（getCharacterFacts） | 一致 | 属内容交付；种族组合效果为战斗客户端解释 |
| 「重复数将会自动提升」(L63) | `src/lib/character.ts:107-116`（重复获得→stack+1）→ `grant-character-stack.ts:74` | 一致 | 所有获得路径（扭蛋/邮件/交换/城镇）汇于 givePlayerCharacterSync |
| 「重复的角色可以用来进行上限突破或转换为经验值」(L65) | 上限突破用重复：`commands/over-limit.ts:69-92`（useStack）；转换：`commands/stack-to-exp.ts:46-114` | 一致 | 两条路径均实现 |
| 「重复数的上限为 99。超过…自动转换为经验值」(L67) | `grant-character-stack.ts:74`（stack+1 无上限）；全仓无 STACK_MAX/99 上限 | **未实现** | 见 **P2-1**：重复数无 99 上限、无溢出自动转换 |
| 「从扭蛋中获得的角色转换为经验值时能够获得星之粒」(L69) | `stack-to-exp.ts:64-71,83-97`（星之粒 990008，按稀有度 2/2/2/10/30） | 一致 | 数值与主数据 `experience_conversion_rate.json`（rarity→[exp,星之粒]）逐值一致；服务端对所有重复转换均发星之粒（主数据同口径，未区分获取渠道） |
| 「重复数为 0 的角色转换为经验值，则该角色将离开…再次获得无法继承」(L29, Strengthen) | `src/lib/character-stack.ts:10`（仅校验 stack≥convertCount，本体永不离开） | **未实现** | 见 **P3-1**：仅支持重复部分转换，本体转换/离队/状态清除不存在（关联条款「使用中的能力魂珠将消失」同未实现） |
| 「已获得的经验值无法被转换」(L31) | exp 单向累加：`exp-calculation.ts:27-35` | 一致 | 无 exp 回退路径 |
| 「★3 及以上角色可阅览角色故事」(L77) | 故事解锁经 storyQuest 线（`src/routes/api/storyQuest.ts`） | 不可对照 | 阅览为客户端演出；解锁数据属关卡/故事线（第一批已覆盖关卡链） |

## 二、队伍编成（Character_Party.md）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「最多可保存 10 个编队」(L5) | `src/lib/special-event-parties.ts:58-64`（partyId 1-120 = 12 组×10 槽）；`src/data/domains/party.ts:158-178`（slot 维度行） | 一致 | 每组 10 编队，槽位 1-10 与口径一致 |
| 「滑动/左右按钮切换已编成的队伍」(L7) | — | 不可对照 | 客户端 UI；服务端按 party_id 受理 |
| 「点击 SET 按钮切换…最多可保存 6 个 SET」(L9-11) | `src/lib/special-event-parties.ts:25-27`（NORMAL/EVENT 组上限 **12**，CARNIVAL/RUSH 6）；`src/lib/validate/party-slot.ts:5,14`（partySlot 1-120） | **偏差** | 见 **P2-3**：帮助说 6 SET，服务端 NORMAL 类别放行 12 组（协议 1-120）；CARNIVAL/RUSH=6 与帮助一致。客户端实际渲染组数需真机确认 |
| 「切换画面时自动保存修改」(L13,19) | `src/routes/api/party.ts:578-580`（每行 upsert） | 一致 | 客户端在切换时提交 party/edit，服务端逐行落库 |
| 「SET 编辑：切换、颜色设置、队伍名编辑、复制队伍」(L17) | 颜色：`src/routes/api/partyGroup.ts:40-102` → `src/data/domains/party.ts:186-193`；队名：`party.ts:545-562`（name）；复制队伍=客户端本地拷贝后走 edit | 一致 | 颜色/队名服务端持久化；复制为客户端行为 |
| 「切换按钮（倾向/详细数值）」「详细设定按钮（能力发动条件 ON）」(L23-29) | — | 不可对照 | 纯客户端数值预览 |
| 「队伍代码…生成/输入，复制他人编成」(L33-39) | publish：`src/routes/api/party.ts:430-463`（**返回固定占位 URL** `howLongCanThisBe…`，L459）；refer：全仓无 `party/refer` 路由（客户端有真实现 `wf-cn-client-as3-20261014/scripts/pinball/remote/party/refer/PartyReferRemote.as:28` 调 `party/refer`） | **未实现** | 见 **P2-2**：生成返回占位串、输入端点缺失 |
| 「推荐编成：已完成该关卡的玩家队伍…部分编成/自动编成」(L43-61) | fixed_party 主数据已入内容层：`src/content/converters/quest.ts`（fixed_party）→ `src/lib/quest-content.ts`；部分/自动编成为客户端算法 | 不可对照 | 「无通关者不显示」的动态过滤无服务端面（客户端据 fixed_party+通关记录渲染）；自动编成结果仍经 party/edit 落库受同一校验 |
| 「编成收藏：协力结算收藏…最多 10 个，按时间顺序淘汰」(L65-73) | 全仓无收藏端点（multi 路由仅 createRoom/getRooms/prepare/summon 等） | **未实现** | 见 **P3-2**；客户端有 `pinball/scene/favoriteParty`、`recentOtherPlayerParty` 场景 |
| 「主要角色=弹射挡板弹出的角色；领头的叫队长」(L77-79) | 队长口径=编队一号位：`src/lib/battle-party-leader.ts:15-49`（character_id_1 优先） | 一致 | 服务端以一号位为队长（房间横幅/资料页同源口径） |
| 「直接攻击与受伤的属性相性以主要角色属性为准」(L81) | — | 不可对照 | 战斗客户端 |
| 「队长特性：角色进化后强化」(L85-87) | evolution_level 持久化与交付：`src/lib/character-growth/commands/learn-mana-nodes.ts:176-181,247-252`；快照含 evolution_level `player-snapshot.ts:199-210` | 一致 | 强化量值客户端按 evolution_level 计算 |
| 「合击角色：提供辅助…主+合击技能同时发动，合击技能作为主角色能力发动」(L91-97) | 数据交付：`src/multi/snapshot/player-snapshot.ts:212-289`（unison_characters 与 characters 同构、Option 包装）；NPC 招募模板 `src/multi/npc/builder.ts:29-47`（unison 补齐 3 槽）；协议口径 `docs/protocol/multi-battle.md:330-356` | 一致 | 按任务口径（sub 技能生效、主+sub 一个单位）：服务端为每个协力位交付全量成长数据（节点/EX/进化），主+sub 合成一个战斗单位由客户端执行——发动语义本身**不可对照**[纯客户端] |
| 「在玛纳板可查看技能/能力能否由合击角色发动」(L101-111) | — | 不可对照 | 客户端内容标注 |
| 「各角色量表…随攻击力/上升率提升」(L115-123) | — | 不可对照 | 纯客户端展示 |

## 三、等级强化（Character_Strengthen.md）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「获得一定经验值后升级、成长」(L7) | `commands/grant-character-exp.ts:132-176`（per-char cap 截断）+ `exp-calculation.ts:13-37` | 一致 | 经验上限随 over_limit_step 取 `exp-caps.ts` 对应档；与 `assets/character_level.json` 5 表逐值核对一致（★5: 153988/210488/266988/323488/379988 = Lv80/85/90/95/100） |
| 「能力习得和技能强化需要玛纳和培育道具」(L11) | 玛纳+道具扣费：`src/lib/character-mana-mutation-plan.ts:48-73`（charge）；资源落库 `commands/learn-mana-nodes.ts:181-193` | 一致 | 消耗来自内容表（`orderedmap/mana_board/mana_node.json`）；free/paid 玛纳分账 |
| 「通关关卡、获得任务报酬时自动存储角色经验值」(L15) | 通关经验：`src/lib/quest/finish/single-settlement-writes.ts`（givePlayerCharactersExpSync）→ 同 grant-character-exp 链 | 一致 | 帮助-关卡线交叉条款；发放与上限截断同口径 |
| 「达到最大等级的角色获得的部分经验值，将被存储在孵化之卵中」(L17) | 溢出经验入池：`exp-calculation.ts:28-35`（overflowExp）→ `grant-character-exp.ts:156,169-175`（expPool） | 一致 | 满级角色所得经验全额溢出入池，符合「存储在孵化之卵中」 |
| 「可以将存储的角色经验值分配给任意角色」(L19) | `src/routes/api/expod.ts:199-232`（inject_exp）→ `commands/inject-exp.ts:49-77`（池校验/扣减/再溢出回池）；池子按时间累积 `inject-exp.ts:66` | 一致 | 分配再溢出时回池不丢失 |
| 「也可在『珍奇品商店』中购买经验值」(L21) | 商店经验奖励：`src/lib/shop/purchase-rewards.ts:36-50`（ShopItemRewardType.EXP→RewardType.EXP）→ `src/lib/reward-grant/execution-engine.ts:122`（入 expPool） | 一致 | 机制在；1.4.54 星之粒商店当前无经验商品在售（内容层面，非服务端缺口） |
| 「可用角色的重复数或破星结晶来提升等级上限」(L25) | `commands/over-limit.ts:69-92`（重复）/`:94-108`（结晶） | 一致 | 上限校验 `:64-67`（rarity→max）与 level_cap 一致 |
| 「在上限突破页面…将重复的角色转换为角色经验值」(L27) | `src/routes/api/expod.ts:95-149`（stack_to_exp）、`:151-183`（bulk_stack_to_exp） | 一致 | 经验入 expPool（孵化之卵） |
| 「重复数为 0 的角色转换后离开…」「使用中的能力魂珠将消失」(L29,33) | 同第一节 | **未实现** | 见 P3-1 |
| 「已获得的经验值无法被转换」(L31) | exp 单向 | 一致 | — |
| 「自动上限突破…一并进行」(L37) | `src/routes/api/character.ts:229-280`（bulk_over_limit）→ `commands/bulk-over-limit.ts:50-58` | 一致 | 对所有有重复且未满步角色批量突破 |
| 「自动上限突破时无法使用破星结晶」(L39) | `commands/bulk-over-limit.ts:53-58`（仅消耗 stack，无 itemId 入参） | 一致 | — |
| 「破星结晶…代替重复数；不同稀有度适用不同结晶」(L43-45) | `commands/over-limit.ts:38-47`（5★ 必须 10003；≤4★ 允许 10001/10002） | **偏差** | 见 **P2-4**：主数据 `item.json` 10001=「可用于稀有度不高于★3」且客户端规则为 `rarity==target \|\| (rarity<target && allow_below)`（`OwnedOverLimitLogic.as:126-128`），10001 仅应适用 ≤3★；服务端放宽为 ≤4★ 亦可用 10001 |
| 「破星结晶碎片收集后可在商店兑换破星结晶」(L47) | 碎片物品 11001-11003 在主数据（max 50）；兑换走星之粒/商店通用交换（`src/content/converters/shop.ts:46,415`） | 帮助未覆盖 | 兑换所条目与扣费属商店/交换批次，本线不深查；碎片物品定义在内容层就绪 |

## 四、能力学习（Character_Ability.md）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「玛纳板…通过消耗玛纳和培育道具来学习能力」(L7) | `src/routes/api/character/mana.ts:24-92`（learn_mana_node）→ `planLearnManaNodeMutation` `character-mana-mutation-plan.ts:127-145`（逐节点 charge 玛纳+道具，余额不足即拒） | 一致 | 费用/道具随内容表（不同能力不同道具，L9 ✓） |
| 「根据习得的能力不同，需要的道具也不同」(L9) | 节点费用来自 `orderedmap/mana_board/mana_node.json`（cost 列多道具形态） | 一致 | 内容驱动 |
| 「角色将在增强技能和习得所有能力后进化。进化获得『增加最大HP/攻击力』和『增强队长特性』」(L13) | 进化等级推导：`src/lib/character-evolution.ts:39-71`（全能力槽各学≥1 节点 + 技能强化节点）；响应 `commands/learn-mana-nodes.ts:314-318` | 一致 | 触发条件一致；进化数值收益为客户端按 evolution_level 计算（不可对照数值本身） |
| 「★3 以上部分角色第 1 枚玛纳板全部解锁完成后，将等级上限突破至 90 后解锁第 2 枚玛纳板」(L17) | `commands/open-mana-board.ts:32-44`（REQUIRED_UNCAPS 3★:6/4★:4/5★:2 → 上限 90）+ `:110-114`（板 1 全学完）+ `:93-97`（二板时间窗） | 一致 | 与主数据 `board_open_condition.json`（3★→6/4★→4/5★→2）逐值一致；「部分角色」= `mana_board2_open_condition.json` 505 角色时间窗，服务端 `src/lib/mana-board-availability.ts:12-35` 同口径。服务端另要求本体 exp≥基础上限（`:98-101`），与客户端 `BattleCharacterLogic.as:1325`（get_level() < baseLevelCap 拒绝）一致——帮助未提及但为客户端真实条件，从严不算偏差 |
| 「在第二枚玛纳板中能够学习角色的能力 4~6」(L19) | 板 2 节点集来自内容（`mutationContent(characterId, 2)`）；板切换 `open-mana-board.ts:177-224` | 一致 | 能力 4-6 归内容交付 |
| 「信赖之证：解锁全部第一层玛纳板并等级提升到最大（上限突破部分除外）获得；第二层全解锁再次获得」(L23-25) | `src/lib/character-growth/bond-token-qualification.ts:39-63`（板1=基础 exp 上限+全节点；板2=仅全节点，无等级条件） | 一致 | 与客户端注释口径一致（DummyPlayerLogic.updateBondTokenList）；学习/获得经验双路径收敛 `:74-147` |
| 「收集一定数量后可以在商店中兑换装备」(L27) | 收取：`commands/receive-bond-token.ts:48-90`（status 0→2，玩家 bondToken 计数 `:87`） | 一致 | 兑换装备走商店线（本线不深查）；收取幂等、每板一次 |
| 「每个角色只能获得一次信赖之证」(L29) | status 粘滞：`bond-token-qualification.ts:53-55`（非 0 不再授予） | 一致 | 按板一次性；重复 learn/exp 不会重复授予 |

## 五、装备道具（Character_Equipment.md）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「每位主要角色均可装备 1 个装备道具，总计可装备 3 个」(L7) | `src/data/domains/party.ts:158-178`（equipment_1..3 对应 3 主位；协力位无装备槽）；佩戴校验 `src/lib/party-loadout-validation.ts:30-43`（持有+单队不重复） | 一致 | 与「主位每人 1 个」同构 |
| 「装备后提高生命值、攻击力或发挥能力效果」(L7) | 装备等级/强化等级随编成交付 `src/multi/snapshot/player-snapshot.ts:225-235`（equipmentId/level/enhancementLevel） | 一致 | 数值效果战斗客户端 |
| 「觉醒…需要该装备的重复数和锻造石」(L15) | `src/routes/api/equipment.ts:104-272`（upgrade：stack `:133-134`、锻造石=craftPoint `:141-144,166-169`、费用随稀有度 `:95-99`） | 一致 | 费用来自 `equipment_craft.json`（awakening_craft） |
| 「没有重复时，可使用对应稀有度的星铁钢」(L17) | `src/lib/equipment-upgrade.ts:7-17`（12001→★4 及以下；12002→仅 ★5） | 一致 | 与主数据 item.json 描述及客户端 allow_below 规则逐条一致 |
| 「部分装备道具没有额外的能力或增加能力的效果」(L19) | 内容标志 `generate_ability_soul`/max_level：`src/lib/equipment-content.ts`（getEquipmentDissolveSync） | 一致 | 内容驱动（如 max_level=1 装备不可觉醒，`equipment.ts:127-131`） |
| 「觉醒等级上限（max_level）」(L11-13) | `equipment.ts:127-131`（newLevel > maxLevel 拒绝）+ 存档钳制 `src/lib/validate/max-level.ts:10-33` | 一致 | 双保险：请求校验+load 时校正 |
| 「觉醒装备道具还可以获得能力魂珠」(L21) | `equipment.ts:188-213`（upgrade 事务内 grantWithCapacity 魂珠，flag=generate_ability_soul）；bulk 同 `:368-381` | 一致 | 溢出走邮件/自动出售结算 |
| 「追加能力…追加能力不应用于能力魂珠」(L25-29) | 魂珠按 CDN 定义 id 发放（base ability），追加能力随觉醒等级由内容+客户端解释 | 一致 | 服务端只发魂珠 id，不含追加能力——与帮助口径一致 |
| 「装备道具的重复：重复数自动提升」(L33) | `src/lib/equipment.ts:61-88`（owned→stack+amount） | 一致 | — |
| 「分解可获得锻造石和能力魂珠」(L37) | `src/lib/equipment-dissolve.ts:27-54`（craftPoints+abilitySouls 按 CDN flag） | 一致 | — |
| 「重复数超过 999 个时自动分解」(L39) | `src/lib/equipment.ts:82-87`（stack 无上限累加）；全仓无 999 上限/自动分解 | **未实现** | 见 **P3-3** |
| 「分解从扭蛋中获得的装备时能够获得星之粒」(L41) | `equipment-dissolve.ts:40-43`（obtain_source==0 → star_grain） | 一致 | obtain_source 即扭蛋来源标志 |
| 「星铁钢：★5 只能用于 ★5，★4 能用于 ★4 及以下」(L47) | `equipment-upgrade.ts:7-17` | 一致 | 与帮助文字逐句一致 |
| 「能力魂珠：每个角色可使用一个来学习相应能力」(L51-53) | `party.ts` ability_soul_1..3 每主位 1 个；校验 `party-loadout-validation.ts:45-59`（库存数量） | 一致 | — |
| 「卸下或更换能力魂珠时，原有能力魂珠不会消失」(L55) | 魂珠为道具本体（players_items），编成行仅存引用 id | 一致 | 结构性保证：卸下=置 null，不删道具 |
| 「拥有特定属性的能力魂珠只能用于具有相同属性的角色」(L57) | 服务端 party/edit 无属性校验（`party-loadout-validation.ts` 仅库存/持有）；客户端强制：`PartyLogic.as:528-547`（UnmatchedElement/UsedSameAbilitySoul） | **偏差** | 见 **P3-4**：改机可挂异属性魂珠/同角色重复同魂；战斗结算仍按客户端数据 |
| 「无属性的能力魂珠可用于全属性角色」(L63) | 同上（客户端 `isAvailableForCharacterElement`） | 偏差 | 同 P3-4，服务端不区分 |
| 「持有数量超过 9999 自动出售」(L59) | 道具容量策略：`src/lib/inventory/item-inventory-policy.ts:15-31`（maxCount 随主数据，魂珠 9999 见 item.json 5010058）+ 溢出自动出售 `src/lib/reward-grant-item-overflow.ts:28-56` | 一致 | 通用溢出机制（售出转玛纳），数值随主数据 |
| 「锻造石…使用数量取决于装备道具或所要卸下的能力魂珠」(L69) | 觉醒费用按稀有度 `equipment.ts:95-99`；卸下魂珠耗锻造石未见独立端点（卸下在 party/edit 内，无扣费） | **偏差** | 见 **P3-5**：卸下/更换魂珠的锻造石消耗服务端未实现（若官方确有此消耗；帮助文义指向卸下魂珠消耗锻造石） |
| 「宝珠：特殊插画装备」(L75-79) | — | 不可对照 | 插画查看纯客户端；获取走关卡/活动奖励 |
| 「一并选择按钮：觉醒至最大（不消耗星铁钢）/全部分解」(L83-93) | `equipment.ts:275-462`（bulk_upgrade：仅 stack，`Math.min(maxLevel-level, stack)` `:315`，不涉星铁钢）；分解 `src/routes/api/sell.ts:318+`（bulk_sell_stack 置零不删行 `:128-136`） | 一致 | 「装备道具不会消失」✓（批量分解只清 stack，保留装备本体） |

## 六、EX突破（Ex_Boost.md）

| 官方条款短引 | 实现 file:line | 判定 | 说明 |
|---|---|---|---|
| 「最大等级达到 100 后即可 EX 突破」(L7) | `src/routes/api/exBoost.ts:252-256`（overLimitStep 必须=稀有度最大步；全稀有度满步=上限 100） | 一致 | 与 level_cap 推导一致 |
| 「每 1 次 EX突破消耗：同属性★4/★5崇高辉石 1 个、★3崇高辉石 5 个、★4/★5破星结晶 1 个、★3破星结晶 5 个」(L11-17) | 素材表 `assets/ex_boost.json`（10001 count=5；10002/10003 count=1；14001-14018 tier1=5、tier2/3=1）+ 校验 `exBoost.ts:242-249`（数量）、`:194-196`（element 与角色一致才可） | 一致 | 与帮助四种组合逐值一致；属性错配拒收 |
| 「使用崇高辉石将有更高概率获得更强的 EX 状态·能力；越稀有概率越高」(L19) | 概率表 `exBoost.ts:89-110`（MATERIAL_PROBS：同档崇高辉石金/银权重恒高于破星；tier 越高金权重越高）+ tier 状态池 `src/lib/ex-boost-content.ts:96-102` | 一致 | 方向一致；概率数值为服务端内嵌表，采用「稀有度权重归一」抽样（`drawOneAbility` `:114-130`），与官方「独立概率」口径可能存在偏差——见 **P3-6** |
| 「再次 EX 突破：重新赋予，需在『覆盖旧能力』『保留旧能力』中选择其一」(L21) | draw（待定）→ select：`exBoost.ts:339-394`（is_confirm=true 覆盖写入 `setCharacterExBoostWithinTransactionSync`；false 删除待定=保留旧能力 `:359-361`） | 一致 | 覆盖/保留两支齐备 |
| 「不保留新获得的…道具不返还」(L23) | `exBoost.ts:359-361`（deletePending，无退费）；异角色重抽隐式放弃 `:198-240` 注释 | 一致 | — |
| 「崇高辉石 6 属性×★3-★5」(L27) | 14001-14018（element 0-5 × tier 1-3）`assets/ex_boost.json` | 一致 | — |
| 「从任意渠道获得已成为伙伴的角色时将能获得崇高辉石」(L29-43) | 重复获得统一发放：`grant-character-stack.ts:16-27,73`（★3:1/★4:1/★5:3 个，按属性映射） | 一致 | 所有获得路径（扭蛋/邮件/交换/角色选举等）汇于 givePlayerCharacterSync；具体个数帮助未覆盖（数值未在帮助中） |
| 「EX 状态在固定 HP/攻击组合中抽取，两者必定同时提升」(L49) | 状态池抽取：`exBoost.ts:259-262`（resolveStatusPool per tier）→ `drawExBoostAbilities:137-138`（必得 1 个 status） | 一致 | HP/ATK 数值组合在客户端主数据（ex_status）；服务端抽 id |
| 「最少 0 最多 2 个 EX 能力；1 个=能力 A 或 B 之一；2 个=必须 A+B 各 1」(L51) | `exBoost.ts:143-153`（A/B 池独立各抽 1，可空）；A/B 归类 `ex-boost-content.ts:16-70`（前缀表+_r3/4/5 稀有度） | 一致 | A、B 各自独立且至多 1 个，结构上不可能双 A/双 B ✓ |
| 「金/银/铜三种稀有度；绶带与图标不同」(L53-67) | 稀有度=金/银/铜权重 `exBoost.ts:114-130`；绶带图标客户端渲染 | 不可对照 | 展示层纯客户端 |

## 差异与问题清单

### P1（规格级错误，需优先修复）

无。角色线核心规则（等级上限/经验表/突破素材/玛纳板/进化/二板/信赖证/EX 抽取结构/装备觉醒与分解）均与帮助及主数据一致。

### P2（功能与帮助明文不符，或影响经济/功能可用性）

- **P2-1 重复数无 99 上限、无溢出自动转换**
  帮助 Character_Character L67「重复数的上限为 99。如果超过持有上限，超出部分的角色会自动转换为经验值」。实现 `src/lib/character-growth/commands/grant-character-stack.ts:74` 对 stack 无上限累加，全仓无 99 上限或自动转换逻辑。扭蛋重复大量溢出时 stack 无限堆积，与官方行为（超出转经验+星之粒）不符；不影响战斗数值（stack 仅用于突破/转换），故 P2。
- **P2-2 队伍代码生成/输入未实现**
  帮助 Character_Party L33-39。`src/routes/api/party.ts:459` 的 publish 返回固定占位 URL（`"https://www.howLongCanThisBe?=+-.com…"`）；客户端存在真实 remote（`PartyPublishRemote.as` / `PartyReferRemote.as:28` 调 `party/refer`），但服务端无 `/party/refer` 路由——输入队伍代码复制编成必然失败。
- **P2-3 SET 数量与帮助不符（6 → 12）**
  帮助 Character_Party L11「最多可保存 6 个 SET」。`src/lib/special-event-parties.ts:25-27` 对 NORMAL/EVENT 放行 12 组（`getGlobalPartyId` 协议域 1-120=12×10）。CARNIVAL/RUSH=6 与帮助一致。若 CN 1.8.1 客户端仅渲染 6 组则多余组不可达（无害）；若客户端支持 12 组则帮助文本滞后。需真机确认客户端 SET 数后归类。
- **P2-4 破星结晶稀有度匹配放宽（★3 结晶可用于 ★4 角色）**
  帮助 Character_Strengthen L45「不同的破星结晶适用于不同稀有度的角色」；主数据 `item.json` 10001 描述「可用于稀有度不高于★3的角色」，客户端规则 `OwnedOverLimitLogic.as:126-128` 为 `rarity==target || (rarity<target && is_allow_below_rarity)`（10001: target=3, allow_below=true → 仅 ≤3★）。服务端 `src/lib/character-growth/commands/over-limit.ts:43-45` 允许 ≤4★ 使用 10001/10002——★4 角色可被 ★3 结晶突破，绕过高档结晶消耗。同型检查在装备线实现正确（`equipment-upgrade.ts:7-17`），可直接对齐修复。

### P3（边缘/低风险缺口与口径存疑）

- **P3-1 重复数为 0 的角色转换后离队未实现**
  帮助 Character_Strengthen L29「如果将重复数为 0 的角色转换为角色经验值，则该角色将离开并且无法再使用。此外，再次获得此角色时无法继承其离开前的状态」及 L33「使用中的能力魂珠将消失」。`src/lib/character-stack.ts:10` 仅允许转换 stack>0 的重复部分，本体永不离开，也无「再次获得不继承状态」的清除路径。边缘场景，玩家几乎不主动牺牲本体。
- **P3-2 编成收藏未实现**
  帮助 Character_Party L65-73（协力结算收藏、上限 10、按时间淘汰、清缓存失效）。服务端无对应端点/存储；客户端有 `pinball/scene/favoriteParty`、`scene/recentOtherPlayerParty`、`dialog/partyCopy`。属社交便利功能，不影响战斗。
- **P3-3 装备重复数 999 自动分解未实现**
  帮助 Character_Equipment L39。`src/lib/equipment.ts:82-87` 无上限累加；`max_level` 钳制（`validate/max-level.ts`）管等级不管 stack。溢出仅在奖励发放路径有通用容量策略，直接 stack 增量不经过。
- **P3-4 能力魂珠属性匹配/同角色同魂不校验（服务端）**
  帮助 Character_Equipment L57-63。客户端 `PartyLogic.as:528-547` 强制 UnmatchedElement/UsedSameAbilitySoul；服务端 `src/lib/party-loadout-validation.ts:25-61` 仅校验持有与库存数量。改机客户端可写入异属性魂珠组合；正式客户端不受影响。
- **P3-5 卸下能力魂珠的锻造石消耗未实现**
  帮助 Character_Equipment L69「锻造石的使用数量取决于装备道具或所要卸下的能力魂珠」。卸下/更换魂珠在 party/edit 内无任何扣费（`src/routes/api/party.ts:545-562` 直存 ability_soul_ids）。若官方确在卸下时收锻造石，则服务端少扣一笔（锻造石为可刷资源，量级小）。
- **P3-6 EX 能力抽取概率口径存疑（权重归一 vs 独立概率）**
  `src/routes/api/exBoost.ts:114-130` 将官方概率表值（exBoost.ts:89-110 注释表）作为**组内权重**归一抽样；若官方语义为各稀有度独立概率（表值即命中率），则金/银实际命中率被抬升（例如 tier3 破星 a3=9.00、a2=1.00 归一后金≈90%）。帮助只给出方向（越稀有越强、崇高优于破星），方向一致；概率口径需以官方服务端数据/抓包标定。
- **P3-7 EX 突破待定结果的「隐式放弃」边界**
  `exBoost.ts:218-240`：对异角色重新 draw 时旧 pending 被覆盖且不退费（注释明示与显式放弃同语义）。帮助未定义此边界；真机行为需核对客户端是否允许异角色重入（防护逻辑存在但依赖客户端交互顺序）。

## 结论

- 六篇帮助共对照 **84 条**（角色 16 / 队伍编成 15 / 等级强化 14 / 能力学习 8 / 装备道具 21 / EX突破 10，跨篇重复条款按出现位置分别计），其中：**一致 60、偏差 5、未实现 6、不可对照 12（纯客户端 UI/演出/战斗结算）、帮助未覆盖 1**（碎片兑换归交换所线）。偏差/未实现对应问题清单 P2-1…P2-4、P3-1…P3-7。
- 规格主体（成长数值、突破与素材、玛纳板与进化、二板与信赖证、EX 抽取结构、装备觉醒/分解/魂珠交付、编成 3+3 槽与 sub 数据交付）与 1.4.54 帮助及主数据**逐值一致**，多处经客户端反编译旁证（OwnedOverLimitLogic / BattleCharacterLogic / PartyLogic）。
- 建议优先处理 P2-4（结晶稀有度放宽，一行修复、直接对齐 `equipment-upgrade.ts` 既有规则），其次 P2-2（队伍代码 refer 端点）与 P2-1（stack 99 上限+溢出转换）；P2-3 需真机确认 SET 数量后再定。
- 与前两批口径衔接：体力/扭蛋/协力线结论不受本线影响；本线 P3-2（编成收藏）与协力线结算页（settlement）存在交叉，留待协力线复验时一并核对客户端入口。
