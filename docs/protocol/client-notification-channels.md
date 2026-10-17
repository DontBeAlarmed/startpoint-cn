# 服务端→客户端 通知/触发通道全量档案

> 探查基线：CN 1.8.1 客户端反编译（`wf-1.8.1-cn-decompiled/scripts/`，下称 client/）× 服务端 `starpoint-cn/src/`（下称 server/）。
> 目的：为「内容热更新及时生效 / 绑定功能回标题页 / 自动补货游戏内提醒」三个功能提供通道选型依据。
> 所有结论均带源码引用；混淆名保留原样并附推断语义。标注【推断】的为高置信但未经实机复验的结论。

## 0. 一页摘要表

| # | 通道 | 类型 | 踢回标题页 | 触发补丁下载 | 游戏内提醒 | 生效延迟 | 前置条件 |
|---|------|------|-----------|-------------|-----------|---------|---------|
| 1 | TCP lobby `AssetUpdate`(9) | 真主动推送 | **✅ 弹窗确认后自动回** | ✅ 回标题→点开始→差量下载 | ➖ 仅房间场景 | 即时（毫秒级） | 仅多人房间界面（lobby socket 在线时） |
| 2 | HTTP `data_headers.asset_update` | 响应内嵌信号 | **✅ 结算弹窗确认后回** | ✅ 同上 | ➖ 仅战斗结算页 | 下一次战斗结算 | 需要一场战斗作载体；仅结算链消费 |
| 3 | HTTP `data_headers.force_news` | 响应内嵌信号 | ➖ 不回标题 | ➖ | **✅ 下次切场景强插新闻页** | 下一次场景切换 | 需要一次场景切换；房间 socket 在线时不生效 |
| 4 | TCP `Disbanded`(6) / 主动断开 | 真主动推送 | ⚠️ 房间场景回（非全局标题） | ➖ | ➖ | 即时 | 仅多人房间 |
| 5 | 重新登录（signup/load） | 被动全量校验 | ✅（用户手动） | ✅ boot 差量检查 | ✅（load 全量数据） | 用户操作时 | 无 |
| 6 | 标题页→点开始（Global loading） | 被动资产校验 | ➖（已在标题） | ✅ `GlobalLoading` boot 检查 | ➖ | 用户操作时 | 无 |
| 7 | `attention/check` 轮询 | 周期拉取 | ➖ | ➖ | ⚠️ 仅招募铃铛专用 | 场景白名单内 15~30s | 主表 `AttentionEnableScene` 授权场景 |
| 8 | `mail_arrived` (load 内嵌) | 响应内嵌信号 | ➖ | ➖ | ✅ 主页邮件红点 | 下一次 load | 需要重新 load |
| 9 | 客户端运行时缺文件 → recovery | 自愈路径 | ✅（缺文件弹窗→标题） | ✅ files_list 补下载 | ➖ | 发现即触发 | 仅文件层缺失触发；内存表缺失(C8013)不触发 |
| 10 | `servertime` (任意响应头) | 时钟同步 | ➖ | ➖ | ➖（隐式） | 每次请求 | 无（已实现） |

---

## A. 真主动推送（TCP 会话）

TCP 会话只在多人流程中存在：进入多人房间界面时建 `cooperation_room` socket（socklet 握手），开战时切 `cooperation_battle`。见 server/`docs/protocol/multi-battle.md` §6。

### A1. lobby 服务端消息（`MeetingServerMessage`）

客户端枚举 client/`pinball/online/meeting/message/MeetingServerMessage.as:10-25`：

| Index | 名称 | 参数 | 客户端行为 |
|---:|------|------|-----------|
| 0 | Welcome | (self, members) | 填充房间成员列表 |
| 1 | Mates | (mates[]) | 全量同步成员（server/`src/multi/state/SessionManager.ts:1160` 已实现） |
| 2 | StateChanged | (connId, ready) | 更新指定成员准备状态 |
| 3 | AutoplayModeChanged | (connId, mode, reset) | 更新自动播放 |
| 4 | AutoStartChanged | (connId, flag) | 更新自动开战 |
| 5 | Start | (members[]) | 全员进入战斗 |
| 6 | Disbanded | (connId) | 见 A2 |
| 7 | RemainingTime | (seconds) | 房间倒计时 UI（server/`src/multi/room/manager.ts:21` 30s 前发送已实现） |
| 8 | Update | (connId) | 弹「应用版本通知」对话框（打开商店页），防重入（client/`pinball/scene/bossBattle/room/MultiBattleRoomScene.as:622-627,1532`） |
| **9** | **AssetUpdate** | 无参 | **见 A3（本档案最重要发现）** |
| 10 | StartRemainingTime | (seconds) | 开战倒计时 |
| 11 | AckHeartbeat | (connId) | 心跳应答（已实现） |

分发器：client/`pinball/scene/bossBattle/room/MultiBattleRoomScene.as:600-640`（`serverMessage_*` 系列）。

### A2. Disbanded / 服务端主动断开

- `Disbanded`：client/`MultiBattleRoomScene.as:999` — `cooperationRoomSocketContact.disband(...)`，房主额外调 HTTP `multiBattleQuestDisbandRoom`。房间 UI 销毁、回到（多人入口前的）来源场景。
- 服务端主动断开 socket：客户端走 IOError/close 分支（client/`pinball/context/socket/room/CooperationRoomSocketContact.as:615 disconnect()` 及状态机），效果类似非自愿断线——房间内弹提示/回退场景。【推断：与 Disbanded 的 UI 去向相近，但会带"连接异常"语义；未实机复验】
- **注意**：都只把玩家从房间踢出，不回标题页、不触发资产检查。

### A3. AssetUpdate(9) —— 现成的"踢回标题走补丁下载"通道 ⭐

client/`MultiBattleRoomScene.as:1008-1020`：

```actionscript
public function serverMessage_AssetUpdate() : void {
    if (cooperationRoomSocketContact.isConnecting()) cooperationRoomSocketContact.disconnect();
    if (isLeader()) remote.multiBattleQuestDisbandRoom(get_roomNumber());
    openDialog(new OkDialog([DialogContent.Text("resource_check_error_newdate")],
        new BindImpl2_1(FunctionTools0.expanded1, gotoTitleScene).execute));
}
```

行为链：断开房间 socket → （房主）解散房间 → 弹 OkDialog（`resource_check_error_newdate` = "资源有新版本"类文案）→ 确认后 `gotoTitleScene`。回标题后玩家点开始 → `TitleScene.as:459` `changeSceneWithLoading(LoadingTaskKind.Global(...))` → `GlobalLoading.applyLoad` case 2（client/`pinball/loading/global/GlobalLoading.as:379-390`）→ 版本差量检查/资产恢复。

**限制**：该消息只在 `MultiBattleRoomScene` 的分发器里被处理——**只有在多人房间界面（lobby socket 在线）时才能送达**。主页/单机玩法中无 lobby socket，无法接收。

**服务端发送能力**：帧格式为 JSON 数组 + `\0` 终止（server/`src/multi/state/SessionManager.ts:1160-1186` sendFrame/broadcastToRoom），发 `[9]` 即可；服务端具备向房间内任意/全部客户端发送任意 MeetingServerMessage 的原语。

### A4. battle socket 服务端消息

client/`pinball/online/battle/message/BattleServerMessage.as:14`：`Leave(0)` / `BattleStart(1)` / `Finalized(2)` / `Measurement(3)` / `LineSpeedWarning(4)`。`Leave` 处理在 client/`pinball/scene/battle/state/BattleScenePlayingStateImpl.as:457`（成员退出战斗）。无回标题/更新类语义。

---

## B. 轮询 / 定期拉取

### B1. `attention/check` —— 多人招募铃铛专用轮询

- 请求：`{request_number: 3, holding_number: <当前铃铛数>}`，client/`pinball/remote/attention/check/AttentionCheckRealRemoteService.as:238-241`。
- 响应：`data.multi[]`（每项 `{attention_key, quest_info:{room_number, category_id, quest_id, establisher_*}}`）→ `AttentionInput.ReceiveMulti` → 招募铃铛 UI。**响应没有通用触发动作字段**，`data.multi` 空即"无 attention"。
- 调度：client/`pinball/context/attention/AttentionSystemLogic.as:1027`（polling 状态机到点 → `remote.attentionCheck`）；update 每 20 帧驱动（同文件 `update()`，`frame % 20`）。
- **间隔与场景白名单来自主表**：`AttentionConfigLogic`（client/`pinball/common/data/attention/config/AttentionConfigLogic.as`）从 `AttentionConfigTable`（normalPollingInterval / battlePollingInterval / 各类 disableDuration）与 `AttentionEnableSceneTable`（哪些 SceneKind 允许轮询）读取。战斗中还需用户选项 `attention_enable_in_battle`（client/`AttentionSystemLogic.as:314-318`）。
- **结论**：是"客户端存在周期 HTTP 轮询框架"的证明，但语义被招募铃铛专用化，**不可直接复用为通用通知**；间隔/场景受我们主表内容控制（可调快，但响应语义不变）。

### B2. `tool/custom_notify` —— 单向遥测，不可用

client/`pinball/gbits/remote/GbitsCustomNotify.as:12-22`：发送 `{"data": <string>}` 后 onSuccess/onErrorHandler **均为空函数**——客户端完全不读响应。调用点仅两处（client/`pinball/loading/global/GlobalLoadingTask.as:1007,1082`，`"download_true"/"download_false"` 资产下载统计）。**不可承载通知**。

### B3. 邮件红点：`mail_arrived`

- 载体：**load 响应** `data.mail_arrived`（Bool，Option 包装），client/`pinball/context/remote/real/RealRemoteService.as:1007-1022` 解析；server 侧动态计数（`players_mails` 未领取数）。
- 消费：client/`pinball/context/reproduce/LogicStatus.as:1069` 存入 loadedData → 主页红点 client/`pinball/scene/home/HomeScene.as:1451-1456`。
- **限制**：只在（重新）load 时更新，主页停留期间不会刷新。

### B4. 新闻拉取

端点族：`news/index` / `news/system_index`（client/`pinball/remote/news/index/NewsIndexRealRemote.as:44`）、`news/get_info` / `news/get_system_info`（client/`pinball/remote/news/getInfo/NewsGetInfoRealRemote.as:24-25`）、`news/latest_forced`（client/`pinball/remote/news/latestForced/NewsLatestForcedRealRemote.as:24`，配合 force_news 中断使用）。服务端已实现（server/`src/routes/web_api/` news 域 + `src/routes/api/` news 端点）。

### B5. 其他周期性/登录期调用（实测日志 + 源码对照）

| 端点 | 时机 | 语义 |
|------|------|------|
| `channels/channel_leiting_pay/query_unfinish_order` | load 后 | 未完成支付订单检查（client `HasUnfinishedOrder` 错误分支可弹恢复框） |
| `bonus/shown` | RealRemote.as:2425 | 弹窗奖励已展示上报 |
| `comic/get_list` + `comic/image` | 主页 | 四格漫画 |
| `multi_battle_quest/get_rooms` | 多人入口页 | 房间列表（进页刷新，非常驻轮询） |
| `/debug?loc=...` | 客户端内部日志上报 | 高频遥测（服务端已静默处理） |

---

## C. 响应内嵌信号（HTTP 通用头）

### C1. `data_headers` 通用字段解析器

client/`pinball/remote/common/ResponseData.as:41-128`——**所有**走 RealRemoteService 的 HTTP 响应统一解析：

| 字段 | 类型 | 客户端处置 |
|------|------|-----------|
| `result_code` | Int | 打包进 header；**通用层不做分支**（全客户端仅 ResponseData 打包，无通用非 1 分支；业务码读取仅 `data.result_code` 层面的特例：OtherMenuScene.as:202、GiftRealRemote.as:97）。见 C4 |
| `servertime` | Number | **每个响应都校时**：client/`pinball/context/remote/RequestQueue.as:378-386` `clock.applyServerTime(header.servertime)`。server 已实现（`src/utils.ts:120-147` getServerTime） |
| `asset_update` | Bool | **C2 专述** |
| `force_news` | Int | **C3 专述** |
| `short_udid` / `viewer_id` | Int | 身份回显 |

server 侧生成器：`src/utils.ts:120` `generateDataHeaders({force_update, asset_update, short_udid, viewer_id, servertime, result_code})`——**六个字段我们全部可控**；`force_news` 需按 C3 追加（当前生成器未含，属加字段而非改协议）。

### C2. `asset_update: true` —— 战斗结算载体的"回标题走更新" ⭐

消费链（**仅战斗结算链**消费该信号）：

1. client/`pinball/remote/quest/finish/BattleQuestFinishRealRemote.as:2514` 读 `header.asset_update`；
2. → client/`pinball/loading/quest/BattleQuestFinishLoadingTask.as:491` 存入 `questResultContext.assetUpdate`；
3. → client/`pinball/scene/questResult/QuestResultScene.as:1499-1503,1838`：结算页收尾时若为 true → `openErrorDialog(new RemoteError(RemoteErrorKind.ResourceVersionError(214),...), gotoTitleScene)`——弹"资源版本错误(214)"对话框，确认后回标题；
4. 回标题 → 同 A3 尾段，点开始走 Global loading 差量下载。

**这正是实测"战斗结束才生效"的机制本体**。限制：载体必须是 quest finish 响应；普通主界面操作不会消费。

### C3. `force_news` —— 两档语义（值 1 = 强插；值 2 = 主页每日公告）

消费链（公共部分）：

1. client/`pinball/remote/common/ResponseData.as:63-77` 解析 `force_news`（Int）→
2. client/`pinball/context/remote/real/RealRemoteService.as:89` **基类构造器**：任意响应 → `newsInterruptFlagSender.send(param1.force_news)` →
3. client/`pinball/context/Logic.as:1066-1074`：`logicStatus.newsInterruptFlag = <value>`。

**值 1（强插单条）**：client/`pinball/context/scene/InterruptTransitionProcessor.as:223-241` `needInterruptNews`——**下一次场景切换**时若 flag==1 且已加载完毕、**不在房间 socket 连接中**、非教程中 → 插入 `NewsDialogInterruptionTask`：
- 任务启动即**清 flag**（client/`pinball/loading/news/NewsDialogInterruptionTask.as:65`，一次性消费）→
- 调 `news/latest_forced` 取单条内容 → 以 `NewsDetailDialog(NewsDetailTransitionKind.Force)` **模态弹窗**覆盖目标场景（同文件 `interruptWithNewsHandler`，行 91+）。
- **打断频次 = flag 置位窗口内的场景切换数**：客户端一次性消费，但服务端每个响应重新置 1 会连续触发（每日例行事件慎用，服务端需节流）。

**值 2（主页每日公告列表）**：client/`pinball/scene/home/HomeScene.as:1010-1030` `startDailyNews`——主页到达时若 flag==2 且条件满足 → 弹一次 `NewsDialog`（公告**列表**）→ 自行清 flag。**不打断场景切换**，天然"每日一次"语义，即官方"每日首次到主页展示公告"的原生机制。

**服务端现状**：`news/latest_forced` / `latest_forced_system` 为空 stub（server/`src/routes/api/news.ts:135-150`，返回 `{}`），无存储实现——内容载体完全由我们设计，**可与 news/index 表分离（瞬态存储），不必然污染公告列表**。

**适用性**：force_news=1 适合例外事件（限定库存/紧急公告）；"每日补货"类例行走 force_news=2 + 单条常驻公告行（原地更新，列表不膨胀）更合语义。

### C4. `result_code` 的现实语义

通用层不做非 1 分支（见 C1）；真正驱动全局 UI 的是**错误对象**（`RemoteErrorKind`，client/`pinball/context/remote/RemoteErrorKind.as:18-21`）：WholeMaintenanceError / ApplicationVersionError / ResourceVersionError(5) / LoginTokenNotMatch 等——由各业务 service 在响应体内容异常时构造，或 HTTP 层错误（HttpStatusError）。维护/版本类弹窗的 UI 在 client/`pinball/context/scene/LogicScene.as:3121`（ApplicationVersionErrorDialog）与 client/`pinball/loading/reload/ReloadLoadingTask.as:203`、client/`pinball/loading/global/GlobalLoadingTask.as:749`。**结论**：想借 result_code 触发全局弹窗没有通用机制，需按接口逐个实现（服务端伪造特定错误体）——不推荐。

---

## D. 被动校验时点（服务端可夹带状态的窗口）

| 时点 | 客户端动作 | 源码位置 | 可夹带 |
|------|-----------|---------|--------|
| 启动 boot | versionCheck(.dis) → tool/signup → load → query_unfinish_order → custom_notify | 实测日志顺序；client `pinball/context/Logic.as` 启动序列 | **load 全量存档**（含 mail_arrived、任务、扭蛋券等一切数据） |
| 战斗结束 | quest/finish → 结算页消费 `asset_update` | C2 链路 | `asset_update` / `force_news` / 结算数据 |
| **任意请求响应** | 通用头解析 | C1/C3 | `force_news` / `servertime` / `asset_update`（虽然仅结算链读） |
| 标题页→点开始 | `LoadingTaskKind.Global` → boot 资产检查（差量下载 / prepareAssetRecovery） | client/`TitleScene.as:459`、`GlobalLoading.as:379-390` | 无（客户端主动） |
| 场景切换 | InterruptTransitionProcessor 检查 newsInterruptFlag / 战斗恢复 | client/`InterruptTransitionProcessor.as:210-260` | force_news 在此生效 |
| 运行时缺文件 | FileNotFound → files_list 检查 → AssetRecovery 补下载 | client/`Logic.as:1326-1336`（`fileNotFoundInput`，全仓库唯一入口） | 无（客户端主动，服务端只需 files_list/文件就绪） |
| 主表缺失（内存） | 直接 ClientError 8013，**不走文件层、无自愈** | client/`pinball/asset/logic/LogicAssetContainer.as:486-494` | 无 |

**关键结论**：客户端没有"服务端指挥我重新 load"的通用机制——全量数据刷新只有重新登录一条被动路径。

---

## E. 本地定时器 / 调度源

| 定时器 | 宿主 | 周期 | 服务端可影响性 |
|--------|------|------|--------------|
| attention 轮询 | client/`AttentionSystemLogic.update()`（每帧驱动，`frame%20` 粒度）+ pollingState(Booked) | 主表 `normalPollingInterval` / `battlePollingInterval`（毫秒，进可接收场景时随机延迟启动） | ✅ 经主表内容（但语义仅铃铛） |
| TCP 心跳 | lobby `Notify(4) Heartbeat` 客户端定期发 | 见 multi-battle.md §6.3 | 租约在服务端（SessionManager），可主动断 |
| 房间过期 RemainingTime | server/`src/multi/room/manager.ts:21`（服务端主动推） | 过期前 30s 一次 | 已实现 |
| TCP 重试/超时 | client/`RequestQueue`（RETRY_LIMIT/RETRY_INTERVAL，连接总超时 devConfig） | 请求级 | devConfig 本地，不可远程调 |

---

## 三个功能场景的落地方案建议

### 场景 1：内容热更新（CDN apply 后及时生效）

**现状**：apply 后客户端要等下一次战斗结算（`asset_update` 消费）或重登。

**推荐组合**：
- **主通道：TCP `AssetUpdate`(9)** —— apply 完成后对**所有在线 lobby socket**（即正在多人房间界面的玩家）广播 `[9]`，弹窗确认→回标题→点开始→差量下载。毫秒级触达，零客户端改动。覆盖面 = 房间内玩家。
- **兜底：结算响应 `asset_update: true`** —— `generateDataHeaders` 全局（或仅 finish）置 true，覆盖不在房间的玩家，等下一场战斗结束生效（现状即如此，无改动成本）。
- **覆盖剩余场景**：主页停留、纯单机不战斗不进房的玩家——无现成主动通道，只能等重登。可作为开放问题（见 §开放问题 1）。

### 场景 2：绑定功能需要客户端回一次标题页

- 若玩家在**多人房间**：`AssetUpdate`(9) 完全复用（弹窗文案是通用的"资源检查"类，但语义不合——需要斟酌是否接受复用；见开放问题 2）。
- 一般情况：**没有服务端主动回标题的通用通道**。最接近的合规替代：`force_news` 强插新闻页（C3）——把"请回标题完成绑定"做成一条强制新闻，玩家下次切场景即见。虽不真正回标题，但提醒可达。
- 强硬手段【不推荐】：对特定请求返回触发 `LoginTokenNotMatch` 类错误的响应体，令客户端走登录失效流程（该分支会回登录/标题——**未实证**具体 UI 去向，见开放问题 3）。副作用大（玩家存档上下文丢失、可能触发重连风暴）。

### 场景 3：自动补货游戏内提醒（最终决策：邮件通道，公告方案已撤除）

- **最终实现：无附件信息邮件（1 天限时）**——发放日 load 结算成功后插一封
  reason_id=0 的邮件（客户端 Reason 表无 0 号键 → 回退渲染服务端
  subject/description 原文），正文 = 规则描述 + 发放时刻 + 下次补充时间。
  红点（mail_arrived 动态计数）即提醒；阅后/过期即焚（领取履历不存文本）。
  实现：`src/lib/scheduled-resource-notice-mail.ts` + load 结算分支。
- **已撤除**：force_news=2 主页每日公告列表 + 常驻公告行（每日列表弹窗观感过吵，
  用户裁决）。force_news 字段已从 generateDataHeaders 默认头移除。
- **结算类弹框（over_max/mission_info）明确不可用**：语义锚定（编造=虚假信息/
  成就状态污染），详见 C1/C4 与本文档附录分析。
- 备选（未采用）：force_news=1 单条模态的时点恰好覆盖「结算→主页」转换
  （canInterruptNewsTransition 不限制结算场景作出发点），若未来需要更强的
  主动触达可重启此通道。

---

## 开放问题（未证实 / 需实机验证）

1. **主页常驻玩家无任何主动触达通道**——全档案最大缺口。attention/check 轮询虽存在但响应语义被招募铃铛锁死（`data.multi` 结构校验失败即 ClientError 8702/8704/8707，client/`AttentionCheckRealRemoteService.as:60-100`），无法夹带其他动作。
2. **AssetUpdate 的 OkDialog 文案** `resource_check_error_newdate` 实际显示内容（本地化表）未核对；若语义是"资源检查错误"，挪用于"回标题完成绑定"可能观感怪异。查 UI 文本表可定。
3. **LoginTokenNotMatch / TakeOverOldAccessError 的客户端去向**（回登录页还是标题页、是否清会话）未完整追踪；若场景 2 需要强硬路径，先在测试环境实机验证。
4. **force_news 的 Int 参数值域**：`needInterruptNews` 只见 `case 1`（强插）与 `case 2`（明确不插）；值 0/None 关闭。`news/latest_forced` 的响应结构未逐一核对（client/`NewsLatestForcedRealRemote.as` 只见请求）。
5. **lounge socket**（client/`pinball/context/socket/lounge/multiSpecialExchange/`，特殊交换活动大厅）存在独立消息面，本次未展开；若未来做特殊交换活动补货提醒可再探。
6. 客户端 IOError 断线后的**自动重连**是否存在（决定服务端主动断开作为通知手段的用户观感）——SessionManager 宽限重连机制在服务端侧（multi-battle.md §10.3），客户端侧重连 UI 未追踪。

---

## 附：通道→服务端实现映射速查

| 想做什么 | 发什么 | 改哪里 |
|---------|--------|--------|
| 房间内踢回标题 | TCP 帧 `[9]`（JSON+`\0`） | server/`src/multi/tcp/lobby.ts` 或 SessionManager broadcast（apply 后调用） |
| 战斗后触发更新 | finish 响应 `data_headers.asset_update=true` | server/`src/routes/api/` quest finish + `src/utils.ts` generateDataHeaders |
| 游戏内强插公告 | 任意响应 `data_headers.force_news=1`（需在 generateDataHeaders 增加该字段）+ news/latest_forced 内容 | server/`src/utils.ts` + news 域 |
| 邮件红点 | load 响应 `data.mail_arrived` | 已实现（players_mails 动态计数） |
| 校时 | 任意响应 `data_headers.servertime` | 已实现 |
