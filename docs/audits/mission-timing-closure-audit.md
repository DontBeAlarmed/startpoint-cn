# 任务系统奖励时点收口审计(2026-10-03)

> 审计范围:`5134d7e3..HEAD`(feat/lose-battle-story-clear 分支)。本报告承接 `docs/audits/mission-semantic-audit.md`(2026-09-12 全量语义审计),记录其后的「奖励时点纠正」系列:四个补面模块、两轮审查、四路全量审计的结论,以及当前仍按兜底处理的已知延迟清单。
> 症状口径:①奖励发放时点不确定(时点偏移);②任务无法完成。审计方法:4 路并行子审计(cat1 时点矩阵 / cat5 称号族 / Active Mission·觉醒·周期 / 无法完成全景)+ 2 路独立对抗审查,全部结论经源码与 CDN 数据复核。

## 一、系列提交索引

| 模块 | 提交 | 结算面 | 窄域清单 |
|---|---|---|---|
| 经验注入 | 5134d7e3 | `/expod/inject_exp` | cat1:9/36/39;cat5:3000/3010/3020 + cond44(按角色) |
| 玛纳板学习 | cf2f7800 / f102a33b | `learn_mana_node` | cat1:37/96/39;cat5:cond44+48(按角色+聚合族)+cond7/8 |
| 界限突破 | 7d02ccf7 / 574cd353 | `over_limit` / `bulk_over_limit` | cat1:38;cat5:cond9(degree_overlimit_growth_) |
| 角色获得 | 562248c8 / 633fab98 | gacha exec / crazy select / exchange / box gacha | cat1:32/33;cat5:companion 族(degree_companion_add_) |
| 装备获得/升级 | 11a36690 / 5abc1481 | equipment upgrade / bulk_upgrade(升级即觉醒) | cat1:67(既有 operation settle)/68(新增);cat5:cond36 |
| 玛纳加算 | a11dbcba / 8184df5d | `/item/sell` | cat1:40 |
| 审计收尾 | f102a33b / 7beb8179 | expod degree_list 发布;learn cond7/8;宝石店 cond45;over-limit/crazy/exchange/box 补 Active Mission publish | — |

既有结算面(系列前已存在):战斗 finish(cat1 全量 + degree 白名单 24 类)、story finish(clear_episode+剧情称号)、/load(登录族+校准)、任务页 get_mission_progress(请求类目全量)、open_mana_board(cat1 全量)、operation settle(宝石店消耗 41/装备觉醒 67 + cat5 42000/45000/8000 族)、party 魂珠(65)、update_mission_progress(107 twitter)。

## 二、修复关闭表(2026-10-03)

| Finding | 状态 | 修复 |
|---|---|---|
| T-F1 inject-exp 注入不结算角色等级任务 | 已关闭 | 5134d7e3;f102a33b 补发布 degree_list(独立审查 P1) |
| T-F2 learn/awake 显式 null(玛纳板 37/96) | 已关闭 | cf2f7800;awake 经核实不改 cat1 事实,null 正确保留 |
| T-F3 信赖证授予时点(39/44/48)无结算 | 已关闭 | 009c81af;48 按角色+聚合族收窄(f102a33b);cond7/8 同批补入(7beb8179) |
| T-F4 界限突破(38/突破称号)无结算 | 已关闭 | 7d02ccf7;degree_list 发布修复(574cd353);AM publish 补齐(7beb8179) |
| T-F5 角色获得(32/伙伴称号)无结算 | 已关闭 | 562248c8;box gacha 链补齐 + viewerId 穿线(633fab98) |
| T-F6 装备获得(33)/5级持有(68+cond36)无结算 | 已关闭 | 11a36690;注释事实订正(5abc1481) |
| T-F7 卖道具玛纳(40)无结算 | 已关闭 | a11dbcba;时间源 getRealNow(8184df5d) |
| T-F8 宝石店购买次数称号(cond45)零结算点 | 已关闭 | 7beb8179(purchase-owner TREASURE 分支窄域) |
| T-F9 over-limit/crazy/exchange/box 缺 Active Mission publish | 已关闭 | 7beb8179(AM-F2 模式的第 9-12 操作入口) |
| T-F10 expod 响应丢弃 degreeIds | 已关闭 | f102a33b(独立审查发现) |

## 三、四路全量审计结论(2026-10-03)

### 1. cat1(120 条):113 条有事实源,112 条当场结算

- pattern 全部唯一;38 LIFETIME + 6 持久化增量 + 74 questProgress 选择器 + 7 救援族 fail-closed。
- **唯一残留缺口:mission 66(total_craft_point_addition_count,锻块)**——装备溶解三入口(`/equipment/sell_equipment|sell_stack|bulk_sell_stack`)发放锻块但不结算(与 40 同形状,列为后续补面项,兜底=下次进关/任务页/open_mana_board)。
- 低频兜底(已文档化):商店购买角色/装备(32/33)、邮件附件(32/33/40/66)、任务 33 奖励发放的锻块(66)、活动兑换过期/嘉年华玛纳(40)、/load awake 修复链写节点后的 37/96。
- 核实无需结算面的显式动作:exBoost 破星(只写 exBoost 字段)、characterElection(无 cat1 事实)、receive_bond_token(1→2 不改 status>=1 计数)。

### 2. cat5(1288 条):~1279 条有正确结算点

- condition 白名单内 24 类走战斗 finish;白名单外 13 类中 10 类已有专属结算面(0 登录、3/45 宝石店、4 伙伴、5 等级、7/8 信赖证/板强化、9 突破、34/35/36 装备、48 二板、40-43 客户端上报)。
- 本轮补齐:cond7(degree_manaboard_growth_,3 条)、cond8(degree_proof_of_bond_get_,3 条)、cond45(degree_treasure_shop_buy_count_,3 条)。
- 残留兜底:companion/锻造石的非抽卡/非战斗获取(低频,注释声明)。

### 3. Active Mission / 觉醒 / 周期:零回归

- 9 月审计关闭项(AM-F1/F2/F3、AW-F1/F2、B-F2)逐一核查零回归;AW-F1 `claimStageRewards: false` 约定保持。
- 新窄域面全部仍同事务调用 AM owner(本轮又补齐 over-limit/crazy/exchange/box 四入口);compose 合并不触碰 `active_mission_list` 增量投影。
- cat2/7/10 producer 零改动零缺口;cat9 觉醒 144 条时点语义与 9 月结论一致(信赖证 0→1 新覆盖 learn/inject 正确充分;status>=2 族按第一页领取时重评,设计内)。
- AM 96 条中 35 条 fail-closed 与 UNSUPPORTED 清单和 9 月审计逐字一致。

### 4. 无法完成全景:无新增不可完成

- 表 B(无生产者):Attention/救援族、21030、event 150 回归资格全部保持 fail-closed,`mission_coverage_audit.test.cjs` 3/3 通过(cat3 2485/2512、Degree 1282/1288、觉醒 144/144、Pass 248/267)。
- 表 C(冻结时间):cat3 0/2512、cat4 0/997 复算成立;cat5 启用 1079/1288(9 月文档记 1078,±1 为边界口径差,方向放宽)。
- 表 D(窗口性):pass type 85/16/23 eventId 匹配缺失、kind 7 fail-closed throw、信赖证 status>=2、all-complete row[19] 未纳管——四项全部原样维持(见 §五遗留)。
- 13 个提交全部为「新增结算面或修复」,无任何替换/删除既有结算点;lose_battle(0b8feaa3)方向是「把不可通关变为可完成」。

### 5. 对抗性审查(独立第二意见)

幂等(双结算清单无交集+receivedStages 防重)、事务边界(嵌套 savepoint 随外层回滚)、进度单调(Math.max 兜底)、响应键合并(degree_list 去重、空 item_list 保护交换 `[]` 形状)四个攻击面均未发现 P1/P2 缺陷。

## 四、遗留清单(按优先级,均为兜底可接受或性能项)

1. **[已解决·mission 66 锻块]**:溶解三入口已接窄域结算(cat1 66 族 + cond37 锻块称号族,按 craftPointGet 前缀收窄)——`src/lib/craft-point-mission-settlement.ts`。任务 33 奖励发放的 300 锻块等其它获取路径沿用兜底。
2. **[P2·测试缺口] box gacha / crazy select / equipment bulk_upgrade 的 e2e 结算用例**:三链的当场发布目前靠夹具级/投影级测试覆盖,无端到端 RED 用例。
3. **[已解决·时钟口径]** 窄域结算面统一为服务器虚拟时间(getServerDate,与 finish 兜底同钟);主日切已迁真实业务日(与登录奖励/每日挑战的双轨一致)——见 identity-time-and-load.md 双时钟表与 `tools/real_day_rollover.test.cjs`。
4. **[已解决·响应形状路线统一]** 经 1.8.1 客户端反编译定案(RealRemoteService.as 通用响应解析器):mission_info 为 Option 语义(缺失/空数组均安全,逐条应用);degree_list 不在通用响应解析结构内(称号走 /profile/get_degree_list,通用响应忽略);item_list 空数组与空对象同解析。抑制变体 `mergeMissionSettlementResponse` 已删除,party/singleBattleQuest/characterElection/raidEvent/equipment 全部统一到 `composeMissionSettlementResponse`(空列表以空数组发布,客户端零长度应用)。
5. **[P3·沿用 9 月审计]** pass 85/16/23 eventId 匹配(用户已定案维持现状:官方期次不重叠,私服 CDN 重叠由 CDN 作者负责)、PERF-07、Attention/救援生产者(用户明确不做)——维持 DEFERRED。已定案:信赖证 status≥2(领取进包)、kind 7 降级跳过+告警、all-complete row[19] 启动守卫(2026-10-03)。级联上限实测为初轮+4 级联(MAX=5,材料奖励链驱动 11 条任务)。
6. **[P3·文档漂移]** cat5 冻结时启用 1079(非 1078);`mission-semantic-audit.md` §一的第 41 行口径可在下次修订时更新。
7. **[P3·既有源码结构守卫失配(非本系列引入)** `character_awake_unlock.test.cjs:287` 与 `mission_battle_facts.test.cjs:262` 两个结构断言在早先剧情/结算结构重排后过期,建议专项清理。

## 五、结论

cat1 的 113 条有事实源任务中 112 条、cat5 的 1288 条中 ~1279 条已在其事实产生时点当场结算(其余为已文档化的低频兜底);「玩家显式动作 → 奖励推迟到进关/任务页」的症状类缺口已全部收口,唯余 mission 66(锻块)一处与三个端到端测试缺口。9 月审计的全部关闭项零回归,无任何任务因本系列变为不可完成。任务系统向「完全完善」推进的下一步依次为:66 号补面 → 三条 e2e 用例。时钟口径已完成统一(结算窗口=虚拟时间,日常周期刷新=真实业务日)。
