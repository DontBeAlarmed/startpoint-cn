# Boss 连战 Roguelike 方案(「深渊连战」)

> 目标体验:选难度进入 → **连续多轮战斗不出大厅**(每轮小怪波→boss 波同场切换)→
> 轮间获取/选择武器与 buff → 无尽模式敌人逐轮增强 → 按到达轮数结算 meta 奖励。
> 原则:**零客户端代码改动**,全部用现成 UI/机制拼装;数据走 ② 层发布,编排走私服服务端。
> 前置报告:`boss战与副本分析报告.md`(boss 名单/链路/格式);工具:`wf_quest_lib.py`(已通过 12 表往返自检)。

---

## 1. 骨架选型:rush_event(连战活动)——全链路现成

CN 已运营 7 期「狂热激战」(combat_diver_01~07)+ 7 期变体,机制与本方案高度重合:

| 需求 | rush_event 现成能力 | 证据 |
|---|---|---|
| 连战不出大厅 | folder 内 round 1→N 顺序连打,通关自动下一轮 | `rush_event_quest` col1=folder_id col2=round;700007=中级2轮/高级2轮/超级3轮 |
| 无尽模式 | quest_kind=2 的「无尽战斗」folder,单 quest 无限循环 | folder 700007-4,round=0 |
| 逐轮增强 | 修正曲线表:按轮数缩放敌 HP/ATK/条数 | `rush_event_battle_quest_correction[700007][4]` = 轮1×0.34 → 轮6×1.99… |
| 服务端知道轮数 | 已实现 next_round / max_round / 最佳记录跟踪 | `rush-handler.ts`: endless_battle_next_round/max_round |
| 队伍消耗压力 | 每轮已用角色锁定(rogue 式资源管理) | `rush-handler.ts` playedParties(含装备/魂珠记录) |
| 活动入口 | event_list 一行注册 | `event_list[700007] = 11,700007,700007`(kind 11=rush) |

服务端三件套已在私服实现:`src/routes/api/rushEvent.ts`(636行)+
`src/lib/quest/finish/rush-handler.ts`(161行)+ `src/data/domains/rushEvent.ts`(707行)。

## 2. 「小怪→boss 同场」:zone 多波次(192 个现成范例)

zone 表(1089 行)每行 = 一场战斗的波次序列(内层键 0,1,2…),波次列结构已解码:

- col0 目标:`0`=击杀 col1 只小怪、`1`=BossClear、`2`=Unspecified
- col2..21 = zako01..10 × (代号, 刷新间隔帧)
- col23/24 = boss1(类型枚举: 0=StandardBoss 1=GeneralBoss 2..7=元素球/大蛇等) ,col25/26=boss1_multi,后续 boss2/boss3 同构
- col35 outhole 过场动画(波次切换表现)、col36/37 机关、col39/40 掉落块/装饰

**现成模板**:`yokai_emaki_01_02..14`(妖怪绘卷)= 波0 杀 8~16 只小怪 → 波1 boss,正是目标体验。
组一场新战斗 = 新增 zone 行(选 115 种 zako × 119 个 boss 家族)+ field_data 一行
(`field,terrain,zone` 三列,terrain/背景直接复用现有,如 `rush_guardian_totem` / yokai_emaki 系)。

## 3. Buff / 武器系统(三档,从稳到激进)

- **B1 轮间战利品(M2,纯服务端)**:`rush-handler` 通关钩子按 round 发奖 —
  随机战利品走 **box_gacha**(服务端 `/exec` `/get_box_list` 已实现),
  「三选一」走 **item_bonus_select**(客户端现成 13 种选一宝箱 UI;服务端兑换逻辑需小补)。
  发武器/魂珠/强化材料 → 玩家轮间在编队界面换装 = roguelike 构筑。
- ~~**B2 变体选路(M3,纯数据)**:同 folder 同 round 摆 2~3 个 quest 变体~~
  **已被客户端代码否定(2026-07-12,见 §9.1)**:选关列表永远只显示 1 个 quest,
  同轮多 quest 不可选、还会撑坏进度条。选路改走两条替代:
  ①**folder 级选路**——并联多个 rush folder 当"路线/难度"(客户端原生支持,
  进行中切 folder 会被 `ChallengingAnotherRushBattle` 挡住,放弃=giveUp→reset,run 语义现成);
  ②**奖励层选择**——B1 的选一宝箱/box gacha 承担 roguelike 的"三选一"体验。
- **B3 诅咒词条(M3)**:quest 的 `battle_enemy_condition_1..5` 列给敌方挂词条,
  随轮数递增做"深渊诅咒"压力曲线。
- **Meta 进度**:结算按 max_round 发 boss 硬币 → `boss_coin_shop`(6566 行,服务端 shop.ts 已通)。

## 4. 改动清单

### 4.1 客户端 ② 层(全走 `wf_quest_lib.py` 读改写 + `wf_publish.py` 发布,别名已加)

新活动 id **700099**(避开现网 7000xx;quest_id 规则 = `{event6位}{序号3位}`):

| # | 表 | 改动 |
|---|---|---|
| 1 | rush_event | +1 行:排期四时间戳拉满(2000→2099 常开) ,banner 复用 combat_diver 路径 |
| 2 | rush_event_quest_folder[700099] | 4 个 folder:中级5轮/高级8轮/超级10轮/无尽(quest_kind=2) |
| 3 | rush_event_quest[700099] | 每轮 quest:round、field_data_id、敌等级、修正列;首版 1 quest/轮 |
| 4 | rush_event_battle_quest_correction[700099][4] | 无尽缩放曲线(抄 700007 再调斜率) |
| 5 | field_data | +N 行(复用现有 terrain/field) |
| 6 | zone | +N 行(小怪波+boss 波;boss 从 119 家族选) |
| 7 | event_list | +1 行 `11,700099,700099` |

新资源文件:**0 个**(banner/背景/地形/boss 动画全部复用)。

### 4.2 服务端 ① 层

| # | 文件 | 改动 |
|---|---|---|
| 1 | assets/rush_event_quest.json | +700099001..N(rushEventId/FolderId/Round 三字段) |
| 2 | assets/rush_event_quest_folder.json | +700099 轮次奖励表 |
| 3 | src/routes/api/rushEvent.ts | folderMaxRounds 支持 700099(现为硬编码 2/2/2,顺手改成按 JSON 推导) |
| 4 | src/lib/quest/finish/rush-handler.ts | +轮间战利品钩子(box 券/选一箱/boss 硬币,按 round 配表) |
| 5 | (M3)item 路由 | item_bonus_select 兑换端点(若实测客户端选一宝箱不可用) |

## 5. 里程碑

- **M0 时间旅行验证(零改动,先做)**:后台把服务器时间设到 **2025-06-05 12:00**
  (700007 可玩期 2025-05-29 12:00 ~ 2025-06-12 23:59,rush_event 表实测;
  之前写的 06-20 落在结算/领奖期,进不了战斗),
  真机进「狂热激战」跑通:连战→无尽→队伍锁→结算。确认私服 rush 全流程可玩,
  同时观察无尽模式修正曲线是否生效。
- **M1 数据 PoC**:`wf_rogue_build.py` 生成 700099(固定 3 轮:妖狐→白虎→青之女王,
  每轮小怪波+boss 波),发布 → 真机验证新活动入口/连战/波次切换。
- **M2 无尽 + 轮间战利品**:无尽 folder + 缩放曲线;服务端 finish 钩子发 box 券/硬币。
- **M3 选路与诅咒**:同轮多 quest UI 验证 → 变体选路;enemy_condition 诅咒;
  boss 池每日随机(服务端按日期种子改 assets 或预生成多套 folder)。
- **M4(可选)**:GUI 加「连战编辑」tab;新 boss 换皮(克隆动画资源到新路径)。

## 6. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| ~~rush UI 同轮多 quest 展示未知~~ | 已闭合 | 客户端实锤只显示 1 个(§9.1),B2 已改道 |
| ~~correction 是否只在无尽 folder 生效~~ | 已闭合 | 实锤只在无尽生效(§9.2);rush 轮难度用每轮 quest 自带修正列 |
| 新 event id 引用的资源路径缺失导致崩溃 | 低 | 全部复用现有路径;发布前用 wf_quest_lib 哈希撞库预检 |
| 三层表写坏导致客户端 /load 崩溃 | 低 | wf_quest_lib 写前自校验+自动备份;先金丝雀(只加 event_list 行)再全量 |
| 队伍锁仅客户端强制 | 无 | 单人玩法不影响;服务端已有记录可后续校验 |

## 7. 已完成(2026-07-06)

- [x] `wf_quest_lib.py`:任意深度嵌套 orderedmap 读写,12 表结构往返自检全过
  (含三层 boss_battle_quest/main_quest、zone、rush 四表、general_boss)。
- [x] `wf_publish.py` TABLE_ALIASES 补 17 个 boss/副本/rush 表别名。
- [x] 素材验证:192 个小怪→boss zone、rush 服务端三件套、box_gacha 端点、
  13 种选一宝箱、event_list 注册规则、服务端 rush JSON 形状(700007001 键规则)。

## 8. 下一步操作(需真机配合)

1. M0:后台设服务器时间 → **2025-06-05 12:00**,重启游戏进「狂热激战」实测(无数据改动,零风险)。
2. M0 通过后我再写 `wf_rogue_build.py` 生成 700099 并发布(M1)。

### 8.1 已落地(2026-07-12)

- [x] `assets/item_bonus_select.json`:13 种选一宝箱镜像(effect=22 全量,CSV 引号安全解析,
  由 `master/item/item.orderedmap` col6=22 + col22=select_bonus_id 关联 bonus 表生成)。
- [x] `src/routes/api/item.ts /use_item` 补 effect-22 分支:校验 selectIndex(1 基)/持有量 →
  扣箱 + setPlayerItemSync 发奖(upsert,防未持有道具裸 UPDATE 无效)→ 响应 `item_list`
  带两条增量;体力药逻辑不变,混合请求兼容;box-only 时 user_info 为空对象。typecheck ✅。
- [x] 邮件可直接发箱子:13 个 id 均在 `assets/item_ids.json` 校验集内。

## 9. 客户端实证补充(2026-07-12,AS3 反编译逐行核验)

代码根:`弹国服/scripts/`。本节把 §6 两个"未验证"风险证死,并新增 3 个 M1 硬约束。

### 9.1 同轮多 quest 选路(B2)——否定

`RushEventQuestFolderLogic.getViewableQuests`(questKind=1 分支):按 round 排序 →
过滤 `!isCleared && isViewable` → **`return [_loc4_[0]]` 只返回第 1 个**。
且 `RushEventQuestLogic.isCleared`(rush 型)= `get_round() < rushEvent.getRushBattleRound()`,
纯轮数比较;`getRushBattleRound()` = 服务端 `rush_battle_played_party_list` 条数 + 1,
与具体 quest 无关。另 `getRushBattleProgressInfo().totalRound = folder 内 quest 总数`,
同轮塞多 quest 会把进度条撑成错的。⇒ B2 结构性不可行,已改道(§3)。

### 9.2 修正曲线——只在无尽生效 + 分段线性插值/外推

`RushEventQuestLogic.getCorrection`:questKind=1 直接 `Option.None`;questKind=2 查
`rush_event_battle_quest_correction[event][folder][questNo]`(键=轮数)——
**轮数命中键直接用;落在两键之间按 9 个修正字段线性插值;超过最大键沿最后两键斜率
线性外推到无穷;低于最小键以 quest 行自带修正列为 round-0 锚点插值**。
⇒ 无尽曲线只需给稀疏关键轮(如 1/10/30/100),客户端自动平滑;
外推意味着曲线尾段斜率决定"软上限",设计时末两键斜率别给太小。

### 9.3 轮间无缝衔接依赖 view_condition 链(M1 生成器硬约束)

结算界面「下一轮」按钮 = `getNextQuestInQuestResult`:在可见 quest 里找
**view_condition 引用了本 quest 通关**的那个(无尽型则永远指向自己=无限循环)。
700007 实测:第 N 轮 quest 带 `16,700007,,<前一quest序号>,<前一quest_id>` 视认条件,
第 1 轮为 `(None)`。⇒ **wf_rogue_build 生成每轮 quest 必须挂"通关上一轮"条件,
否则每轮打完都会退回选关界面,连战体验断裂。**

### 9.4 选一宝箱(B1)——客户端全通,服务端缺口已精确定位

- 链路:item 表行 `effect=22` + `select_bonus_id` → `master/item/item_bonus_select`
  (13 行,每行 name + 6×(kind,amount,item_id) + reason_id)→ 背包点开
  `AdventureGiftDialog` 6 选 1 → `POST item/use_item`,body =
  `{items:[{id, number, selectIndex}]}`(selectIndex 从 1 起)。
- 成功后客户端**不读响应里的奖励内容**(本地按 master 表 + selectIndex 弹 toast),
  只需响应 `item_list` 同时带宝箱扣减与所选道具增量。
- **服务端缺口**:`src/routes/api/item.ts /use_item` 目前只处理 effectKind 2/3(体力药),
  effect 22 被跳过→400。补一个分支即可:校验持有→按 item_bonus_select 行发
  `bonus{selectIndex}` 的 (item_id, amount)→回 `item_list` 两条增量。
  需要服务端镜像一份 item_bonus_select 数据(建议 assets/item_bonus_select.json)。
- 现成 13 种箱子(item_id → bonus 行):999100/999101/999102(养成素材铜/银/金),
  70033-70039(始/力/真/极/心/意/空),**70040-70042(★3/4/5 崇高辉石自选箱,
  直通 EX Boost 体系)**——roguelike 构筑闭环:过轮→自选箱→选属性辉石→抽 EX 词条→下一轮。
- CN 复原 store 已确认表在 `master/item/item_bonus_select.orderedmap`
  (注意 rush 系表实际在 `master/quest/event/` 目录,不是 `master/quest/`)。

### 9.5 服务端硬编码确认

`src/routes/api/rushEvent.ts:102` `rushEventFolderMaxRounds` = {中级:2, 高级:2, 超级:2}
写死;M1 改为按 `assets/rush_event_quest.json` 每 folder 取 max(round) 推导(§4.2 #3)。
rush 全部 10 个端点(summary/select_folder/ranking×2/aggregated_time/party/battle/start/
reset/reward/endless_battle)均已实现,giveUp→reset 链路服务端现成。

### 9.55 「击败 boss 不结算直接下一个」——floor 多层机制(2026-07-12 晚,用户新需求)

用户要的核心体验(参照:维·索拉斯领主战/摇曳的迷宫)。逐层逆向结论:

- **维·索拉斯三档(1001001-3)全是单 wave 单 boss**(zone multi_normal_1_1_1,
  boss1=boss1_multi=owl_multi,_multi 只是多人变体),它没有战斗内连战。
- **zone 全库 1089 行扫描:官方没有任何 boss→boss 的多波链**——187 个多 wave 范本
  全部是「小怪波(obj0)→末波 boss(obj1)」。boss 波放非末波是无先例操作(引擎侧
  ZoneImpl/startTransition 完全通用,无"boss=末波"假设,理论可行,金丝雀 B 验证中)。
- **真正的官方"无结算连 boss"机制 = quest 的 floor(层)系统**:
  - `Battle.as` 主循环:全 zone 目标完成 && `floor != numFloors-1` → `changeToNextFloor()`
    = NextFloor 状态(~1.5s 胜利姿势 + `goUpToNextFloor()` 原地上跳),**无结算、无服务器
    往返、HP/状态跨层保留**;最后一层才 QuestClear。换层还有词条钩子
    `triggerNextFloorAbility()`("每层开始时"词条的设计空间)。
  - floor 数据:quest 行 `tower_floor_id` → `master/battle/floor.orderedmap`
    (MasterArray:一键可嵌套多行,每行 = field_data_id,bgm_prefix,thumbnail 3 列,
    每层各自 field/terrain/zone → 各自 boss)。资产在开战时全层预载
    (BattleAssetPathCollectionBuilder 遍历 floorValues)。
  - **仅 Tower 战斗类可多层**:BattleQuestKind index 2(Tower)/3(TowerNoClearRank)走
    getTowerFloorValues;**rush/主线/领主战等其余 13 类全部硬编码单层**(case 10=RushEvent
    实锤)。Tower 类宿主 = challenge_dungeon_event_quest(崩坏域 1001-1046 +
    **摇曳的迷宫宝物域 2001-2006** = treasure_cave_quest)+ tower_dungeon_event_quest
    (幽玄域,480 行)。quest 的 kind 列(TowerQuestKind)决定 Story/Tower。
  - ~~CN 数据 floor 全单层~~ **勘误(2026-07-12 晚)**:官方 floor 键大量是**多行多层**
    (chunk 内多行文本;之前只查了嵌套结构没查行数)——深层域 area_red_01 等 = 2-3 层,
    幽玄域 area_09/10 系 = 每 quest 3 层(quest 名【1~3层】即此)。机制在 CN 客户端
    **官方在用、实战验证**,金丝雀 A 已真机通过(v1.4.87,树人→索拉斯双层无结算连打)。
- **金丝雀已发布(v1.4.86,2026-07-12)**:
  - A(floor 多层):floor 表新键 `mod_chain_canary` 嵌套 2 行(树人层 treant_single →
    维·索拉斯层 multi_normal_1_1_1);quest 2001(宝物域【暗】)col110 指向它。
    预期:进场即树人 boss → 击杀 → 换层演出(不结算)→ 索拉斯 → 结算一次。
  - B(zone boss→boss 波):zone `treasure_cave_area` 加 wave1(树人)/wave2(索拉斯),
    生效于宝物域 2002-2006。预期:20 小怪 → 树人 → 索拉斯,过场 outhole 全套原装。
    关键观察点 = 树人(非末波 boss)死后是否推进。
  - 哨兵格式:boss 波 col1 空(BossClear 不读)、zako 区 code=(None)/间隔空串、
    boss2-3 区 kind=(None)/code 空串(与官方 treant_single 行逐列核对)。
  - ⚠ **floor 多层的正确物理格式(F2058 实錘教训,v1.4.86→87)**:MasterArray 表
    (floor 等)的多行 = **一个键下单 zlib chunk 内多行文本**(`MasterBinarySlice.getTable()`
    整块解压后按行 CSV 解析);写成嵌套 orderedmap(getMap 的索引格式)客户端解压即
    F2058"资源文件已损坏"。嵌套 map 格式只属于 zone/quest 系(getMap);
    单行表走 getRow(同样整块解压取第一行)。wf_quest_lib 写法:
    `floor[key] = 'line0\nline1'`(str 叶子,勿用 dict)。
  - 表别名已补:floor / challenge_dungeon_event(_quest) / tower_dungeon_event(_quest)。
- **组合设计推论**:A 成功 ⇒ 「深渊连战」每轮可以是 3-5 boss 无结算 gauntlet
  (骨架换 challenge/tower dungeon 事件,或 rush 轮间保留快速结算);B 成功 ⇒
  任何 quest(含 rush 轮)都能在 zone 层做 boss 连打,自由度更高。
- **A 真机验证通过 + 生成器落地(2026-07-12 晚)**:`mod-tools/wf_chain_build.py`——
  素材池 = 官方 floor 表全部带 boss 的层行(~160 行/80+ boss,深层域+幽玄域+宝物域,
  field+BGM+缩略图三元组全部实战验证);`--floors N --seed S --write --publish` 一条命令
  重摇+发布,种子默认当天日期(**每日随机塔**:定时跑即可;每 run 随机不可行——
  客户端主数据静态)。当前线上(v1.4.90,seed=20260712,5 层):妖狐→幽玄猫头鹰(9层特殊)
  →废弃雷龙→雷白虎→风魔。宿主仍是宝物域【暗】2001。

### 9.6 700007 活样本(M1 直接抄的列参照)(见文末 §10 金丝雀落地)

`rush_event_quest[700007]` 8 行:quest_id, folder, round, sub_name, 缩略图, 起止时间,
view_condition(16,event,,序号,前quest_id | 首轮 (None)), …, 敌等级 4 列
(如超级 234,810,780,810), 9 列修正(1,1,1,… | 超3: 0.7,40,35,1,3.75,0.94,1,1,9),
体力(30/50/80), 档位, 报酬, field 键(rush_guardian_totem_1 / administrator_another_dark_rush /
big_boss_anv1_rush), BGM(combat_diver_battle_normal/extreme), 54000(帧=15min), 0, 100。
超级第3战另示范 `battle_enemy_condition` 用法(`2,-4`);无尽行 round=0
(服务端 `rushEventRound===0 → ENDLESS` 判据一致),其修正列即插值 round-0 锚点。

## 10. Roguelike 金丝雀落地(2026-07-13,服务端代码已就绪)

目标体验升级(用户确认):开局只选 3 主位(无武器)→ 每轮掉落 角色/武器/魂珠 当场可用
→ 跨局随机 buff(EX Boost 走 DB,下局登录生效)。模式专属背包 = 专用子存档(开局/结束各重启一次)。

### 10.1 本轮客户端新实证(AS3 反编译)

- **所有 API 响应**统一过 `Logic.as:974 → PlayerLogic.applyCommonResponse`:
  - `equipment_list` = **upsert 本地背包**(applyCommonResponseEquipmentList)⇒ 掉武器/魂珠
    当场进背包,轮间编队即可装,**不用退出**;
  - `character_list` **只对未持有角色 addCharacter**(hasCharacter 则跳过)⇒ 掉"新角色"
    客户端原生支持;但**推送已持有角色的字段更新(EX Boost 等)不可行** ⇒ 跨局 buff
    只能写 DB、下局登录生效(与"run 边界=重登"天然咬合)。
- **角色锁定**(RushEventPartyGroupHolder.getRecordedCharacterIds)纯由服务端下发的
  played_party_list 驱动;而 **folder 轮进度 = 该列表条数+1**(§9.1)⇒ 解锁不能清空列表,
  正确姿势 = **保条目、洗角色ID**(服务端序列化时全置 null)。
  反向硬锁(第1轮后把"其余所有角色"编成假条目下发)理论可行,folder 模式慎用(条数=轮数!),
  无尽模式可用,未金丝雀。
- ⚠ **RushEventQuestSelectScene.run(:239)**:本 folder 存有**非空 clear reward** 时,
  选关列表被替换成 `[getLastQuest().withConditionDisabled()]` ⇒ **folder 非最终轮禁止填
  rush_battle_reward_list**(跳关漏洞);无尽轮无害(last quest=自己),可展示。
- `rush_battle_reward_list` kind 白名单(rewardListToGeneralRewardKinds):**1=Item
  5=Character 6=Equipment**,8=Mana 9=PooledExp 13=Degree 17=PassCardPoint,
  其他值=ClientError 3446。

### 10.2 服务端改动(已 typecheck + npx tsc + 离线冒烟)

| 文件 | 内容 |
|---|---|
| `assets/rogue_event.json` | 金丝雀配置:`enabled` 总开关 + 按 event 配 `unlock_played_parties` / `per_round_drops`(type=item\|equipment\|character)/ `drop_character_exp` / `show_reward_list_endless`;**热重载**(reload_assets) |
| `src/lib/assets.ts` | rogue_event.json 进 MOD_ASSET_FILES + `getRogueEventConfig(eventId)` |
| `src/lib/rush.ts` | `getSerializedPlayerRushEventPlayedPartiesSync`:rogue 事件洗掉角色/协力/进化列(条目保留),唯一下发出口全覆盖(summary/endless_battle/finish/raid) |
| `src/lib/quest/finish/rogue-drops.ts` | **新模块** `handleRoguePerRoundDrops`:通关每轮按配置发放,角色重复自动折算道具;可选给掉落角色灌经验;**rush-handler 保持上游原样**(减 rebase 冲突) |
| `src/routes/api/singleBattleQuest.ts` | 调用 rogue-drops;响应合并 items/equipment_list/character_list/add_exp_list/bond_token_status_list/exp_pool(绝对值);**顺带补了 rushEventRewardsResult.character_list 漏合并**(上游缺口) |

### 10.3 真机金丝雀步骤

1. 后台服务器时间 → **2025-06-05 12:00**;重启 start-cn.bat(out/ 已重编);重启游戏。
2. `rogue_event.json` `enabled=true`(掉落角色 id 换成测试存档**未持有**的),
   `POST /api/mod-admin/reload_assets` 热生效。
3. 进「狂热激战」folder 打第 1 轮,验证:
   - 结算回编队:第 1 轮用过的角色**可再选**(洗 ID 生效);轮进度正常推进(条目保留);
   - 下一轮编队:新武器(默认 1010001 老旧短剑)出现且可装;新角色进角色列表可编入;
   - 非最终轮结算**不显示**战利品列表(防跳关,设计如此);最终轮显示 官方奖励+掉落。
4. 无尽 folder 重复:战利品列表展示 + endless next_round 推进 + 同队连打。
5. `drop_character_exp` 0→50000:掉落角色本地等级是否当场生效
   (DB 必生效;本地不生效=重登补正,已知可接受)。

### 10.35 真机金丝雀结果 + 方向修正(2026-07-13 下午)

- **✅ 掉落链路真机通过**:无尽战斗打一轮,魔像(角色)+炎之信赖(魂珠)当场到账
  (DB 复核 zzhan 角色 474→475、装备 427→428),中途不退出即可用。
- **方向修正(用户)**:不做角色限制(编队全开就全开,sub 也随便选),
  **只做独立武器池** = `wf_rogue_save.py` 空武器存档 + 掉落池。
- **掉落池已实装**:rogue-drops 支持 `drop_pool`(加权)+`pool_draws`(每轮抽N),
  与 `per_round_drops`(固定)叠加;配置见 assets/rogue_event.json。
- **掉落成品化(2026-07-13 晚,C2287 闪退勘误后二版)**:`drop_equipment_level`
  (觉醒等级)**按件钳制**到 equipment 表 col8=max_level——**385 件上限 5、51 件上限 1**
  (含全部主线宝珠和部分武器),镜像 `assets/equipment_max_level.json`(由 ② 表生成)。
  ⚠ 语义勘误(C2284/C2287 实锤):players_equipment.level=**觉醒/进化等级**(超 col8
  上限→C2284 进战斗即崩);enhancement_level=**特殊改造等级**(equipment_enhancement
  表仅 29 键有定义,其余上限 0,超限→C2287)——它**不是**"武器等级",全局拉满是闪退
  制造机,已从配置移除,只留按件觉醒钳制。DB 行与响应 equipment_list 同步补丁,
  客户端当场拿到按上限满觉醒的武器。
- **魂珠体系实锤(2026-07-13 晚,"魂珠随便选"排查)**:编队魂珠的持有判定读**道具背包**
  (`OwnedAbilitySoulRepository`:players_items 中 item 表 col14 category==5 且数量>0),
  **不是装备背包**;436 个魂珠道具与武器**同 id 同键**(武器↔魂珠道具↔ability_soul 三表同键)。
  equipment 表 kind=1 的"主线宝珠"是**武器位装备**(category=主线宝珠),与编队魂珠是两回事。
  肉鸽档已清 434 颗魂珠道具;`wf_rogue_save.py` 建档流程补了清魂珠步骤
  (清单镜像 `assets/soul_item_ids.json`);掉落池魂珠 = type "item" + 武器同 id,
  响应走 item_list 合并当场可用。
- **难度调参**:`wf_rogue_nerf.py` 调 rush 修正曲线(--hp-scale/--hp-values/--atk-scale,
  dry-run 默认,--publish 直发);700007 无尽 boss 血已从官方 1/4/15/…/440 换成
  0.5→6 缓坡(1.4.114),攻击曲线保留官方。
- **属性匹配掉落(2026-07-13 晚,真机反馈"属性不同无法使用"后)**:魂珠(和部分武器词条)
  按元素硬门槛,纯随机会掉一堆用不上的 ⇒ rogue-drops 按**通关队伍的元素**过滤池子
  (match_party_element 默认开;partyCharacterIds 来自结算请求,元素查 character.json;
  装备元素镜像 `assets/equipment_element.json` = GUI 同款 token 检测,-1=通用;过滤空回退全池)
  + **保底武器**(guarantee_weapon 默认开:第一抽只从武器抽,不再出现一轮全魂珠)。
  池子重配:每属性 剑+斧 各 1(全 max_level=5)+2 通用+同键魂珠(权重0.5)——
  剔除了 max_level=1 的武器(不可觉醒,观感差)。run 重置:`wf_rogue_save.py --reset 10 --apply`。
- **boss 变化的机制边界**:无尽档=单 quest 无限循环(客户端"下一轮永远指向自己"),
  同 boss 必然,变化只能靠修正曲线;每轮不同 boss = folder 多轮(700007 超级=3轮3boss
  现成)或自制 700099(M1);"随机"上限=每日种子重摇发布(同连战塔),
  每次进本随机需客户端补丁(random-floor 同款瓶颈)。轮内多 boss 可用 zone 多波。
- **每局随机 boss(2026-07-13 晚落地)**:run 重置本来就要重启游戏 ⇒ 重置时顺带把
  无尽 quest 的战场重摇 = 每局不同 boss。`wf_rogue_save.py --reset 10 --random-boss
  --restart-game --apply` 一条命令:杀游戏→清状态→随机换 rush_event_quest 行
  col98(battle_field_data_id)+col99(BGM)为连战塔素材池(wf_chain_build.build_pool,
  80+ 实战验证层)随机一层→发布→拉起游戏。⚠ 塔场地在 rush quest 下的首次真机验证
  待跑;崩了再 roll 一次或把 col98 改回 big_boss_anv1_rush。
- **`mod-tools/wf_rogue_save.py`**:克隆存档→清 players_equipment→洗 players_parties
  的 equipment_1..3/ability_soul_1..3→改名→默认存档切回源(cloneSave 接口副作用是
  切默认,必须切回)。已生成 **player 10「肉鸽空武器」**(475角色/0装备/道具全保留)。
  开局 run = admin 切默认存档到 10 → 重启游戏;结束切回 8。
- **⚠ H404 一例未归因**:出现在资源加载 0.00% 界面;get_path 253 个包全在盘,
  服务端主动 404 只有 [PATCH-MISS](逐文件下载缺文件,今天连发 1.4.105-112 包,重点怀疑)
  与 [UNKNOWN](未实现接口),都会打进服务端控制台——复现时看控制台行。

### 10.37 M1 落地:700099「深渊连战」(2026-07-13 晚,待真机金丝雀)

- **生成器 `wf_rogue_build.py`**:一条命令生成/重摇整个活动(--rounds/--seed/--write/--publish)。
  ②层四表模板全克隆自 700007(零新资产):rush_event 行(string_id=mod_rogue_gauntlet,
  常开 2000→2099 ⇒ **不用时间旅行**)、folder 1「深渊连战」(kind=1)、quest round 1..N
  (c0=700099000+r,view_condition 链 §9.3,c67 体力=0,c95 等级 80,c86-94 缓坡
  hp 0.5×1.185^r / atk 0.35×1.13^r,c98 战场=连战塔素材池 seed 抽样不重复)、event_list kind 11。
  服务端 json(rush_event_quest/folder,静态 import 须重启)同步写。
  塔场地×rush×等级80 组合已在 --random-boss 无尽局真机验证过。
- **folderMaxRounds 改按 JSON 推导**(assets.getRushEventFolderMaxRounds,按 event 分组
  ——folder id 跨活动重复,旧的扁平硬编码把所有 folder 卡在 2 轮;700007 超级实际 3 轮
  的既有 bug 一并修复)。rush-handler/rogue-drops 均改用推导值。
- 掉落:rogue_event.json 增加 "700099" 条目(与 700007 同款智能掉落)。
- 重摇阵容:换 --seed 重跑 --write --publish(轮数不变时服务端 json 内容不变,可不重启)。
- 首发 seed=20260713:鬼→机甲→光执政官→独眼巨人→火魔像→恶魔×2→暗物质→妖狐→水寄居蟹,
  发布 1.4.117。
- **v2(1.4.118,真机首轮金丝雀反馈后)**:①**必须带无尽 folder**——rush 场景的 ∞ 按钮
  是固定 UI,活动没有 quest_kind=2 folder 时点击 C3442「エンドレスバトルが存在しません」
  (+连锁 G1002);生成器补 folder 2 + 无尽 quest(键 99,round=0)+ 修正曲线
  (抄 700007 无尽现值=缓坡);②每轮缩略图:⚠ floor 行第 3 列是塔层 31×31 小图标
  (有的不在 store),放 quest 预览位=空白(1.4.120 实锤)——v3(1.4.121)改用
  **field→宿主 quest 缩略图映射**(tower_dungeon_event_quest 缩略图 c3/floor 键 c99、
  challenge_dungeon_event_quest c3/c110,经 floor 行摊开,220 field 全覆盖,240×188);
  ③**boss 元素机制实锤(v4)**:general_boss 行 c0=元素 kind(0=Inherit 1火..6暗 7=Colorless);
  客户端把 quest 的 **c69(battle_recommended_element)当 questsElement 传进 ZoneSource**
  (BattleQuestBaseImpl:2416)——**Inherit/Standard boss 的战斗元素 = c69**!生成器令
  c69=boss 实际元素:固定元素怪查表真值,Inherit 怪(oni/fox/cyclops/ghost_girl/evil 等
  模板怪)由种子随机指定 → "推荐属性"显示的就是 boss 属性,同时决定模板怪变体;④连战多轮真机已验证(3 轮 3 boss,轮链/掉落/属性匹配全通;
  folder 非最终轮结算不显示掉落=防跳关设计,武器实际入包)。
  ⚠ 两个 rush 活动同时活跃会互相顶(时间旅行时 700007+700099 并存)——建议服务器时间
  恢复系统时间,700099 常开不需要旅行;兑换道具按钮=克隆的 combat diver 商店引用,未配,勿点。
  无尽每局随机 boss:`wf_rogue_save.py --reset 10 --random-boss --event 700099
  --quest-no 99 --restart-game --apply`;连战阵容重摇:`wf_rogue_build.py --seed N --write --publish`。
- **⚠ rush_event 行时间列勘误(1.4.120)**:**c2=banner_schedule(横幅轮播排期)**,
  真正的活动期是 **c15=start_time / c16=playable_end_time / c17=exchangeable_end_time**
  ——生成器 v1/v2 把常开时间写进了 c2,c15-17 留着模板的 2025-05/06 档期,导致时间
  调到 2025-07-31 后活动过期下架"找不到"。已修表+生成器(且 700099 行存在时以现有行
  为基底,不再覆盖已定制的横幅列)。
- **专属横幅(1.4.119)**:`wf_rogue_banner.py --main 图 [--boss 图] --write --publish`
  ——任意尺寸自动缩放(主 1000×184 / boss 377×199),png_encode 写新逻辑路径
  `quest/event/banner/rush_event/mod_rogue_gauntlet_banner_001`(c3 三轮播位同指)+
  bossbattle_banner(c4),表文件+资产一起走 pending 发布。资产哈希=含 .png 的逻辑路径,
  表内引用不带扩展名。多期激战并存时靠横幅区分。

### 10.38 v5:代币经济 + 跨副本楼层(2026-07-13 晚,用户重设计,待真机)

- **玩法转向**:放弃空武器沙盒(默认存档已切回主档 zzhan),全武器全角色出战;
  通关奖励 = **深渊代币**(item 2370099,克隆激战代币 2370007,图标暂共用,
  rogue_event.json 每轮 5 个),后续接兑换商店换「深渊武装」。
- **15 个占位武器**(`wf_rogue_rewards.py`):8000101-8000115 = 每属性剑/斧各一
  +通用×3,克隆 equipment 行+同键 ability_soul 词条行(soul_id 指回自身),名字带
  「占位」,GUI 武器页可直接改名/改词条;五个服务端镜像已同步
  (max_level/element/lookup/equipment_ids/item_ids,后两个=邮件校验,须重启服务端)。
- **楼层 v5**(默认 11 轮):1-2=随机主线小怪房(28 池,zone 无 boss 有小怪)、
  3=随机领主战(143)、6=随机机兵(高难多人 6)、8=随机降临讨伐(99)、
  9=女帝歼灭者(epuration_boss_highest)、11=战阵之宴·无幻之宴(raid 7001,
  field=abyss_cloud)、4/5/7/10+无尽=塔池。所有来源 zone 的单人位 boss1 已核验非空;
  field 提取用 wf_boss 的"单元格∈field_data 键"法,来源 quest 缩略图直接沿用。
- 待办:**兑换商店**(代币→深渊武装,700099 的兑换道具按钮当前未配);
  金丝雀点:小怪房通关判定/机兵·降临·女帝·无幻单人进本/每轮+5代币/占位武器邮件发放。

### 10.39 v6:随机场地效果 + 15 层终始之龙(2026-07-13 深夜,待真机)

- **场地效果载体 = battle_enemy_condition_1..5**(quest 行 c71-80,每槽 kind+strength
  两列):kind 0能力/1直击/2弹射/3技能 = XX伤害耐性(**strength 小数比例**,正=敌减伤=
  玩家减益,负=敌易伤=玩家增益;官方超3 用 -4=受伤×5 实锤单位),kind 4=敌方减益免疫。
  战斗侧 = resolveInitialEnemyCondition→ConditionChangeContent,敌人开场挂永续状态
  (time 9999999,EnemyImpl:1499)。效果文字写进 **c3 sub_name** 展示。
- **排程**:1-4 层无;5-6 层 1 减益;7-9 层 2 减益;10 层起 减益免疫+2耐性+2易伤
  (5 槽拉满=「双增益三减益」,免疫强制入选保证增益槽位);强度随种子
  (耐性 20/30/40%,易伤 30/40/50%)。无尽档暂不挂效果。
- **15 层终始之龙**:⚠ 剧情版 **main_12_10_01/chapter12_boss_story** 自带 NPC 协力
  (史黛拉/蕾薇/阿尔克 = zone/terrain 里的场景对象,不是 quest 协力位,换 field 也带着)
  + **「无法强化效果」剧情 debuff 无法解除**(真机实锤,v6)——改用**多人战版**
  `eye_dragon_multibattle`(始龙之眼,general_boss c0=7 无色,干净无剧情机制,
  advent 100010001 宿主缩略图 world_10/thumbnail1)。v6.1 已换。
- **「机兵场地 buff」= BattleFeature**(getFeatureValues,questKind 硬编码,rush 类无
  数据列可挂)——**rush 数据不可自定义 feature**;等价替代=已实装的 enemy_condition
  增益减益(数据驱动,与之共存);用户认可现方案。

### 10.40 一键重开按钮(2026-07-13,GUI 工具箱)

- **`wf_rogue_reroll.py`** = GUI 工具箱「深渊连战·一键重开」卡片的后端,一条命令整局重开:
  ①`wf_rogue_build --seed <随机> --write --publish` 重摇全部轮次(楼层来源/boss 元素 c69/
  场地效果 c71-80+副标题)并发 CDN(游戏可开着,发布只影响下次启动);②force-stop 游戏;
  ③**按 event_id=700099 精确清爬塔进度**(players_rush_events + _played_parties +
  _cleared_folders 三表都有 event_id 列——武器/角色/道具/编队/官方 700007 进度不动;
  ⚠ 勿复用 wf_rogue_save.reset_run,它是空武器沙盒时代的,会把存档装备全删);④拉起游戏。
  默认 dry-run;--seed 复现同一座塔;--player 只清单档;--keep-progress 只换楼层;
  --rounds 与线上不同时服务端 json 变化须重启服务端(脚本会 WARN)。
  GUI 卡片默认勾「应用」= 点一下即一键重开;参数:轮数/敌等级/种子/只清存档。

### 10.36 「配队消失」实锤修复:party_id 全局编号(2026-07-13 晚)

- 现象:激战里编好队、装好武器,退出活动再进全部复原。DB 排查:编辑**已落库**
  (players_parties category=4, edited=1),是**回读丢失**。
- 根因(客户端 `RushEventData_Impl_.applyPartyResponse`):所有组的编队存进**一张
  按 party_id 索引的平面表** `parties.h[party_id]`,组只记 partyIds 数组。官方 party_id=
  **全局编号 (组-1)×10+槽(1..120)**——服务端保存路由 parsePartyId 也是这么解析的——
  但私服 `event/rush/party` 与 carnival 的回包发的是**槽位号 1..10**,12 组互相覆盖,
  只剩最后一组的数据 ⇒ 编辑"消失"。已修:rushEvent.ts/carnivalEvent.ts 回包改全局编号。
- 顺带实锤:①无尽/激战编队读写的都是 **PartyCategory.EVENT(category=4)**,与普通编队
  (category=1)独立,rush 与 carnival 共用;②每次进活动 RushEventLoadingTask 都会
  summary→重拉 event/rush/party(applySummaryResponse 会整体重建事件数据 blob);
  ③**cloneSave 克隆管线只搬 category=1 编队,EVENT 编队全丢**(getClientSerializedData
  → serializePartyGroupList 路径),肉鸽档首次进活动由 /party 自动建默认——待修的上游缺口。
- 教训:2026-07-13 下午的"真机测试"实际全程在主档 zzhan(8) 上——wf_rogue_save 建档后
  默认存档被工具切回了源档,用户重启游戏仍登主档。**开 run 前核对 admin 账号页
  defaultPlayerId**。

### 10.4 已知边界

- 掉**已持有**角色 → 服务端自动折算道具,但战利品列表仍显示角色图标(轻微不一致;
  正式版掉落 roll 应排除已持有)。
- 掉落角色本地 Lv1(character_list 响应不带等级),经验灌注的**本地即时性**待验证。
- **"自动穿戴"不做**:战斗队伍由客户端编队后上报,服务端改不了;轮间编队画面两下装上。
- 每次进本随机(random-floor 客户端补丁)仍等 P-code 重做,与本节无关。
