# 随机招募与 NPC 回退设计

> 当前状态：设计已确认，代码尚未实施。

本文定义多人房间的真人随机招募、NPC 回退和后台设置边界。目标是补齐国服客户端已经存在的随机招募服务端协议，同时保留当前服务端使用 NPC 保障单人体验的能力。

## 1. 设计结论

NPC 模式和 NPC 等待时长是两个独立配置：

| 配置 | 作用 | 默认行为 |
|---|---|---|
| `npc_mode_enabled` | 是否启用当前 NPC 优先流程 | `true`，保持旧部署体验 |
| `summon_com_seconds` | 官方真人招募开始后，客户端等待多久再请求 NPC | 默认 120 秒（2 分钟） |

`npc_mode_enabled` 不使用 `0` 表示关闭。它是布尔开关：

- `true`：服务端不建立真人招募队列，`summon` 按当前实现返回 NPC；`attention/check` 不返回本服真人招募请求。
- `false`：服务端启用官方真人随机招募；真人不足时，客户端等待默认 120 秒后按照 `summon_com_seconds` 请求 `summon`，服务端只补足剩余空位的 NPC。

`summon_com_seconds` 只影响客户端何时请求 `multi_battle_quest/summon`，不负责切换 NPC 模式。首期后台默认值为 `120` 秒，适用于关闭 NPC 优先模式后的真人招募等待；NPC 模式开启时仍保持当前 NPC 优先体验。TCP 中的 NPC 加入消息延迟和 ready 消息延迟仍是内部协议时序，不与该设置混用。

首期只实现同一服务端内的真人随机招募。跨 Hub、跨服的随机招募另行设计，不把跨节点房间发现混入本功能。

## 2. 国服客户端证据

CN 1.8.1 反编译源码已经包含完整的客户端招募链路：

1. 房主选择随机招募后，`MultiBattleRoomScene.shareRequestAPI()` 调用 `multi_battle_quest/share_room`，请求字段包含：

   ```json
   {
     "category": 19,
     "quest_id": 500009002,
     "room_number": "126523",
     "share_type_list": [3]
   }
   ```

2. `AttentionRecruitmentRedeliverTimer` 首次立即发送招募，之后按照 `attention_recruitment_interval_seconds` 重复发送；当前客户端配置为 15 秒，最多 20 次。房间满员或进入 NPC 回退后停止重发。

3. 其他玩家在普通场景或战斗场景按客户端配置轮询 `/attention/check`。当前配置为普通场景 10 秒、战斗场景 15 秒，请求携带 `holding_number` 和 `request_number=3`。

4. `/attention/check` 成功响应中的 `data.multi` 是招募通知列表。每项至少包含：

   ```json
   {
     "attention_key": "...",
     "quest_info": {
       "category_id": 19,
       "quest_id": 500009002,
       "room_number": "126523",
       "establisher_character": 151165,
       "establisher_character_evolution_img_level": 1,
       "establisher_follow": 0,
       "establisher_rank": 138,
       "host_entry_time": 1719622252,
       "is_newbie": false
     }
   }
   ```

5. 其他玩家接受通知后，客户端根据 `room_number` 进入对应房间。成功进入后，房主继续接收成员变化，真人成员占用房间空位。

6. 房主开始随机招募后，客户端在 `summon_com_seconds` 到期且房间仍未满时请求 `multi_battle_quest/summon`。本项目首期将该值设置为 120 秒。若返回有效 NPC，客户端再通过 TCP `EnterComs` 将 NPC 加入房间；若没有有效 NPC，则停止本轮 NPC 尝试并继续随机招募。

因此，官方客户端的“随机招募”和“NPC 回退”已经是两段流程。服务端不能只延长当前 TCP NPC 消息的延迟来实现真人招募。

主要参考文件：

- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/scene/bossBattle/room/MultiBattleRoomScene.as`
- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/context/attention/AttentionRecruitmentRedeliverTimer.as`
- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/remote/attention/check/AttentionCheckRealRemoteService.as`
- `<PROJECT_ROOT>/wf-1.8.1-cn-decompiled/scripts/pinball/context/attention/AttentionSystemLogic.as`

## 3. 当前服务端缺口

当前实现已经具备房间、TCP、NPC 模板和 `EnterComs` 处理，但缺少真人招募服务：

| 位置 | 当前行为 | 需要调整 |
|---|---|---|
| `multi_battle_quest/share_room` | 返回空对象，不保存请求 | 启用 NPC 关闭时创建或刷新招募请求 |
| `/attention/check` | 只返回配置，没有 `data.multi` | 按玩家可加入条件返回有效招募通知 |
| `/attention/action` | 只返回优先级分数 | 首期不作为匹配入口，保留统计语义 |
| `multi_battle_quest/get_rooms` | 当前只返回请求玩家自己的房间 | 不把它改造成 Attention 随机招募入口 |
| `multi_battle_quest/summon` | 返回固定 NPC | 按当前真实真人数量只补足剩余 NPC 槽位 |
| TCP lobby | `EnterComs` 后直接绑定 NPC roster | 保留作为客户端 NPC 回退的最终接入点 |

## 4. 首期服务端状态机

真人招募请求只属于进程内房间，不写入玩家存档和业务数据库。当前房间本身也是进程内状态，因此服务重启后请求自然失效；客户端可以重新创建房间。

```text
Idle
  -> share_room
Recruiting
  -> 真人接受并进入房间
Recruiting
  -> 房间满员 -> Closed
Recruiting
  -> summon_com_seconds 到期 -> NPC fallback
NPC fallback
  -> summon 返回 NPC -> EnterComs -> Closed
NPC fallback
  -> 真人同时进入 -> 只补剩余 NPC -> Closed
Recruiting / NPC fallback
  -> 房主离开、解散或房间过期 -> Closed
```

招募请求至少需要保存：

- `room_number`、category、quest ID；
- 房主 viewer ID 和创建时间；
- 当前有效招募次数和最后发布时间；
- Attention key 和过期时间；
- 房间当前真人成员数；
- 请求状态和关闭原因。

同一房间的重复 `share_room` 必须幂等刷新已有请求，不能产生多个通知。房间满员、房主离开、解散、NPC 回退或房间过期后，旧 Attention key 必须失效。

真人加入和 NPC 补位必须在同一房间状态锁内完成判断：

- 真人先占位时，NPC 只能补剩余槽位；
- NPC 回退先完成时，后续真人仍可替换 NPC，但不得超过三名真人/成员上限；
- 过期通知、重复接受和断线重连不能重复占用槽位；
- 不同房间可以使用相同 quest，但不能共享招募状态。

## 5. 后台设置

`npc_mode_enabled` 和 `summon_com_seconds` 属于运行中的游戏体验设置，进入 `server_gameplay_settings`，由新管理后台修改。环境变量只作为旧部署首次初始化时的兼容输入，单例设置存在后由数据库值作为权威。

后台需要显示：

- NPC 模式开关；
- 当前 NPC 回退等待秒数；
- 保存成功或失败反馈；
- 当前生效值，无需重启服务。

后台不提供招募请求的手工修改入口。招募请求只由游戏协议创建和关闭，避免后台状态与进程内房间状态分离。

## 6. 不属于首期范围

- 跨 Hub、跨服务端随机招募；
- 公网匹配服务器或全局玩家大厅；
- 持久化招募队列；
- 修改客户端 Attention UI 或招募倒计时；
- `attention/action` 优先级算法的官方复原；
- NPC 模板、NPC 名称池和 NPC 战斗 AI 的重新设计；
- 真实玩家匹配的评分、推荐和反作弊策略。

## 7. 验证范围

服务端自动测试需要覆盖：

- NPC 模式打开时维持现有 NPC 流程；
- NPC 模式关闭时 `share_room` 创建、刷新和关闭招募请求；
- `/attention/check` 返回字段与 CN 客户端契约一致；
- 自己的房间不出现在自己的 Attention 列表；
- 多个房间、多个请求和相同 quest 不互相污染；
- 真人先加入、NPC 先补位、同时到达三种竞争顺序；
- 重复接受、房间满员、房主离开、房间解散和过期清理；
- `summon` 只补足剩余空位，不覆盖真人成员；
- 后台设置保存后立即影响后续房间；
- Hub/本地房间现有流程不回归。

客户端人工验收仍需要确认：

- 招募通知是否出现；
- 接受通知后是否进入正确房间；
- 真人加入后房主页面是否立即刷新；
- 等待时间到期后 NPC 是否正常加入；
- 重复招募、断线和重赛时 UI 是否符合预期。
