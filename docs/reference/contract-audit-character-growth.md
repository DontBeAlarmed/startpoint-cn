# 客户端解析契约审计 — 角色成长链 11 端点（expod 等级强化 / 能力盘 / EX突破 / 装备强化 / 信赖度）+ 装备穿脱归属说明

- 审计基线 commit：`dcaace599ae5718f70bc5ee8c559af5196cb2d60`（2026-11-05，docs(reference): client-parse contract audits — economy 14 + session 10 endpoints；`git rev-parse HEAD` 于 worktree starpoint-cn-dev-integration 读取）
- 客户端权威源：`wf-cn-client-as3-20261014/scripts/`（下文以 `client:` 缩写）；服务端源：本仓库（下文以 `server:` 缩写，路径相对仓库根）
- 方法：先读通用响应管线定基线（与 `contract-audit-economy.md` §0 同源，本线只复述成长链相关差异点），再逐端点读 `pinball/remote/<域>/<动作>/<Xxx>RealRemote.as` 的构造器（请求 payload）与 successHandler（响应解析）列出客户端字段全集（类名+行号），对照服务端响应构造器（file:line）求差集。所有行号均为反编译 `.as` / TS 源文件真实行号。
- 判定口径：**缺口** = 客户端会读但服务端未发（P1 状态推进/契约破坏、P2 UI 显示缺陷、P3 冗余/无害）；**冗余** = 服务端发但客户端完全不读（一律 P3）。Optional 字段缺失时客户端走 `Option.None` 分支不抛错；标 `[必]` 的字段缺失即抛 ClientError（8700-8707）。成长链特殊点：**客户端对多数成长端点的 successHandler 不做端点级解析**，全部依赖公共信封（earlySuccessHandler）+ 场景层本地预应用。
- 与既有文档关系：语义/实装面见 `help-audit-character.md`、`help-audit-equipment.md`（勿重复计）；公共信封字段全集与 `data_headers.force_update` 冗余问题见 `contract-audit-economy.md` §0/#C1（本线引用不重复计）。

---

## 0. 通用响应管线基线（成长链相关差异点）

解析链：`RealRemoteService.earlySuccessHandler`（client:`pinball/context/remote/real/RealRemoteService.as:92-1984`，先逐字段校验 `rawData.data`）→ :1976 dispatch `SectionCommand.ReceiveCommonResponse` → `pinball/context/Logic.as:957-996`（case 25）→ `pinball/common/data/player/PlayerLogic.as:3220-3314`（`applyCommonResponse`）→ 各 `applyCommonResponse*`。端点 successHandler 在此**之后**运行（RealRemoteService.as:1983）。

header：`data_headers.result_code` Int `[必]`，`servertime`/`asset_update`/`force_news`/`short_udid`/`viewer_id` 可选（client:`pinball/remote/common/ResponseData.as:39-132`）；`force_update` 客户端不解析（冗余，见 economy #C1，server:src/utils.ts:133-158 每响应都发）。

成长链硬契约（比 economy 基线更严的三处）：

| 项 | 客户端要求 | 证据 |
|---|---|---|
| `character_list[].join_time` / `update_time` | **String `[必]`**（缺失/非串抛 8702），内容需 `YYYY-MM-DD HH:MM:SS`（`JapanStandardTimeString_Impl_.toAppTime` 以空格/`-`切分，格式错抛 7100） | client:RealRemoteService.as:476-482、574-579；pinball/common/time/_JapanStandardTimeString/JapanStandardTimeString_Impl_.as:31-51 |
| `equipment_list[]` 五字段 | `equipment_id`/`protection`/`level`/`enhancement_level`/`stack` **全部 `[必]`**（任一缺失抛 8700/8703） | client:RealRemoteService.as:877-945（:906-935） |
| character_list 新角色 | 未持有角色必须同时带 `entry_count` 与 `bond_token_list`，否则 ClientError 2274/2280 | client:pinball/common/data/player/PlayerLogic.as:3103-3131 |

日期口径核对：客户端 `JapanStandardTimeString_Impl_.toAppTime` → `ParseTools.parseJstDataToUtcTime`（client:pinball/master/runtime/ParseTools.as:211-262）最终 `DateUtil.makeUtc(...)`（:270），**无 +9 偏移**；server:src/data/utils/date.ts:10-14 `clientSerializeDate` 输出 UTC `YYYY-MM-DD HH:MM:SS` —— 一致，无时区缺口。

character_list 应用（client:PlayerLogic.as:3089-3217 → pinball/common/data/character/OwnedCharacterLogic.as:821-916）：`exp`(:874-886)、`stack`(:826)、`over_limit_step`(:836)、`mana_board_index`(:841)、`mana_board_awake`（**按 board 合并**，:846-861）、`bond_token_list`（**整表替换**，:913-916）、`evolution_level`(:894)、`entry_count`(:899)、`ex_boost`(:888)、`protection`(:831)、`update_time/join_time`(:821/:863)。`mana_board_awake` 为空 map 时 client 解析为 `Some(空IntMap)`，合并无效果；server 发送侧在空时直接省略键（server:src/lib/character-growth/response-projector.ts:198-208、:290-292），等价。

错误通道：`RemoteResponseDispatch.complete` 读 `data_headers.result_code`，非 1 → `RemoteErrorKind.FailureResult`（client:pinball/context/remote/RemoteResponseDispatch.as:12-19）；HTTP 非 2xx 在 Flash/AIR 中走 `IO_ERROR` → `RemoteUtil.requestFailHandler`（client:pinball/context/remote/RemoteUtil.as:137-149）→ `RemoteErrorKind.HTTPStatus`。两者在 `Logic.remoteCommonInput`（client:pinball/context/Logic.as:602-677，case 2/8）均落 `openErrorDialog + gotoTitleScene` —— 详见 §13。

---

## 1. expod/stack_to_exp（角色堆叠 → 经验池转换）

**客户端** — client:`pinball/remote/expod/stackToExp/ExpodStackToExpRealRemote.as`
- 请求 :25-29：`{character_id, number}`（number=消耗堆叠数）。
- 响应解析 :32-66（**端点级 [必]**）：`data.converted_exp_info` Object `[必]`（:44-52，缺失抛 8707）→ `converted_exp_info.add_exp` Int `[必]`（:54-59，缺失抛 8700）。其余全靠公共信封。
- 应用：`character_list[].stack`（PlayerLogic.as:3155-3163 → OwnedCharacterLogic.applyStack）、`item_list` 计数（PlayerLogic.as:3018-3041，计数≤0 删键）、`user_info.exp_pool`→`pooled_exp`（PlayerLogic.as:2830-2838）、`exp_pooled_time`→`pooled_exp_gain_time`（:2839-2847）。

**服务端** — server:src/routes/api/expod.ts:95-149
- `data_headers`(:123) + `data`：`user_info{exp_pool, exp_pooled_time, free_mana?}`(:126-131)、`character_list[1]`（`EXP_CHARACTER_GROWTH_FIELDS`=exp/exp_total/create_time/update_time/join_time + `stack` + viewer_id，expod.ts:73-92 + response-projector.ts:112-118）、`item_list{990008: n}`(:139，990008=星彩石，limits.ts:31)、`mail_arrived`(:140)、`over_max?`(:141)、`converted_exp_info{add_exp}`(:143)。
- `over_max` 形状：`{process_type:1|2, item{item_id,number}, amount_sold?}`（server:src/lib/item-overflow/common-response.ts:18-37）——与客户端解析（RealRemoteService.as:1140-1448，`process_type` Int `[必]` :1394-1399）一致。

**判定**：客户端 `[必]` 字段全部满足（add_exp :143；join_time/update_time 由 `projectDate` client-string 生成，response-projector.ts:193-196）。差集仅冗余：`exp_total`/`create_time`/`viewer_id` 客户端不解析（P3）。

---

## 2. expod/bulk_stack_to_exp（一括堆叠转换）

**客户端** — client:`pinball/remote/expod/stackToExp/ExpodBulkStackToExpRealRemote.as`
- 请求 :29：`{}`。
- 响应解析 :32-1231：**在 RealRemote 内重新完整解析公共信封**（character_list :121-419、crazy_gacha_result_list :421、equipment_list :466、item_list :564、mail_arrined :595、user_info 含 exp_pool :859/exp_pooled_time :874 等，schema 与 earlySuccessHandler 相同）+ 端点级 `data.converted_exp_info.add_exp` Int `[必]`（:1209-1225）。解析结果仅用于产出 Finished(count, add_exp)。

**服务端** — server:src/routes/api/expod.ts:151-197
- `character_list`（全部变化角色：EXP 字段+`over_limit_step`+`stack`，:166-170/177-179）、`item_list` = **全量**物品表（getPlayerItemsSync，:180）、`user_info{exp_pool, exp_pooled_time, free_mana?}`(:181-187)、`mail_arrived`(:188)、`over_max?`(:189)、`converted_exp_info{add_exp}`(:191)。

**判定**：`[必]` 满足。全量 item_list/equipment 属契约兼容的重发（客户端按键覆盖，PlayerLogic.as:3018-3041），P3 体积冗余。

---

## 3. expod/inject_exp（经验池 → 角色注入，等级强化主路径）

**客户端** — client:`pinball/remote/expod/injectExp/ExpodInjectExpRealRemote.as`
- 请求 :28：`{character_id, exp}`。
- 响应解析 :35-41：successHandler **不解析任何端点级字段**，仅 dispatch Finished。角色新 exp 经公共信封 `character_list[].exp` 应用（PlayerLogic.as:3134 → OwnedCharacterLogic.applyExperience:874-886）。
- 本地预应用：注入演出时客户端已本地扣池 `scene.consumePooledExp(currentInjectedExp)`（client:pinball/scene/expod/expodInjectExp/ExpodInjectExp.as:196、:584），即池量以响应 `user_info.exp_pool/exp_pooled_time`（PlayerLogic.as:2830-2847）回写校正。

**服务端** — server:src/routes/api/expod.ts:199-280
- 成功路径 :224-252：`character_list[1]`（EXP 字段+`bond_token_list`，:226-229）、`user_info{exp_pool, exp_pooled_time}`(:230-233)、`mail_arrived`(:234)、任务结算片段（mission_info/degree_list/item_list/character_list/over_max/user_info 按需合并，:237-244 → src/lib/mission/response-fragment.ts:66-101、:155-166）、`add_exp_list`(:249)、`active_mission_list`(:250)。
- `INSUFFICIENT_EXP` 良性竞态特判 :258-276：200 + 未变更事实（user_info 池量 + mail_arrived + `add_exp_list:[]` + `active_mission_list:[]`）。
- `active_mission_list[]` 形状 `{mission_id, progress_value, stages:[{stage, received}]}`（server:src/lib/mission/active-core.ts:213-234）与客户端必填（RealRemoteService.as:200-298，mission_id/progress_value Int `[必]`，stages 子项 received Bool `[必]`/stage Int `[必]`）一致。

**判定**：`[必]` 满足；`add_exp_list` 客户端不解析（P3 冗余，server:src/lib/character-growth/commands/inject-exp.ts:138-144）；结算 `degree_list` 客户端不解析（P3，见 §14 #G3）。

---

## 4. character/learn_mana_node（能力盘学习）

**客户端** — client:`pinball/remote/character/learnManaNode/CharacterLearnManaNodeRealRemote.as`
- 请求 :22-30：`{character_id, mana_node_multiplied_id_list}`（character_id 由 `int(list[0]/200)` 换算，:22-25）。
- 响应解析 :33-41：**无端点级解析**。学习结果由场景层**本地预应用**：client:`pinball/scene/manaBoard/remote/CharacterLearnManaNodeProcessingFlow.as:70` `character.appendManaNodes(nodeIds,0)`，响应到达后 `applyCharacterSaveData()`(:92)，进化演出判定读本地 `evolutionLevel`（:94-96）——即客户端真正依赖的响应字段只有 `character_list[].evolution_level`（覆盖本地预测值）与 `user_info` 货币。

**服务端** — server:src/routes/api/character/mana.ts:24-92（响应 :64-91）
- `user_info{free_mana, paid_mana}`(:65-68)、`character_list[]`（`MANA_CHARACTER_GROWTH_FIELDS`=evolution_level/evolution_img_level/bond_token_list/mana_board_awake/create_time/update_time/join_time，response-projector.ts:102-110）、`user_character_mana_node_list{cid:[{multiplied_id, awake_level}]}`(:70-74)、`item_list`(:75)、`evolution`(:76，{character_id,level,img_level}|[]，src/lib/character-evolution.ts:29-37)、`active_mission_list`(:77)、`mail_arrived`(:78)、`mission_info:[]`/`equipment_list:[]`/`degree_list:[]`(:79-81) + 任务结算合并(:83-90)。经 `sendCharacterResponse`（server:src/lib/character-helpers.ts:180-211）包 200+x-msgpack+data_headers。

**判定**：客户端依赖面（evolution_level、free_mana/paid_mana、bond_token_list 整表、mana_board_awake 合并、join_time/update_time `[必]` 串）全部满足。冗余：`user_character_mana_node_list`（CN 客户端仅 initialize/quest finish 解析此键）、`evolution`（`applyCharacterEvolution` 在 CN 1.8.1 无调用方）、`degree_list`、`create_time`/`evolution_img_level` —— 均 P3。

---

## 5. character/awake_mana_node（能力盘觉醒）

**客户端** — client:`pinball/remote/character/learnManaNode/CharacterAwakeManaNodeRealRemote.as`
- 请求 :24-31：`{character_id, mana_node_multiplied_id_list, awake_level}`。
- 响应解析 :34-42：无端点级解析；本地预应用 `appendManaNodes(nodeIds, awakeLevel)`（client:pinball/scene/manaBoard/remote/CharacterAwakeManaNodeProcessingFlow.as:127）+ 响应后 `applyCharacterSaveData()`(:149)。

**服务端** — server:src/routes/api/character/mana-awake.ts:25-86（响应 :70-85）
- 与 learn 相同骨架：`user_info{free_mana,paid_mana}`、`character_list`（MANA 字段）、`user_character_mana_node_list`、`item_list`、`evolution`、`active_mission_list`、`mail_arrived`。

**判定**：同 §4，`[必]` 满足，冗余同（P3）。

---

## 6. character/open_mana_board（二板开启）

**客户端** — client:`pinball/remote/character/openManaBoard/CharacterOpenManaBoardRealRemote.as`
- 请求 :24-27：`{character_id, mana_board_index}`。
- 响应解析 :30-38：无端点级解析。开板结果经公共信封 `character_list[].mana_board_index` 应用（PlayerLogic.as:3191-3199 → applyOpenedManaBoardIndex:841-844）；板间绊证状态经 `bond_token_list` 整表替换（:913-916）。

**服务端** — server:src/routes/api/character/bond.ts:98-137（响应 :119-129）
- `character_list[]` = MANA 字段 + **`mana_board_index`** + viewer_id（bond.ts:116-118）、`user_info{}`、`user_character_mana_node_list{}`、`item_list{}`、`evolution:[]`、`mail_arrived`、`mission_info:[]`、`equipment_list:[]`、`degree_list:[]` + 任务结算(:130-136)。

**判定**：`[必]` 满足；`mana_board_index` 已发。空 `user_info{}`/`item_list{}`/空数组对客户端均为无害 Some 空值（PlayerLogic.as:3018-3041 零迭代；`user_info` 置脏触发 refreshShownData 仅刷新显示）。冗余 P3：`user_character_mana_node_list{}`、`evolution:[]`、`degree_list:[]`。

---

## 7. character/over_limit（EX突破）

**客户端** — client:`pinball/remote/character/overLimit/CharacterOverLimitRealRemote.as`
- 请求 :25-38：`{character_id, use_stack, over_limit_count, item_id?}`。
- 响应解析 :41-49：无端点级解析。新突破步读 `character_list[].over_limit_step`（PlayerLogic.as:3164-3172）、消耗读 `stack`（:3155-3163）/`item_list`。

**服务端** — server:src/routes/api/character.ts:172-227（响应 :197-223）
- `character_list[]` = `OVER_LIMIT_CHARACTER_GROWTH_FIELDS`（over_limit_step/stack/create_time/update_time/join_time，response-projector.ts:127-133）、`item_list`（用了觉醒结晶才发，:206-208）、`mail_arrived`(:209)、任务结算(:212-219)。

**判定**：`[必]` 满足（join_time/update_time 串、格式一致）。P3 冗余：`create_time`。注意 `exp` 不在字段集——突破不改 exp，客户端 Option.None 分支不动作，无缺口。

---

## 8. character/bulk_over_limit（一括EX突破）

**客户端** — client:`pinball/remote/character/overLimit/CharacterBulkOverLimitRealRemote.as`
- 请求 :29：`{}`。
- 响应解析 :32-1199：RealRemote 内重新完整解析公共信封（同 §2 schema），仅以 `character_list` 长度产出 Finished(count)（:1194-1199）。角色状态同样经公共信封应用。

**服务端** — server:src/routes/api/character.ts:229-280（响应 :259-276）
- `character_list[]`（全部变化角色，OVER_LIMIT 字段，:250-263）、`mail_arrived`、任务结算(:265-272)。

**判定**：`[必]` 满足。批量角色均为已持有（无新角色 entry_count/bond_token_list 硬需求触发面），无缺口。

---

## 9. equipment/upgrade（装备强化/觉醒）

**客户端** — client:`pinball/remote/equipment/upgrade/EquipmentUpgradeRealRemote.as`
- 请求 :25-38：`{equipment_id, use_stack, upgrade_count, item_id?}`。
- 响应解析 :41-49：无端点级解析。强化结果全靠公共信封 `equipment_list[]`（**五字段全必**，RealRemoteService.as:877-945；应用 PlayerLogic.as:3058-3076 按 equipment_id 覆盖）与 `item_list`。

**服务端** — server:src/routes/api/equipment.ts:104-272（响应 :235-271）
- `equipment_list` = **全量**持有装备序列化（serializeFullEquipmentList → clientSerializeEquipment，server:src/lib/equipment.ts:16-42，五字段齐全）、`item_list`（强化结晶+锻块+副产物能力魂，:150-171/:241）、`mission_info:[]`、`mail_arrived`(:243)、`over_max?`(:244)、`user_info{free_mana}?`（超容卖出才发，:245-247）、`degree_list:[]`(:251)、任务结算(:253-266)、`active_mission_list`(:267)。

**判定**：`[必]` 满足；`item_list` 计数为 0 时客户端删键（PlayerLogic.as:3028-3034）语义正确。P3 冗余：全量 equipment_list、`degree_list:[]`、`mission_info:[]`。

---

## 10. equipment/bulk_upgrade（一括强化）

**客户端** — client:`pinball/remote/equipment/upgrade/EquipmentBulkUpgradeRealRemote.as`
- 请求 :24：`{equipment_ids}`。
- 响应解析：无端点级解析（同 §9 依赖面）。

**服务端** — server:src/routes/api/equipment.ts:275-462（响应 :425-461）
- 与单件升级同骨架：全量 `equipment_list`(:423-430)、`item_list`、`mission_info:[]`、`mail_arrived`、`over_max?`、`user_info{free_mana}?`、`degree_list:[]`、任务结算、`active_mission_list`(:457)。

**判定**：`[必]` 满足，P3 冗余同 §9。

---

## 11. character/receive_bond_token（信赖度领证）

**客户端** — client:`pinball/remote/character/receiveBondToken/CharacterReceiveBondTokenRealRemote.as`
- 请求 :24-28：`{character_id, mana_board_index}`。
- 响应解析 :31-39：无端点级解析。绊证计数读 `user_info.bond_token`（PlayerLogic.as:2848-2856）；各板领证状态读 `character_list[].bond_token_list`（整表替换，OwnedCharacterLogic.as:913-916）；板开启资格读 `mana_board_index`。

**服务端** — server:src/routes/api/character/bond.ts:37-96（响应 :83-91）
- `user_info{bond_token}`(:84)、`character_list[]`（MANA 字段，含 bond_token_list 整表，:58-61 + response-projector.ts:284-289 projectSortedBondTokens 全量输出）、`active_mission_list`(:86)、`user_character_mana_node_list{}`/`item_list{}`/`evolution:[]`/`mail_arrived`(:87-90)。

**判定**：客户端依赖三件（user_info.bond_token、bond_token_list 整表、join_time/update_time 串）全部满足。P3 冗余：`user_character_mana_node_list{}`、`evolution:[]`。

---

## 12. 装备穿戴/卸下 — 无独立端点（归属 party/edit）

**客户端事实**：CN 1.8.1 客户端**不存在** `equipment/equip`/`unequip` 请求——全量请求路径枚举（`grep startUserRequest pinball/remote/`）中 equipment 域仅 sell/sell_stack/bulk_sell_stack/upgrade/bulk_upgrade/set_protection。穿戴状态随 `party/edit` 提交：`PartyEditRequestTools.create`（client:pinball/remote/party/edit/PartyEditRequestTools.as:105-115）把每队 3 个 `equipment_ids`（Option→null）编入 `party_info_list[]`，payload 见 :118-125；响应 `PartyEditRealRemote.successHandler`（client:pinball/remote/party/edit/PartyEditRealRemote.as:27-33）无端点级解析，装备本体字段（level/enhancement_level/stack/protection）在穿脱时不变，无需 equipment_list。

**服务端事实**：server:src/routes/api/equipment.ts 仅 upgrade/bulk_upgrade/set_protection（:104/:275/:465），无 equip 端点——与客户端一致；`party/edit` 的 party_info/equipment_ids 处理属 session/party 线契约（`contract-audit-session.md`），本线不重复计。

**判定**：无缺口。装备穿脱链路的"响应契约"实为 party/edit 的公共信封，与成长链唯一交集是穿戴不修改装备五字段——两端一致。

---

## 13. 错误码分支对比（客户端 catch vs 服务端返回）

**客户端 catch 面**（成长链相关）：
1. HTTP 非 2xx：URLLoader `IO_ERROR` → `RemoteErrorKind.HTTPStatus`（client:RemoteUtil.as:137-149 + RemoteError.as case 2 "发生意想不到的错误/回到登录界面"）——**响应体不会被解析**。
2. HTTP 200 但 `data_headers.result_code != 1`：`RemoteResponseDispatch.complete` → `FailureResult(code)`（RemoteResponseDispatch.as:12-19）。特殊 code 有专属 UI（217 协议版本/214,1110 资源版本/204 应用版本/101 全维护/9002,9003,9004 功能维护/516/203/223/700-702/20000/319/20001），成长链业务错误只会落 `FailureResult` 泛型分支。
3. 两类最终都进 `Logic.remoteCommonInput`（client:pinball/context/Logic.as:602-677）case 2/8 → `openErrorDialog + gotoTitleScene`：即 **任何成长端点失败 = 通用错误框 + 踢回标题**，客户端不区分具体业务码。
4. 200 但信封 `[必]` 字段缺失/类型错：ClientError 8700-8707 在 earlySuccessHandler 内抛出 → 未捕获 → `PinballClientMain.as:96` UncaughtErrorEvents → `CrashUtil.handle`（重启级，比错误框更重）。

**服务端返回面**（成长链）：
- 业务拒绝：`CharacterGrowthError` → 400/500 JSON `{error, message}`（server:src/routes/api/character/mana-mutation-http.ts:26-43；错误码全集 src/lib/character-growth/errors.ts:1-20：INVALID_REQUEST/CHARACTER_NOT_OWNED/BOARD_NOT_AVAILABLE/LEVEL_REQUIRED/OVER_LIMIT_REQUIRED/PREVIOUS_BOARD_INCOMPLETE/BOND_TOKEN_NOT_EARNED/DUPLICATE_NODE/UNKNOWN_NODE/PARENT_NOT_LEARNED/ALREADY_LEARNED/NOT_LEARNED/INVALID_AWAKE_TARGET/AWAKE_COST_MISSING/INSUFFICIENT_ITEM…）；equipment.ts 各前置校验直发 400 JSON（:112-148）；expod.ts invalidRequest 400（:54-56）。
- 唯一例外：inject_exp `INSUFFICIENT_EXP` → **200 + 未变更事实**（expod.ts:258-276），规避了"良性竞态踢回标题"。

**差集判定**：服务端从不在成长链发 `200 + result_code != 1` 的 msgpack 信封；4xx JSON 的 body 客户端因 IO_ERROR 根本不读。与原版服（200+result_code）相比 UI 等价（均泛型框+回标题），**无字段级缺口**；代价是错误文案不可区分（两侧均为泛型文案）与 `message` 仅利于服务端日志。P3 记录（#G4）。

---

## 14. 缺口清单

**P1（契约破坏/状态推进错误）**：无。成长链 11 端点的全部客户端 `[必]` 字段（character_id、join_time/update_time 字符串及其 `YYYY-MM-DD HH:MM:SS` 格式、equipment_list 五件套、converted_exp_info.add_exp、over_max.process_type、active_mission_list 的 mission_id/progress_value、mission_info 的 mission_category_id/mission_reward_id）均由服务端发送且类型/格式核对通过（含新角色 entry_count+bond_token_list 硬需求，server:src/lib/character.ts:76-101 顺带核验 add_character_from_town 快照满足）。

**P2（UI 显示缺陷）**：无实锤。候选均降级 P3 的理由附于对应条目。

**P3（冗余/无害/口径提示）**：

| # | 内容 | 证据 |
|---|---|---|
| G1 | `data_headers.force_update` 客户端不解析而服务端每响应发送 | server:src/utils.ts:133-158 vs client:ResponseData.as:39-132（同 economy #C1，引用不重复计） |
| G2 | inject_exp 响应 `add_exp_list` 客户端完全不解析（CN 1.8.1 ExpodInjectExpRemoteInput 无此键） | server:expod.ts:249 + inject-exp.ts:138-144 vs client:ExpodInjectExpRealRemote.as:35-41 + RealRemoteService.as:1960-1974 键全集 |
| G3 | 成长链任务结算写入 `degree_list`（含 viewer_id/degree_id）但客户端公共信封不解析该键，称号刷新延迟到下次 profile/initialize 拉取 | server:src/lib/mission/response-fragment.ts:127-141 vs client:RealRemoteService.as:1960-1974（键全集无 degree_list） |
| G4 | 成长链业务错误全部 400 JSON（客户端 catch 不到具体 code，仅泛型框+回标题）；`message` 字段客户端不可见；inject_exp 已用 200-fallback 规避最高频良性竞态 | server:mana-mutation-http.ts:26-43、character.ts:56-59、equipment.ts:112-148 vs client:Logic.as:602-677、RemoteUtil.as:137-149 |
| G5 | mana/bond 响应 `user_character_mana_node_list`、`evolution`、空 `mission_info/equipment_list/degree_list` 冗余（节点学习由客户端本地预应用，CharacterLearnManaNodeProcessingFlow.as:70 / CharacterAwakeManaNodeProcessingFlow.as:127；`applyCharacterEvolution` 在 CN 客户端无调用方） | server:mana.ts:64-82、mana-awake.ts:70-85、bond.ts:83-91/:119-129 |
| G6 | equipment/upgrade·bulk_upgrade 全量 equipment_list、bulk_stack_to_exp 全量 item_list——契约兼容（按 id/键覆盖）但体积冗余 | server:equipment.ts:232/:423、expod.ts:180 vs client:PlayerLogic.as:3058-3076/:3018-3041 |
| G7 | 字段冗余：`exp_total`/`create_time`/`evolution_img_level`/`viewer_id`（character_list 内）客户端不解析 | server:response-projector.ts:112-133 vs client:RealRemoteService.as:299-597 |

---

## 15. 结论

角色成长链 11 端点（expod/stack_to_exp、expod/bulk_stack_to_exp、expod/inject_exp、character/learn_mana_node、character/awake_mana_node、character/open_mana_board、character/over_limit、character/bulk_over_limit、equipment/upgrade、equipment/bulk_upgrade、character/receive_bond_token）+ 装备穿脱归属说明（party/edit，无独立端点）全部完成"客户端解析 vs 服务端发送"逐字段比对：**0 个 P1/P2 缺口，7 条 P3**（1 条与 economy 审计同源引用）。成长链的解析重心在公共信封的三个硬契约（character_list 时间串、equipment_list 五件套、新角色 entry_count+bond_token_list），服务端的 `projectCharacterGrowthEntry` 字段集（EXP/MANA/OVER_LIMIT 三组白名单）+ `projectCharacterPatch` 投影 + `sendCharacterResponse` 信封完整覆盖，日期格式（UTC `YYYY-MM-DD HH:MM:SS`）与客户端 `JapanStandardTimeString` 切分解析一致。客户端对 mana 学习/觉醒与 expod 注入采用"本地预应用 + 响应覆盖"模式，服务端只需保证信封字段权威即可，当前实现满足；服务端多发的 `user_character_mana_node_list`/`evolution`/`add_exp_list`/`degree_list` 为前向兼容冗余，不构成风险。错误通道上服务端 400 JSON 与原版 200+result_code 在客户端 UX 等价（泛型框+回标题），inject_exp 的 200-fallback 已覆盖最高频良性竞态。
