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
- **B2 变体选路(M3,纯数据)**:同 folder 同 round 摆 2~3 个 quest 变体
  (A: 敌HP-30%修正 / B: 敌强化+掉落翻倍 / C: 带助战角色 `battle_assist_character`)。
  玩家选哪个进 = 选路。⚠️ 唯一未验证点:rush UI 对同轮多 quest 的展示,M3 首项验证。
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

- **M0 时间旅行验证(零改动,先做)**:后台把服务器时间设到 2025-06-20(700007 窗口),
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
| rush UI 同轮多 quest 展示未知 | 中 | M1 用 1 quest/轮;B2 推迟到 M3 单独验证 |
| correction 是否只在无尽 folder 生效 | 低 | M0 实测;不行就用每轮独立 quest 的修正列替代 |
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

1. M0:后台设服务器时间 → 2025-06-20 12:00,重启游戏进「狂热激战」实测(无数据改动,零风险)。
2. M0 通过后我再写 `wf_rogue_build.py` 生成 700099 并发布(M1)。
