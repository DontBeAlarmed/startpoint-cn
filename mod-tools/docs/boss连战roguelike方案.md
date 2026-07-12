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

### 9.6 700007 活样本(M1 直接抄的列参照)

`rush_event_quest[700007]` 8 行:quest_id, folder, round, sub_name, 缩略图, 起止时间,
view_condition(16,event,,序号,前quest_id | 首轮 (None)), …, 敌等级 4 列
(如超级 234,810,780,810), 9 列修正(1,1,1,… | 超3: 0.7,40,35,1,3.75,0.94,1,1,9),
体力(30/50/80), 档位, 报酬, field 键(rush_guardian_totem_1 / administrator_another_dark_rush /
big_boss_anv1_rush), BGM(combat_diver_battle_normal/extreme), 54000(帧=15min), 0, 100。
超级第3战另示范 `battle_enemy_condition` 用法(`2,-4`);无尽行 round=0
(服务端 `rushEventRound===0 → ENDLESS` 判据一致),其修正列即插值 round-0 锚点。
