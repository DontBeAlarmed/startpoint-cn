# 客户端解析契约审计 — 会话/存档链(/load · save · user-update · party-code)

- 服务端基准:**commit 34848ccf**（worktree `starpoint-cn-dev-integration`，2026-11-05）。服务端 file:line 均为该 commit 下真实位置。
- 客户端对照证据:`wf-cn-client-as3-20261014/`（1.8.1 补全版反编译），路径前缀 `scripts/`（下文省略）。
- 方法:对每个端点先从客户端反编译提取**解析面**（逐字段区分"严格必读"——缺失/类型错即抛 ClientError 87xx;与"null 容忍"——缺失折叠为 Option.None),再与服务端**发送/接收面**逐字段求差。`/load` 的解析面以 `InitializeRealRemote.loadSuccessHandler`（`pinball/remote/initialize/InitializeRealRemote.as:1428-6460`）为准:公共 toast 片段 `:1638-2156`（active_mission_list/encyclopedia_info/mission_info/over_max），主解析体 `:2169-6250`,最终装配对象 `:6251-6325`,随后 `restoreFinishedHandler`（`:564-1290`）全量消费并写入 PlayerRepository。
- 判定分级:**一致 / 缺口（客户端读、服务端不发）/ 类型偏差 / 冗余（服务端发、客户端不读）/ 端点缺失**。存疑处标"待真机"。

---

## 一、/load（initialize 大响应）

### 1.1 请求面（客户端 → 服务端）

客户端 `startLoad`（InitializeRealRemote.as:297-400）请求体 `:359-369`:`device_id`、`device_token`、`keychain`、`graphics_device_name`、`platform_os_version`、`storage_directory_path`、`oaid`、`imei`、`mac`、可选 `advertise_id`;LocalStore 模式追加 header `SHORT_UDID` + body `viewer_id`（`:386,395-396`）。
服务端 `src/routes/cn/load.ts:77-89`（CnLoadBody）全部受理;`viewer_id || keychain`（load.ts:217）且要求 VIEWER 会话（:222-226）。`device_token/graphics_device_name/platform_os_version/storage_directory_path/oaid/imei/mac/SHORT_UDID` 服务端收下但不消费 —— 一致（可接受的未用输入）。

### 1.2 响应面严格必读字段（客户端缺了就抛 ClientError)

客户端严格字段全集（InitializeRealRemote.as）:associate_token `:2340`、available_asset_version `:2354`、bug_report_url/cn_crash_url/qq_group_url/survey_url `:2491,2634,4251,4809`、config `:2667-2820`（22 子键全严格 Int,contribution_score_rate_to_parasite 为 Float）、drawn_quest_list `:2934-2971`、enable_customer_service/gift/little_assistant/newbie/rename `:2980-3030`、favorite_party_group_list `:3128-3349`、fund_receive_list `:3384-3399`、gacha_info_list `:3459`、last_crazy_gacha_draw_result `:3672`、mail_arrived `:3791`、monthly_charge_bonus_info.bonus_days/expired_time/init_time `:3813-2412 区段`、pass_force_reward `:3925`、payment_rebate_info.expired_time/status `:3932-4021`（present_list null 容忍 `:2522-2527`）、simple_payment_item_list `:4554`、user_info `:5436-5768`（子键 birth/bond_token/boost_point/boss_boost_point/comment/degree_id/enable_auto_3x/exp_pool/exp_pooled_time/free_mana/free_vmoney/is_bought_fund_*×5/is_comeback/is_newbie/last_login_time(**String** `:5576-5580`)/month_card_remain_days/monthly_payment_total/name/paid_mana/party_slot/rank_point/**renewal_gift_remain_days(StringMap,Reflect.fields 直读 `:5623-5632`)**/role/stamina/stamina_heal_time/star_crumb/transition_state/vmoney/weekly_bonus_remain_days）、user_option `:5769-5860`（12 子键全严格 Bool）、user_triggered_tutorial `:6130`。

服务端覆盖核对:

| 客户端严格字段 | 服务端 file:line | 判定 |
|---|---|---|
| associate_token | `src/data/utils/serialize-player.ts:385` | 一致 |
| available_asset_version | `load.ts:96`（wrapOptionFields）/ `serialize-player.ts:333` | 一致 |
| 4 个 URL | `load.ts:121-124` | 一致（survey/qq/bug 为空串,String 合法） |
| config 22 键 | `serialize-player.ts:386-410` | 一致（键值齐全,summon_com_seconds 可注入 `:387`） |
| drawn_quest_list | `serialize-player.ts:337-343` | 一致 |
| enable_* 5 键 | `load.ts:125-130` | 一致 |
| favorite_party_group_list | `load.ts:434-438`（getFavoritePartyGroupListSync） | 一致;子结构 party_group_id/color_id/party_list(ability_soul_ids/character_ids/equipment_ids/options.allow_other_players_to_heal_me/party_edited/party_id/party_name/unison_character_ids) 由 `translateFavoriteParty`（InitializeRealRemote.as:136-180）消费 |
| fund_receive_list | `serialize-player.ts:378` | 一致（Int[]） |
| gacha_info_list | `serialize-player.ts:298-327` | 一致;crazy_draw_count/daily_one_count/daily_ten_count/comeback_campaign/stars_campaign 条件可选,客户端 null 容忍（InitializeRealRemote.as:4921 区段） |
| last_crazy_gacha_draw_result | `load.ts:139`（??= []） | 一致 |
| mail_arrived | `serialize-player.ts:344`（未收邮件数>0 → Bool） | 一致 |
| monthly_charge_bonus_info | `load.ts:153` | 一致（多送 status/start_time,见冗余清单） |
| pass_force_reward / payment_rebate_info / simple_payment_item_list | `load.ts:137,152,133` | 一致 |
| user_info | `serialize-player.ts:234-266` + `load.ts:98-113` 补 is_bought_fund_*/is_newbie/is_comeback/month_card/weekly_bonus/monthly_payment_total 默认 | 一致;**renewal_gift_remain_days 类型偏差见缺口 S-5** |
| user_option | `serialize-player.ts:336`（players_options 全量,`src/data/domains/option.ts:73-91`）+ `load.ts:116-118` 补 episode_encyclopedia_suggest_show/server_push/stamina | 一致;新建号默认种子 9 键（`src/data/domains/player.ts:704-714`）+ wrap 补 3 键 = 12 键全齐 |
| user_triggered_tutorial | `serialize-player.ts:284` | 一致 |

### 1.3 响应面 null 容忍字段（缺失=功能静默降级）

| 客户端字段(解析位置 InitializeRealRemote.as) | 服务端 | 判定 |
|---|---|---|
| bonus_index_list[i]{bonus_group_id:String,bonus_group_type:String,index:Int} `:2356-2403`;login_bonus_received_at(Float) `:2376-2387` | `load.ts:439-449`（settlement none → 空表+null;granted → groupId:string ✓ receivedAt:number ✓） | 一致 |
| user_tutorial{skip_flag,tutorial_step} `:6128-6192` | `serialize-player.ts:209-223,285` | 一致 |
| tutorial_gacha{character_id} `:6096 区段` | `serialize-player.ts:286-288` | 一致 |
| unfinished_quest_list / unfinished_multi_quest_list[i]{play_id,continue_count} `:6387-6432`（restore.readBattleHead 消费） | `load.ts:464-477` | 一致（multi/single 互斥注入） |
| aborted_play_id_list `:2189-2209` + 消费 `:953`;aborted_quest_info.is_attention `:2210-2226` + 消费 `:1060` | 服务端不发送 | **缺口 S-4** |
| carnival_event_record_list[k].records[i]{best_score:Float,folder_id:Int} `:2498-2574` + 消费 `:1014` | 服务端不发送(DB 有数据) | **缺口 S-2** |
| first_keyword_unlocked_character_ids `:3355-3378` + 消费 `:875` | 服务端不发送 | **缺口 S-3** |
| encyclopedia_info[k].read `:1760 区段`（公共片段） | 服务端不发送 | 缺口 S-6（图鉴已读标记不回灌,客户端本地留存） |
| all_active_mission_list[k]{progress:Int 严格,ingame_reward_id/ingame_status null 容忍,stages null 容忍} `:2227-2329` | `serialize-player.ts:346`（PlayerActiveMission{progress,stages}，`src/data/types.ts:358-361`）;登录事实结算经 `load.ts:493-523` + `src/lib/mission/response-fragment.ts` 增补 | 一致（ingame_* 不发→None,容忍） |
| active_mission_list[i]{mission_id,progress_value,stages[{stage,received}]} `:1652-1720`（公共片段,StoreCommonToastResponse `:2151-2155`） | `serialize-player.ts:452-454`（activeMissionsOverride ← `load.ts:415`） | 一致 |
| mission_info[i]{mission_category_id,mission_reward_id} `:2145 区段` | `load.ts:450`（恒 []） | 一致（空=无待领取提示,见结论） |
| over_max[i]{amount_sold,character{character_id,number},converted_*,equipment{...},free_mana,free_vmoney,item{...},pooled_exp,process_type,star_crumb,vmoney} `:2086-2143` | `load.ts:451-462`（projectItemOverflowCommonResponse,仅溢出时注入） | 一致 |
| user_character_list[k]（bond_token_list/entry_count/evolution_level/ex_boost/exp/illustration_settings/join_time/mana_board_awake/mana_board_index/over_limit_step/protection/stack/update_time）`:3546-4020 区段` + 消费 `:707-717` | `serialize-player.ts:290`（growthLoadProjection ← `src/lib/character-growth/load-projector.ts` + `response-projector.ts:71-98` 含 entry_count/update_time/join_time） | 一致（角色线第一批已细审） |
| user_character_mana_node_list[k][i]{awake_level,multiplied_id} | `serialize-player.ts:291` | 一致 |
| user_equipment_list[k]{enhancement_level,level,protection,stack} `:4025 区段` + 消费 `:853,854` | `serialize-player.ts:175-183` | 一致 |
| item_list[k] `:2118 区段` + 消费 `:797` | `serialize-player.ts:293` | 一致 |
| quest_progress[k][i]{best_elapsed_time_ms,clear_rank,finished,high_score,host_finished,quest_id,ranking_event.best_record{elapsed_time_ms,is_accomplished,score},unlocked} `:2870-2999` + 消费 `:762,766` | `serialize-player.ts:29-41,296`（ranking_event 不发→null 容忍 `:2945-2948`） | 一致 |
| user_party_group_list[k]{color_id,list[k]{ability_soul_ids,character_ids,edited,equipment_ids,name,options.allow_other_players_to_heal_me,unison_character_ids}} `:5867-6060` + 消费 `:643-664`（fromPartyInfoLite） | `serialize-player.ts:172,292`（serializePartyGroupList） | 一致 |
| user_daily_challenge_point_list[i]{id,point,campaign_list[{additional_point,campaign_id}]} `:2413 区段` + 消费 `:827` | `serialize-player.ts:269-280` | 一致 |
| user_periodic_reward_point_list[i]{id,point} `:6100 区段` + 消费 `:1277` | `serialize-player.ts:345`（`src/data/types.ts:342-345`） | 一致 |
| gacha_campaign_list[i]{campaign_id,count,gacha_id} `:3410 区段` | `serialize-player.ts:349` | 一致 |
| box_gacha_list[k][i]{box_id,is_closed,remaining_number,reset_times} `:2455 区段` + 消费 `:984` | `serialize-player.ts:196-206,348` | 一致 |
| converted_gacha_list[i]{gacha_exchange_point,gacha_id} `:2440 区段` + 消费 `:968` | `load.ts:433` | 一致 |
| crazy_gacha_result_list[k][i] `:3300 区段` + 消费 `:901` | `load.ts:430-431` | 一致 |
| stars_gacha_campaign_list[i]{campaign_id,free_one_times,free_ten_times} `:4740 区段` + 消费 `:1263` | `serialize-player.ts:328-332` | 一致 |
| start_dash_exchange_campaign_list[i]{campaign_id,gacha_id,period_*,status,term_index} `:4526 区段` + 消费 `:1317` | `serialize-player.ts:362-371` | 一致 |
| special/multi_special_exchange_campaign_list[i]{campaign_id,status} `:4626/4470 区段` + 消费 `:1297,1353` | `serialize-player.ts:372-384` | 一致 |
| premium_bonus_list/expired/premium_bonus_index_list/premium_bonus_mailed_item_list `:3998-4490 区段` | `serialize-player.ts:267-268` + `load.ts:134-135`（恒空/无） | 一致（私服无付费月奖） |
| purchased_times_list[k] `:4560 区段` + 消费 `:1444` | `serialize-player.ts:350-361`（10 个 sku→0） | 一致 |
| ranking_event_reward[i]{event_id,quest_kind,score,score_rank,score_ranking_event_ranking_reward_id} `:4640 区段` + 消费 `:1381` | `load.ts:149`（恒 []） | 一致（排名活动奖励未实现,空=无提示） |
| should_prompt_takeover_registration `:4956 区段` | `serialize-player.ts:334`（false） | 一致 |
| tower_dungeon_list[i]{event_id,reset_month,reset_status} `:4864 区段` + 消费 `:1507` | `load.ts:141`（恒 []） | 一致（塔地下城无内容,空合法） |
| user_notice_list[i]{kind,status} `:4756 区段` + 消费 `:873` | `serialize-player.ts:283`（[]） | 一致 |
| win_lottery_active_mission_list[k]{real_reward_id,transitioned_url,url} `:6194-6250` + 消费 `:1402` | `load.ts:143`（恒 []） | 一致 |
| skips_lounge_restore/skips_room_restore `:4600-4626`（客户端本地 restore 开关） | 服务端不发送 | 一致（None → 客户端自行尝试本地 restore,行为正确） |
| session_token `:2329 区段` | 服务端不发送 | 缺口 S-7（死字段） |
| comeback_campaign_boss_boost{period_end_time} `:2434 区段` + 消费 `:1245` | `load.ts:154`（全 0） | 一致（无回归 boss boost 内容） |
| last_main_quest_id `:3720 区段` | `serialize-player.ts:297`（null） | 一致（current_quest=None `:685`） |

### 1.4 头部依赖

`restoreFinishedHandler:628-638` 严格读 `data_headers.servertime`（缺 → ClientError 5000"无法获取服务器时间"）。服务端 `load.ts:479-485` generateDataHeaders 含 servertime —— 一致。

### 1.5 前置 tool/signup（会话链起点）

客户端 `startSignUp`（InitializeRealRemote.as:216-295,body `:245-255`）→ 响应 `signUpSuccessHandler:406-505`:严格读 header.viewer_id `:419-428`、header.short_udid `:429-438`;读 data.login_token `:458`、data.newAccount==1 时的 roleName/accountName/sign/createDate（雷腾 createRole 上报 `:485-505`）。
服务端 `src/routes/api/tool.ts:36-85`:data_headers 含 viewer_id/short_udid/udid/servertime/result_code ✓;但 `data: []`（:83）→ **缺口 S-8**:login_token/newAccount/roleName/accountName/sign/createDate 全缺,雷腾角色上报链静默失效(不影响游戏逻辑,待真机确认 SDK 侧无副作用)。

---

## 二、save_v2（存档上传）—— 任务假设修正

**结论:游戏客户端不存在存档上传端点。** 证据:

1. 客户端 remote 目录族（`pinball/remote/*`）无 save 端点;全部 `new RequestSetting` 路径枚举仅 load/tool/signup/tool/get_header_response/tool/user_reset/leiting_*。
2. `pinball/common/data/save/PlayerSaveDataTools.as:26-90`（createDummy）与 `setStack/deleteCharacter/addCharacter` 等是**本地存档**操作,消费方仅 `DummyRemote.as:2626,3769,3860,4040`、`DummyPlayerLogic.as:155,160`（开发用假服务器）与本地 restore 链（`InitializeRealRemote.restore`）。
3. 客户端持久化模型 = 本地 AIR 存档（PlayerSaveDataTools→localStore）+ 每个动作端点单独落库;服务端无全量 save 接收面。

服务端 `src/data/player-save/v2.ts`（format v2,`types.ts:1-2`;`registry.ts:18-95` 共 71 表,core/missions/events/economy/mailbox 5 域）与 `src/routes/web_api/player.ts:143-164（GET 导出）/166-200（POST 导入,validatePlayerSaveSnapshotSync→restorePlayerSaveSnapshotSync）` 是 **admin 面板专属快照格式**,不在游戏协议面。对照含义:save 链的客户端契约落在 /load 下发（1.2/1.3 已逐字段）+ 各动作端点回包（其余审计线覆盖）。无缺口可判;v2 schema 与 /load 投影共用同一批 domain 序列化器,两端一致性由 `serialize-player.ts` 单点保证。

---

## 三、user/update 类（改名/资料/选项）

### 3.1 profile/rename

- 客户端 `pinball/remote/profile/rename/ProfileRenameRealRemote.as:25` 发 `{name}`;成功分支 `:34-38` **不解析任何 data 字段**;错误分支 `:47-58` 期待码 207（NG 词 → NgWordError）、6001（改名限制 → PlayerNameChangeRestriction）。
- 服务端 `src/routes/api/profile.ts:399-427`:校验会话,name 截断 20 字,恒 200 `data:{name}`。
- 判定:一致（响应面）;**缺口 S-9**:无 NG 词/改名次数语义,207/6001 永不触发（私服可接受,记录）。

### 3.2 profile/update_comment / update_degree

- 客户端 updateComment `:27` 发 `{comment}`,成功 `:34-38` 不解析 data;207 → NgWordError `:47-52`。updateDegree `:22` 发 `{degree_id}`,成功 `:31-35` 不解析 data。
- 服务端 `profile.ts:368-396`（comment 截断 100）、`:269-316`（update_degree）。
- 判定:一致;S-9 同样适用于 comment 的 207 分支。

### 3.3 profile/update_profile_settings

- 客户端 `ProfileUpdateProfileSettingsRealRemote.as:48-75` 严格解析 `data.profile_settings.{show_opened_mana_board_second_count,show_owned_character_count,show_owned_degree_count}` 三个 Bool。
- 服务端 `profile.ts:317-365` + `serializeProfileSettings:31-39`:三键 snake_case Bool 回显 —— **一致**。

### 3.4 option/update 与 option/update_in_battle

- 客户端 `RealRemote.optionUpdate/optionUpdateInBattle`（`pinball/context/remote/real/RealRemote.as:732-735,726-730`）发 `{option_params}`,经 `sendOnlyUserRequest`（`:508-510`）→ 成功回调 `FunctionTools.emptyFunction1`,**响应完全不解析**。
- 服务端 `src/routes/api/option.ts:13-49`:受理 Record<string,boolean>,`updatePlayerOptionsSync`（`domains/option.ts:119-125`,过滤 server.* 键）,回显 `data.user_option`。
- 判定:一致（回显为冗余但无害,见 R-2）。

---

## 四、party/publish 与 party/refer（队伍代码）

### 4.1 party/publish

- 客户端调用点:`pinball/scene/character/top/CharacterTop.as:818`（编队画面分享按钮）→ `RealRemote.partyPublish`（RealRemote.as:703-706）→ `pinball/remote/party/publish/PartyPublishRemote.as:33-93`:发 `party_name` + `battle_party{characters/unison_characters:[{id,mana_node_ids,evolution_level,exp,over_limit_step,illustration_settings,ex_boost}],equipments:[{equipment_id,level}|null],ability_soul_ids:[Int|null]}`;viewer_id 由 RequestQueue 统一注入（`pinball/context/remote/RequestQueue.as:237,253`）。响应严格解析 `data.party_code:String`（PartyPublishRemote.as:192-197）。
- 服务端 `src/routes/api/party.ts:430-463`:校验 viewer 会话后恒回固定假码 `:459`;`battle_party` 载荷声明为 `{}` 且全程未读（`:421-427`）。
- 判定:响应面一致（String ✓）;语义缺口——party_code 不对应任何可 refer 的数据（配合 4.2 缺口,分享码只在发送端本地可见）。**待真机**:客户端把 party_code 当 URL 文案展示/复制,假码不影响 UI。

### 4.2 party/refer —— 端点缺失（维持 character 线 P2 判定,本线补客户端证据）

- 客户端调用点:`pinball/scene/partyGroupEdit/PartyGroupEditScene.as:882`（输入/粘贴队伍代码）→ `RealRemote.partyRefer`（RealRemote.as:698-701）→ `pinball/remote/party/refer/PartyReferRemote.as:27-28` 发 `{"party_code":…}`。
- 响应解析 `:53-490`:严格要求 `data.battle_party` 为 Object,内含 `ability_soul_ids`（Array,元素 Int|null）、`characters`/`unison_characters`（元素 Object{id,mana_node_ids,evolution_level,exp,over_limit_step,illustration_settings,ex_boost{ability_id_list,status_id}|null}）、`equipments`（元素{equipment_id,level}|null）——与 publish 上行同构,即**官方语义是"回显被分享的完整编队"**。
- 错误分支 `:535-555`:3403=PartyCodeIncompatible、3404=PartyCodeNotFound、3405=PartyCodeOldBinary。
- 服务端 `src/routes/api/party.ts` 仅注册 `/publish`、`/edit`、`/check_word`（`:430,465,674`）,全仓无 `/refer` 路由 → 客户端请求将落在框架 404/H404,三个专属错误码永远无法返回。
- 判定:**端点缺失（P2,与 character 线判定一致）**;补全面 = 上述 battle_party 全结构 + 三错误码。

---

## 五、缺口清单（汇总）

| # | 级别 | 缺口 | 客户端证据 | 服务端现状 | 影响 |
|---|---|---|---|---|---|
| S-1 | — | （预留:无 P1。/load 严格必读字段全部已覆盖,`/load` 响应可完整通过客户端解析） | — | — | — |
| S-2 | **P2** | `/load` 不发送 `carnival_event_record_list`,狂欢活动最佳分记录重启即清零 | 解析 InitializeRealRemote.as:2498-2574;消费 :1014 | DB 已有 `players_carnival_event_records`（`src/lib/carnival-save-state.ts:34-40`）且已注入 MergedPlayerData（`src/data/utils/player-data.ts:180`）,仅 `serialize-player.ts` 未投影该键 | 数据在手、补投影即可;不修则狂欢活动历史成绩/前回编队展示丢失 |
| S-3 | **P2** | `party/refer` 端点缺失 | PartyReferRemote.as:27-28（请求）、:53-490（battle_party 全量解析）、:535-555（3403/3404/3405）;调用点 PartyGroupEditScene.as:882 | `src/routes/api/party.ts` 无 /refer 路由 | 输入队伍代码必失败;修复需实现响应 battle_party 全结构+三错误码 |
| S-4 | P3 | `/load` 不发送 `aborted_play_id_list`/`aborted_quest_info` | 解析 :2189-2226;消费 :953,1060 | `load.ts:366-391` 服务端自行 abort 不可恢复的 multi quest,但不通知客户端 | 客户端无"战斗已被中止"提示;客户端有本地 restore 兜底,影响小 |
| S-5 | P3 | `user_info.renewal_gift_remain_days` 类型偏差:客户端按 StringMap `Reflect.fields` 直读 | InitializeRealRemote.as:5623-5632 | `load.ts:112` 默认 `??= 0`（Int） | `Reflect.fields(0)` 空迭代,不崩溃但月卡续礼剩余天数恒空;应发 `{}` 或真实 map |
| S-6 | P3 | `/load` 不发送 `encyclopedia_info`（已读状态回灌） | 解析 :1760 区段（公共片段） | 无对应投影 | 图鉴已读标记仅存客户端本地,清档/换机丢失 |
| S-7 | P3 | `session_token` 不发送 | 解析 :2329 区段（null 容忍） | 不发送 | 全客户端无其他消费（仅 InitializeRealRemote 出现该串）,死字段,记录即可 |
| S-8 | P3 | `tool/signup` 响应 `data:[]`,缺 login_token/newAccount/roleName/accountName/sign/createDate | signUpSuccessHandler InitializeRealRemote.as:458,485-505 | `src/routes/api/tool.ts:78-84` | 雷腾登录/建角色 logmonitor 上报链静默失效,游戏逻辑不受影响;待真机确认 SDK 无重试副作用 |
| S-9 | P3 | rename/update_comment 的 NG 词(207)与改名限制(6001)分支无服务端语义 | ProfileRenameRealRemote.as:47-58;updateComment :47-52 | `profile.ts:399-427,368-396` 恒成功 | 私服可接受;若接入敏感词再补 |

## 冗余清单（服务端发、客户端 /load 不读;均无害,记录备查）

| # | 字段 | 服务端位置 | 说明 |
|---|---|---|---|
| R-1 | `user_info.leader_character_id` | `serialize-player.ts:251` | /load 解析面无此键（客户端队长语义走 party 数据）;保留无害 |
| R-2 | `option/update` 回显 `user_option` | `option.ts:45-47` | 客户端 sendOnlyUserRequest 不解析响应 |
| R-3 | `login_info` / `party_list` | `load.ts:140,150` | /load 解析面无此二键（队伍走 favorite_party_group_list/user_party_group_list） |
| R-4 | `user_character_from_town_history` | `serialize-player.ts:295` | /load 解析面无此键 |
| R-5 | `has_unread_news_item` | `serialize-player.ts:335` | /load 解析面无此键（新闻计数走 mail_arrived/news 域） |
| R-6 | `monthly_charge_bonus_info.status/start_time` | `load.ts:153` | 客户端只读 bonus_days/expired_time/init_time 三键 |

---

## 六、结论

1. **/load 是全审计中唯一存在"严格必读"高压线的端点**:62 个顶层键中 24 个严格（缺/类型错即 ClientError 87xx）,本审计逐一核对后**全部覆盖**——无 P1。user_option 的 12 个严格 Bool 由"DB 种子 9 键（player.ts:704-714）+ wrapOptionFields 补 3 键（load.ts:116-118）"拼齐,链路成立但分散,新增选项键时两处都要动。
2. 真正的功能性缺口集中在三处:**S-2 狂欢记录未投影**（数据已在 DB,只差 serialize-player 一个键,修复成本最低、收益直接）;**S-3 party/refer 端点缺失**（与 character 线判定互证,响应契约已从反编译完整钉死）;**S-8 signup 上报链**（无游戏影响）。其余为类型偏差（S-5）与静默降级（S-4/S-6/S-7/S-9）。
3. **save_v2 不是客户端协议**:客户端无存档上传端点,存档链契约 = /load 下发 + 动作端点逐笔落库;`player-save/v2.ts`（71 表快照）与 `web_api/player.ts /save` 属 admin 面板,与游戏协议无交集。任务范围内该组判"无客户端契约面可违"。
4. 本线覆盖端点组 4 组、具体端点 10 个:/load、tool/signup（前置）、admin save GET/POST（定性）、profile/rename、profile/update_comment、profile/update_degree、profile/update_profile_settings、option/update、option/update_in_battle、party/publish、party/refer（缺失判定）。真机待验项:party_code 假串在分享 UI 的表现;signup 缺省字段对雷腾 SDK 的副作用。
