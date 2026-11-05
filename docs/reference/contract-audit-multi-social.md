# 客户端解析契约审计 — 共斗 HTTP 族 + 社交族（multi_battle_quest 16+1 端点 / follow 7 端点 / gift 1 端点）

- 审计基线 commit：`dcaace599ae5718f70bc5ee8c559af5196cb2d60`（2026-11-05，worktree starpoint-cn-dev-integration `git log -1` 读取）
- 客户端权威源：`wf-cn-client-as3-20261014/scripts/`（下文以 `client:` 缩写）；服务端源：本仓库（下文以 `server:` 缩写，路径相对仓库根）
- 方法：引用《contract-audit-economy.md》§0 公共字段基线（`earlySuccessHandler` 公共片段管线 + `data_headers` 契约）与《contract-audit-quest-battle.md》§2 单人 finish 解析器全表（multi finish 与 single finish 共用同一个 29 字段解析器，本篇只计 multi 增量字段），逐端点读客户端 Remote 类 successHandler 解析代码列出端点级字段全集（类名+行号），对照服务端响应构造器（file:line）求差集。所有行号均为反编译 `.as` / TS 源文件真实行号。行为语义（NPC 生命周期、铃铛投放、计费）已有 docs/protocol/multi-battle.md 与 8 轮真机背书，本篇只看字段契约。
- 判定口径：**缺口** = 客户端会读但服务端未发（P1 状态推进/经济可见错误、P2 UI/记录显示缺陷、P3 冗余/无害）；**冗余** = 服务端发但客户端完全不读（一律 P3 记录）。Optional 字段缺失时客户端走 `Option.None` 分支不抛错；标 `[必]` 的字段缺失即抛 ClientError（8700-8707）。
- 请求侧公共注入：client:`pinball/context/remote/RequestQueue.as:218-253` 按 `PlayerIdMode.LocalStore` 把 `viewer_id` 注入请求体——因此 `get_rooms`/`search_room` 等端点级请求体不含 viewer_id，服务端读 `body.viewer_id` 成立。
- 范围注记：铃铛投递端点 `attention/*`（`src/routes/api/attention.ts`）属招募投放链，不在本批字段审计范围；TCP 全量命令对照以 docs/protocol/multi-battle.md §6.3 为基线，本篇仅抽查（§5）。

---

## 0. 端点定位

| 组 | client 请求构造 | server 路由注册 |
|---|---|---|
| `multi_battle_quest/*`（房间发现/加入/战斗/兼容） | `pinball/remote/multiBattleQuest/<动作>/` + 共用 `pinball/remote/quest/{start,finish,abort,playContinue}/` + `pinball/context/remote/real/RealRemote.as:827-836`（disband_room/create_room_failure） | server:`src/server.ts:118-121`（global）/`src/cn-server.ts:378-381`，前缀 `${apiPrefix}/multi_battle_quest`（`src/cn-server.ts:182`）；实现 `src/multi/http/{lobby,room,battle,social}.ts` |
| `follow/*` | `pinball/remote/follow/{add,bulkEdit,§delete§,lists,searchId,searchTwitter}/` + `pinball/remote/followed/§delete§/` | server:`src/cn-server.ts:307`，前缀 `${apiPrefix}/follow`；实现 `src/routes/api/follow/{read-routes,write-routes}.ts` |
| `gift/receive`（present 性质：礼包码/发放领取，WF 无独立 present 端点族，present 一律走 mail） | `pinball/remote/tool/gift/GiftRealRemote.as` | server:`src/cn-server.ts:312`，前缀 `${apiPrefix}/gift`；实现 `src/routes/api/gift.ts` |

---

## 1. multi_battle_quest — 房间发现与加入

### 1.1 create_room

**客户端解析** — client:`pinball/remote/multiBattleQuest/createRoom/MultiBattleQuestCreateRoomRealRemote.as`
- 请求 :31-35（category/party_id/quest_id）。
- successHandler :74-145：`data.access_token` Option&lt;String&gt; :89-102、`data.room_number` Option&lt;String&gt; :103-116、`data.room_url` String`[必]` :117-123；二者必须有其一（:124-138，全缺→ClientError 5150），组合成 RoomIdKind。
- 错误路径 :38-72：result_code 4050→OutOfPeriodError、4507→Failure。

**服务端发送** — server:`src/multi/http/lobby.ts:174-182`：`data = {access_token, room_number, room_url:""}`，data_headers 经 `generateDataHeaders`（result_code=1 成功，client:`ResultCode_Impl_.as:166-171` isSuccess(1)=true）。

**差集判定**：完全匹配，无缺口。`room_url` 恒空串满足 String 必需校验。

### 1.2 get_rooms（好友房间大厅）

**客户端解析** — client:`pinball/remote/multiBattleQuest/getRooms/MultiBattleQuestGetRoomsRealRemote.as`
- 请求 :26-38（party_id/category_id/event_id?）。
- successHandler :41-172：`data.rooms` Array`[必]` :66-71；每项 **11 字段全 `[必]`**：category_id Int :86、establisher_character Int :92、establisher_character_evolution_img_level Int :98、establisher_follow Int :104、establisher_name String :110、host_entry_time Float :116、is_pickup Bool :122、mates Int :128、quest_id Int :134、raising_state Int :140、room_number String :146。任一缺失/类型错即抛 8700-8702（establisher_character 为 null 崩客户端正是 serializer.ts:24-26 注释钉死的旧案）。

**服务端发送** — server:`src/multi/http/lobby.ts:34-78`（条目 :63-75）：11 字段逐一齐备（establisher_* 来自 `parseEstablisherSnapshot`，`host_entry_time` 走 `realSecondsToVirtual`，`is_pickup:false`，`raising_state` 经 `projectLobbyRaisingState`）。

**差集判定**：完全匹配，无缺口、无冗余。

### 1.3 search_room

**客户端解析** — client:`pinball/remote/multiBattleQuest/searchRoom/MultiBattleQuestSearchRoomRealRemote.as`
- 请求 :25（仅 room_number；viewer_id 经 RequestQueue 注入）。
- successHandler :28-89：`data.room_exists` 真值判定 :36（falsy→RoomNotFound，不再读其它字段）；真值时 4 字段全 `[必]`：category_id Int :48、establisher_follow Int :54、quest_id Int :60、room_number String :66。
- 错误路径 :91-114：result_code 4020→NotPlayable。

**服务端发送** — server:`src/multi/http/lobby.ts:185-229`：房间不存在→`data_headers.result_code=4020`+`data:{}`（:204-208）；存在→`data={room_exists, category_id, quest_id, room_number, establisher_viewer_id, establisher_follow}`（:220-227）。

**差集判定**：匹配 + 1 冗余。
| 判定 | 字段 | 说明 |
|---|---|---|
| 冗余 | `establisher_viewer_id` | 客户端 search 解析器不读（确认框的房主信息走 verify_access_token，§1.5）→ P3 |
| 一致 | 4020 投影 | 服务端把"关卡不可用"投影为 A-error 4020，客户端映射 NotPlayable（multi-battle.md §4.1 同口径） |

### 1.4 select_room

**客户端解析** — client:`pinball/remote/multiBattleQuest/selectRoom/MultiBattleQuestSelectRoomRealRemote.as`
- 请求 :199-216（category/quest_id/party_id/accepted_type + room_number 或 access_token 二选一）。
- successHandler :48-197：**11 字段全 `[必]`**：application_update_url String :62、category_id Int :68、host_entry_time Float :74、ip_address String :80、is_pickup Option&lt;Bool&gt; :86（null 合法）、port Int :100、quest_id Int :106、raising_state Int :112、room_number String :118、room_sequence Int :124、share_room_options Int :130。
- raising_state 分派 :149-190：1=Ready、2=重试 5 次×3s 后 Disbanded、3=Filled、4=Battle、7=NotPlayable、8=Barred、9=Disbanded、10=StaleRoom、11=NeedToUpdate(application_update_url)、12=NotFollowHost；**其余值→ClientError 5001**（:188-189，反编译显示的 `case 13` 实为 default 分支伪影）。

**服务端发送** — server:`src/multi/http/lobby.ts:231-343`：成功走 `serializeRoomStatusConnection`（`src/multi/room/serializer.ts:92-124`，11 字段齐备、is_pickup:null、TCP 端点来自 `context.tcpEndpoint()`）；不可达投影 `unavailableConnection`（lobby.ts:80-94，同 11 字段、状态 3/7/9）+ 任务门 7（:278-286）+ 准入拒绝 3/7/9（:295-311）；`raising_state` 终值经 `projectRaisingStateForViewer`（flow:"select"，:322-334）。房间状态写入域恒为 1/2/4（docs/protocol/multi-battle.md §5），HTTP 投影只出 1/2/3/4/7/9 —— 永不触发客户端 5/6 死分支（8/10/11/12 客户端有分支但服务端不发，信息记录）。

**差集判定**：完全匹配，无缺口、无冗余。prepare 远端的链式 select 对 4 抛 C5001 的约束（server:`src/multi/http/join-result.ts:23-32` 注释）与本处反编译一致。

### 1.5 verify_access_token（房间号/token 加入确认框）

**客户端解析** — client:`pinball/remote/multiBattleQuest/verifyAccessToken/MultiBattleQuestVerifyAccessTokenRealRemote.as`
- 请求 :25（access_token）。
- successHandler :28-137：`data.room_exists` 真值判定 :42；真值时 **10 字段全 `[必]`**：category_id Int :54、establisher Float :60、establisher_character Int :66、establisher_character_evolution_img_level Int :72、establisher_follow Int :78、establisher_name String :84、establisher_rank Int :90、host_entry_time Float :96、quest_id Int :102、room_number String :108。
- 错误路径 :139-162：4020→NotPlayable。

**服务端发送** — server:`src/multi/http/social.ts:13-81`：missing→`room_exists:false`（:37-43）；不可用→4020（:31-35）；成功 :63-79 发全部 10 字段（establisher=host viewer_id，establisher_character=战斗所选编队一号位，进化等级 fail-open 0，establisher_rank=`getPlayerRankLevel`）。

**差集判定**：完全匹配，无缺口、无冗余。

---

## 2. multi_battle_quest — 准备、招募、解散与兼容路由

### 2.1 prepare

**客户端解析** — client:`pinball/remote/multiBattleQuest/prepare/MultiBattleQuestPrepareRealRemote.as`
- prepare 请求 :50-65（category/quest_id + room_number|access_token）；prepareSuccessHandler :234-237 **不解析响应体**，直接链式发起 select_room（:214-232，带 party_id/accepted_type）。
- 真正的解析发生在链式 select 的响应上（同一解析函数 :68-212，字段集同 §1.4），raising_state 分派 :168-211：1=Finished、2=重试 5 次×3s→Failure、9=RoomDataNotFound、**3/4/7/8/10/11/12/13→ClientError 5001** :194-203。
- 错误路径 :239-282：4503→RoomDataNotFound、4507→Failure、4509→RoomDataPeriodOutdated。

**服务端发送** — server:`src/multi/http/room.ts:90-181`：成功 :176-180 回 `serializeRoomStatusConnection`（11 字段齐）；失败统一 `prepareFailure` :67-85——仅 ROOM_NOT_FOUND 走 raising_state=9，其余回 `result_code=4507`+`data:{}`；state 4 期间成员投影 2、非成员投影 4507（:152-174，与客户端 3/4→C5001 约束吻合，server:`join-result.ts:23-32` 同一结论）。

**差集判定**：完全匹配。4509（RoomDataPeriodOutdated）客户端有分支但服务端从不回——信息记录，无影响。

### 2.2 summon（NPC 双候选）

**客户端解析** — client:`pinball/remote/multiBattleQuest/summon/MultiBattleQuestSummonRealRemote.as`
- 请求 :30-35（category_id/quest_id/room_number）。
- successHandler :38-935：`data.mate1`/`data.mate2` 各 Option :85/:506；mate 结构（`[必]` 项缺失即抛）：com_id Float :102、degree_id Int :109、rank Int :487、party Object`[必]` :116-124 内含 ability_soul_ids Array :126（元素 Option&lt;Int&gt;，null→None）、characters Array :152、equipments Array :293、unison_characters Array :346；character/unison 元素 Option :162-291：evolution_level Int、ex_boost Option{ability_id_list Array`[必]`、status_id Int`[必]`}、exp Int、id Int、mana_node_ids Option&lt;IntMap&gt;（null→None，`[]` 解析为空表）、over_limit_step Int；equipment 元素 Option :320-343：enhancement_level Int、equipment_id Int、level Int。

**服务端发送** — server:`src/multi/http/room.ts:239-248`：`buildNpcMates`（`src/multi/npc/builder.ts:28-61`）产出 {com_id, degree_id, rank, party{characters,unison_characters,equipments,ability_soul_ids}}，槽位补 null 至 3、mana_node_ids:[]、ex_boost:null——与客户端 Option(null) 解析一一对应；W>0 窗口未到回 `data:{}`（两 mate 双 None→客户端 Faild 重开铃，行为语义有真机背书）。

**差集判定**：完全匹配，无缺口、无冗余。注意 HTTP 侧 mate 用裸 `null` 表 None，与 TCP session party 的 `[1]` Option 包装是两个上下文（multi-battle.md §7 表已区分）。

### 2.3 restore_room

**客户端解析** — client:`pinball/remote/multiBattleQuest/restoreRoom/MultiBattleQuestRestoreRoomRealRemote.as`
- 请求 :155-161（room_number/room_sequence）。
- successHandler :36-153：只读 **4 字段全 `[必]`**：ip_address String :47、port Int :54、raising_state Int :60、share_room_options Int :66。
- raising_state 分派 :78-152：1=Ready、2=重试 5 次×3s→Disbanded、3/7/8/12=InvalidRaisingState、4=Battle、9=Disbanded、10=StaleRoom、11=NeedToUpdate、13=NotMate（全分支收敛，不抛 C5001）。

**服务端发送** — server:`src/multi/http/room.ts:252-337`：非成员→全字段投影 raising_state=13（:281-300，客户端→NotMate，语义吻合）；缺失房→`restoreRoomUnavailableRaisingState`=9（`join-result.ts:38-42`）；成员成功→`serializeRoomStatusConnection` + `is_same_room:true`（:302-305）+ 状态投影 + 重签准入（:307-330）。

**差集判定**：匹配 + 1 冗余。
| 判定 | 字段 | 说明 |
|---|---|---|
| 冗余 | `is_same_room` | 客户端 restore 解析器不读（4 字段白名单）→ P3。语义可能供链路日志，无碍 |
| 一致 | raising_state 13=NotMate | 服务端注释（join-result.ts:35-37）与本处反编译互证 |

### 2.4 share_room

**客户端解析** — client:`pinball/remote/multiBattleQuest/shareRoom/MultiBattleQuestShareRoomRemote.as`
- 请求 :29-34（category/quest_id/room_number/share_type_list）。
- 成功处理器为 `FunctionTools.emptyFunction1` :34——**响应体零解析**；错误路径 :37-219：4503→SocketContact.RoomDataNotFound（断线重连路径），其余→Attention.ShareRoomError。

**服务端发送** — server:`src/multi/http/room.ts:345-463`：恒 200 + `data:{}`（:458-462），招募/注册表记账全部尽力而为不 500。

**差集判定**：完全匹配（空响应体即契约）。

### 2.5 disband_room / create_room_failure（send-only）

**客户端** — client:`pinball/context/remote/real/RealRemote.as:827-836`：两者均 `sendOnlyUserRequest`→`startUserRequest(..., FunctionTools.emptyFunction1)`（RealRemote.as:508-511），**成功响应零解析**。disband_room（:827-830）请求 {room_number}，调用点 `pinball/scene/questResult/QuestResultScene.as:1524`、`pinball/scene/bossBattle/room/MultiBattleRoomScene.as:999`；create_room_failure（:832-836）请求 {type}，调用点 `pinball/scene/ui/MultiBattleRoomPrepareFlow.as:370,396`（create/prepare 失败遥测）。

**服务端** — disband_room 实现 `src/multi/http/room.ts:466-503`（`data:{}`，幂等）；**create_room_failure 无服务端路由**（`grep create_room_failure src/` 无命中）。

**差集判定**：
| 判定 | 端点 | 说明 |
|---|---|---|
| 匹配 | disband_room | data:{} 即契约 |
| 缺口（P3，G-2） | create_room_failure | 404→客户端通用错误处理（RemoteServiceBase.as:43-50）；因只在 create/prepare 已失败后发送、成功体本就被忽略，增量影响仅为错误通道噪音 |

### 2.6 publish_room / micro_community（兼容路由）

**客户端解析** — publish_room：client:`pinball/remote/multiBattleQuest/microCommunity/MultiBattleQuestMicroCommunityRealRemote.as:26-41`（请求 {room_number, token}，成功读 `data.success` 原样透传、**无类型校验** :35）。micro_community：CN 客户端 `scripts/` 内**无调用点**（`multi_battle_quest/` 端点字符串全量 grep 无此路径）。

**服务端发送** — server:`src/multi/http/social.ts:95-105`（publish_room→`data:{success:false}`）、`social.ts:83-93`（micro_community→`data:{}`）。

**差集判定**：publish_room 匹配（success:false=官方语义"未发布"）；micro_community 为无客户端调用方的兼容保留（P3 信息记录，不算缺口也不算冗余——没有读者）。

---

## 3. multi_battle_quest — 战斗生命周期（共用 quest Remote）

### 3.1 start

**客户端解析** — client:`pinball/remote/quest/start/QuestStartRealRemote.as`
- multi 请求 :60-122：基础体 :41-58（category/quest_id/party_id/play_id/use_boost_point/use_boss_boost_point/combat_power/is_auto_start_mode/auto_start_times?）+ room_number :76、mate_player_ids :78、mate_party_ids :88-105、attention_key? :106-113、client_battle_party? :114-121。
- successHandler :126-278 端点级只读 3 项：`data.client_checks` Option&lt;Array&lt;String&gt;&gt; :155-183、`data.follow_bonus_info` Option&lt;Array&lt;{follow_bonus_list StringMap[String→Float]`[必]`, total_follow_bonus Float`[必]`, viewer_id Float`[必]`}&gt;&gt; :184-257、`header.servertime` Float`[必]` :261-271（None→C5000）。
- 错误路径 :280-303：4050→OutOfPeriodError。

**服务端发送** — server:`src/multi/http/battle.ts:365-386`：`data={is_multi:"multi", play_id, follow_bonus_info?（buildFollowBonusInfo 有边才发）, user_info{stamina, stamina_heal_time}+item_list（经 mergeCommonResponseFragments）}`；servertime 经 generateDataHeaders。`follow_bonus_info` 形状由 `src/lib/follow-bonus.ts` 产出（viewer_id/follow_bonus_list/total_follow_bonus，与客户端 3 子字段对应）。

**差集判定**：
| 判定 | 字段 | 说明 |
|---|---|---|
| 缺口（P3，G-1） | `client_checks` | 服务端不发送（与单人链 contract-audit-quest-battle.md G-1 同型）：客户端 None→空检查清单，multi 局内"客户端检查型"任务不判定、不 echo；不崩溃 |
| 冗余（P3） | `is_multi` / `play_id` | start 解析器不读（play_id 客户端用本地生成值）；公共层亦无此 2 键 |
| 一致 | `follow_bonus_info` 缺席=无关注边语义 | 客户端 Option，v4 契约（battle.ts:357-359 注释） |

### 3.2 finish

**客户端解析** — client:`pinball/remote/quest/finish/BattleQuestFinishRealRemote.as`
- multi 路径 resolvePath :74-85；请求侧多人增量 client:`pinball/remote/quest/finish/BattleQuestFinishRemoteUtil.as:210-265`（contribution_score、mate_player_result[{viewer_id,com_id,score,contribution_score}]、isolated、priority_factors）。
- 解析器 successHandler :135-2545 与 single_battle_quest/finish **共用**：29 字段全集与 `[必]`/Option 分类见《contract-audit-quest-battle.md》§2（`[必]` 10 项：before_rank_point、bond_token_status_list、drop_*×4、joined_character_id_list、presigned_quest_category、rewards(4 子字段)、old_high_score）。
- multi 增量字段：`data.follow_info` Option&lt;Array&gt; :773-913——每项 11 子字段（comment String`[必]` :801、degree_id Int`[必]` :809、follow_state Int`[必]` :816、follow_time/followed_time Option&lt;Float&gt; :824/:837、last_login_time Float`[必]` :849、name String`[必]` :855、profile_image_url Option&lt;String&gt; :861、rank Int`[必]` :875、role Option&lt;Int&gt; :882、viewer_id Float`[必]` :894）；`data.host_finished` Option&lt;Bool&gt; :915-927。

**服务端发送** — server:`src/multi/http/battle.ts:390-466` → `src/multi/settlement/response.ts:102-148`：
- `[必]` 项：before_rank_point :119、bond_token_status_list :105、drop_score/rare/additional/periodic_reward_ids :121-124、joined_character_id_list :114-118、presigned_quest_category :130（恒 []）、rewards :106-112（field_mana/overflow_pool_exp/reward_mana/reward_pool_exp + 冗余 converted_pool_exp）、old_high_score :113。
- multi 增量：follow_info :132 ← `buildFinishFollowInfo`（`src/lib/quest/finish/follow-info.ts:73-89`，11 子字段与客户端一一对应：comment:"" / role||1 / degree_id||1 / follow_state / follow_time/followed_time null→None / profile_image_url:null / rank=getRankDegree / last_login_time=当前钟）；host_finished :134。
- 公共片段 user_info(10 子字段)/character_list/equipment_list/item_list/mission_info/active_mission_list/mail_arrived/over_max :67-100（economy §0 基线）。

**差集判定**：
| 判定 | 字段 | 说明 |
|---|---|---|
| 匹配 | 全部 `[必]` + follow_info + host_finished | 无 P1/P2；follow_info 只对同节点真实队友生成（F5），缺席=None 正确语义 |
| 冗余（P3） | `mate_player_result`（:131，请求回显）/ `contribution_score`（:133）/ `degree_list`（:136，与单人同案）/ `category_id` / `start_time` / `is_multi` / `quest_name`（:125-128）/ `rewards.converted_pool_exp` | 客户端 finish 解析器与公共层均不读 |
| 一致 | `unfinished_play_id`/`aborted_play_id`/`presigned_url`/`party_info`/事件增量（rush/raid/carnival/score_attack） | Option；multi 结算不发事件增量（无事件类别映射），与 contract-audit-quest-battle.md 差集同口径 |

### 3.3 abort

**客户端解析** — client:`pinball/remote/quest/abort/QuestAbortRealRemote.as`
- multi 路径 :103；successHandler 5 字段全 Option：aborted_play_id :143、drawn_quest :157、party_info :198、presigned_url :368、unfinished_play_id :382（Some→restore.readBattleHead :403-412）。

**服务端发送** — server:`src/multi/http/battle.ts:469-561`：正常终态 :544-560 显式回 5 个 Option 字段（全 null）+ user_info{}/category_id/is_multi/start_time/quest_name；迟到 abort 幂等回 `data:{}`（:511-514）。

**差集判定**：匹配（5 Option 全部显式 null，与 contract-audit-quest-battle.md §3 单人 abort 同构）；`category_id/is_multi/start_time/quest_name` 4 键冗余（P3）。

### 3.4 play_continue

**客户端解析** — client:`pinball/remote/quest/playContinue/QuestPlayContinueRealRemote.as`
- multi 路径 :31；请求 {category, quest_id, play_id, statistics, payment_type:1}（:38-46，payment_type 硬编码 1）。
- successHandler :43-56：仅校验 data 为 Object，**端点级零字段**；续关花费回执走公共层 user_info.free_vmoney/vmoney（economy §0 基线）。

**服务端发送** — server:`src/multi/http/battle.ts:564-612`：`data={continue_count}`（幂等分支 :587-602 亦回 continue_count）。注意 multi 续关不扣星导石（multi-battle.md §4.3），故公共层无 free_vmoney 更新——客户端无消费点，无缺口。

**差集判定**：1 冗余（P3）：`continue_count` 客户端端点解析器与公共层均不读（多人续关次数由服务端权威持有，客户端 finish 请求上送的 continue_count 是本地计数）。

---

## 4. 社交族 — follow / gift

### 4.1 follow/lists

**客户端解析** — client:`pinball/remote/follow/lists/FollowListsRealRemote.as:24-235`
- 请求 {}（:24）。
- successHandler :27-235：`data.follow_info` Array`[必]` :59-64，每项 **14 子字段全 `[必]`（除标注 Option）**：comment String :79、degree_id Int :85、follow_state Int :91、follow_time Opt&lt;Float&gt; :97、followed_time Opt&lt;Float&gt; :111、last_login_region Opt&lt;String&gt; :125、last_login_time Float`[必]` :139、leader_character_evolution_img_level Int`[必]` :145、leader_character_id Int`[必]` :151、name String :157、profile_image_url Opt&lt;String&gt; :163、rank Int :177、role Opt&lt;Int&gt; :183、viewer_id Float :197；`data.followed_count` Int`[必]` :220-225。

**服务端发送** — server:`src/routes/api/follow/read-routes.ts:53-74` → `projectFollowUser`（`src/routes/api/follow/profile.ts:35-70`）：FollowUserProjection 14 字段（F0 冻结）与客户端集合逐一对应（last_login_region:null、profile_image_url:null、leader_character_id=喜爱配队一号位回退、evolution level 实算）。

**差集判定**：完全匹配，无缺口、无冗余。

### 4.2 follow/search_id

**客户端解析** — client:`pinball/remote/follow/searchId/FollowSearchIdRealRemote.as:26-235`
- 请求 {search_id}（:26）。
- successHandler :29-203：`data.search_result` Object`[必]` :45-54，14 子字段同 §4.1 集合 :56-195（结果包装为单元素数组 :196）。
- 错误路径 :205-235：result_code 1457/1459→Finished([])（"无结果"正规化）。

**服务端发送** — server:`src/routes/api/follow/read-routes.ts:77-94`：命中→`search_result=projectFollowUser(...)`（同 14 字段）；未命中→A-error 1457（:87-92）。

**差集判定**：完全匹配（1457 编码一致；1459 客户端兼容但服务端不发，信息记录）。

### 4.3 follow/add

**客户端解析** — client:`pinball/remote/follow/add/FollowAddRealRemote.as`
- 请求 {follow_id}（:24）；successHandler :27-35 零字段（data:{} 即契约）。
- 错误路径 :37-71：1451→FollowCountOver（我方上限）、1452→PartnerFollowedCountOver（对方被关注上限）。

**服务端发送** — server:`src/routes/api/follow/write-routes.ts:75-98`：成功 `data:{}`（:46-52）；业务失败 A-error 1451/1452（ADD_FAILURE_RESULT_CODE :41-44）。

**差集判定**：完全匹配。

### 4.4 follow/delete / follow/delete_followed

**客户端解析** — client:`pinball/remote/follow/§delete§/FollowDeleteRealRemote.as:22-31`（请求 {follow_id}，零字段）；client:`pinball/remote/followed/§delete§/FollowedDeleteRealRemote.as:58-67`（请求 {followed_id}，零字段）。

**服务端发送** — server:`src/routes/api/follow/write-routes.ts:100-110`（/delete）、`:112-122`（/delete_followed）：均 `data:{}`。

**差集判定**：完全匹配。

### 4.5 follow/bulk_edit

**客户端解析** — client:`pinball/remote/follow/bulkEdit/FollowBulkEditRealRemote.as`
- 请求 {add_follow_id_list, delete_follow_id_list}（:23-26）。
- successHandler :29-65：`data.max_follower_user_viewer_id_list` Array&lt;Float&gt;`[必]` :42-59（语义：本次批量关注中因"对方被关注超限"被拒的 viewer 列表）。

**服务端发送** — server:`src/routes/api/follow/write-routes.ts:124-174`：成功恒 `data:{max_follower_user_viewer_id_list:[]}`（bulkOk :54-60）。

**差集判定**：类型契约匹配；语义注意项：服务端把超限整体走 A-error 1451/1452（bulkEditLocalFollowsSync 失败即整体拒绝），空数组恒成立——客户端"部分成功列表"通道实际永远为空，无 UI 偏差（P3 信息记录，非缺口）。

### 4.6 follow/search_twitter

**客户端解析** — client:`pinball/remote/follow/searchTwitter/FollowSearchTwitterRealRemote.as`
- 请求 {twitter_follow_ids?}（:34）。
- successHandler :37-263：`data.search_result` Option&lt;Array&gt; :73-242（元素同 §4.1 的 14 子字段）；**整个字段缺席→NoCache 分支** :255-261（合法终态）。

**服务端发送** — server:`src/routes/api/follow/read-routes.ts:39-50`：`data={twitter_follow_ids:[]}`（空列表占位；CN 客户端 SNS 绑定不可达，见 :37-38 注释）。

**差集判定**：
| 判定 | 字段 | 说明 |
|---|---|---|
| 缺口（P3，G-3） | `search_result` 未发 | 客户端走 NoCache 分支不抛错；该功能 CN 不可达，语义无害 |
| 冗余（P3） | `twitter_follow_ids` | 客户端解析器不读（那是请求字段名，响应侧无此键的读者） |

### 4.7 gift/receive（present 性质领取）

**客户端解析** — client:`pinball/remote/tool/gift/GiftRealRemote.as`
- 请求 {key}（:25）。
- successHandler :28-110：`data.all_gift_info` Array`[必]` :45-49，每项 {number Int`[必]` :65、type Int`[必]` :71、type_id Option&lt;Int&gt; :77}；`data.result_code` Int`[必]` :97-103（**data 内层 result_code**，非 data_headers）。

**服务端发送** — server:`src/routes/api/gift.ts:63-88`：`data={result_code, all_gift_info[{type,type_id,number}]}` + 超容时合并 over_max/item_list/user_info.free_mana（:75-83）。type_id 为 undefined 的奖励在 msgpackr 下落为 nil→客户端 None，合法。

**差集判定**：完全匹配，无缺口。WF 的"present"（登录/补偿发放）实际载体是 mail 族（`mail/receive`/`mail/receive_all`），已在 contract-audit-economy.md 覆盖，本篇不重复计。

---

## 5. TCP 抽查（对 docs/protocol/multi-battle.md §6.3 基线）

抽查 4 个下行帧 + 1 个上行帧，全部对齐：

| 帧 | 客户端解析 | 服务端发送 | 判定 |
|---|---|---|---|
| ServerMessage 枚举序 | client:`pinball/online/meeting/message/MeetingServerMessage.as:13`（Welcome0/Mates1/StateChanged2/AutoplayModeChanged3/AutoStartChanged4/Start5/Disbanded6/RemainingTime7/Update8/AssetUpdate9/StartRemainingTime10/AckHeartbeat11）；分发 `pinball/scene/bossBattle/room/MultiBattleRoomScene.as:589-620` | — | 基线 §6.3 表与 enum 一一对应（含 CN 的 9=AssetUpdate、10=StartRemainingTime 位移） |
| StateChanged [2]（准备帧） | `MultiBattleRoomScene.as:600`→`serverMessage_StateChanged(params[0]=connectionId, params[1]=ReadyState)` :923-946：按 **connectionId** 匹配成员、`param2.index==1` 播就绪音 | server:`src/multi/tcp/lobby.ts:966-984` handleReady（Notify[3] 分支）→ `broadcastToRoom(room, [1, [2, mate.connectionId, mate.state]])` :985；mate.state = `data[1] ?? [1]`（客户端上送的 ReadyState enum 原样转发） | 对齐：参数序（connectionId 在前）、ReadyState 包装 `[0]`/`[1]`（NPC 初始化 :373 同形）、按 connectionId 而非 viewerId 匹配 |
| Mates [1] | `MultiBattleRoomScene.as:597`→`serverMessage_Mates(params[0])` :983-989 → refreshMates | server:`src/multi/tcp/lobby.ts:803`（成员变更全量广播 `[1, [1, client.mates]]`）、:478/:614（EnterComs 后补发） | 对齐 |
| Welcome [0] | `MultiBattleRoomScene.as:594`→Welcome(yourself, mates) :1096-1103（要求本人含在成员表） | server:`src/multi/tcp/lobby.ts:761/:793` `[1, [0, client.yourself, [client.yourself]]]` | 对齐（成员表含本人） |
| AckHeartbeat [11] | MeetingServerMessage.as:30-32（tag 11, [connectionId]） | server:`src/multi/tcp/lobby.ts:993` `[1, [11, client.connectionId]]` | 对齐（tag 11 CN 位移既定结论复验） |

外层信封：服务端下行 `[1, <enum帧>]`=房间广播、`[2, senderConnectionId, payload]`=定向转发（`src/multi/tcp/lobby.ts:1108-1121` 注释与实现）；客户端握手结果 enum 0-4（established/denied/reconnect/failure/close，client:`pinball/context/socket/socklet/SockletConnection.as:124-143`）与服务端 handshake 响应族一致（AGENTS.md 补全版修复项复验）。

---

## 6. 缺口清单

无 P1、无 P2。P3 共 3 项缺口 + 冗余记录：

| 编号 | 端点 | 类型 | 内容 | 影响 |
|---|---|---|---|---|
| G-1 | multi_battle_quest/start | 缺口 | `data.client_checks` 不发（client:`QuestStartRealRemote.as:155-183`；server:`src/multi/http/battle.ts:365-386` 无该键） | P3：与单人链 contract-audit-quest-battle.md G-1 同型；Option 缺席→战斗内客户端检查清单为空，multi 局内 client-check 型任务不判定不 echo；不崩溃、不阻塞结算 |
| G-2 | multi_battle_quest/create_room_failure | 缺口 | 服务端无路由（client:`RealRemote.as:832-836` send-only 遥测，调用点 `MultiBattleRoomPrepareFlow.as:370,396`） | P3：404 走通用错误处理（`RemoteServiceBase.as:43-50`）；仅在 create/prepare 已失败后发送且成功体本被忽略，增量影响为错误通道噪音 |
| G-3 | follow/search_twitter | 缺口+冗余 | 发 `twitter_follow_ids`（客户端不读）、不发 `search_result`（客户端→NoCache 合法分支） | P3：CN 客户端 SNS 不可达（read-routes.ts:37-38），无实际路径触发 |

冗余字段记录（服务端发、客户端端点解析器与公共层均不读，一律 P3，供将来瘦身参考）：
- search_room：`establisher_viewer_id`（lobby.ts:225）
- restore_room：`is_same_room`（room.ts:276/:297/:304）
- start：`is_multi`、`play_id`（battle.ts:369-370）
- finish：`mate_player_result`、`contribution_score`、`degree_list`、`category_id`、`start_time`、`is_multi`、`quest_name`（response.ts:125-136）+ `rewards.converted_pool_exp`（:108，与单人同案）
- abort：`category_id`、`is_multi`、`start_time`、`quest_name`（battle.ts:550-553）
- play_continue：`continue_count`（battle.ts:609 等）
- follow/search_twitter：`twitter_follow_ids`（read-routes.ts:48）

信息记录（非缺口）：multi finish 不发 rush/raid/carnival/score_attack 事件增量与 solo_time_attack_event（multi 无事件类别映射，客户端全为 Option）；select_room 客户端对 raising_state 5/6 抛 C5001 但服务端状态域（写入 1/2/4 + HTTP 投影 3/7/9/13）永不产生；prepare 对 4509 有分支但服务端不发；follow/search_id 的 1459 同理。

## 7. 结论

- **覆盖**：multi_battle_quest 16 个服务端实现端点 + create_room_failure（客户端侧遥测面）+ follow 7 端点 + gift/receive = **25 条 HTTP 契约面**，全部完成"客户端解析字段全集（类名+行号）→ 服务端发送字段全集（file:line）→ 差集判定"；另对 **5 个 TCP 帧**（StateChanged/Mates/Welcome/AckHeartbeat 下行 + Ready 上行）做了抽查。
- **结论**：共斗 HTTP 族与社交族的字段契约整体健康——所有客户端 `[必]` 字段（含 get_rooms 11 字段、select_room 11 字段、summon mate 全结构、verify_access_token 10 字段、follow_info 14 字段、finish 共用 29 字段中的必选项）均由服务端足额下发且类型吻合；raising_state 投影域与三个解析器（select 1-4/7-12、prepare 1/2/9、restore 全收敛）的接受域精确互补，`join-result.ts` 的编码注释与反编译互证。真实缺口只有 3 项 P3（client_checks 检查通道、create_room_failure 遥测路由、search_twitter 字段错位），无 P1/P2。
- **TCP 抽查**：StateChanged/Mates/Welcome/AckHeartbeat/Ready 五点全部与 docs/protocol/multi-battle.md §6.3 基线及反编译一致（connectionId 匹配、ReadyState `[0]`/`[1]` 包装、tag 11 位移），无需修订字段表。
