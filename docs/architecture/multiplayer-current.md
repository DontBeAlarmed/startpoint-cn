# 多人联机与 Hub 当前架构

本文只描述当前 `embedded`、`host` 和 `client` 实现，不表达未来公网联邦、横向扩展或跨进程房间恢复。协议字段见[多人联机协议](../protocol/multi-battle.md)，部署与故障边界见[可信多人 Hub](../protocol/trusted-multi-hub.md)。

## D10 当前多人联机与 Hub 拓扑

```mermaid
flowchart LR
    HC["Host 节点玩家客户端"]
    CC["Client 节点玩家客户端"]
    ADMIN["本机管理后台"]

    subgraph HOST["Host 服务节点（同一 Node.js 进程）"]
        HH["游戏 / 管理 HTTP :8001<br/>MultiHttpContext"]
        HE["EmbeddedMultiCoordinator"]
        HA["AdmissionRegistry<br/>成员占用 + 待入场席位"]
        HUB["Hub Control :8004<br/>JSON 控制面"]
        HT["房间权威 TCP :8003<br/>Room / Session / BattleFact"]
        HDB[("Host SQLite<br/>所属玩家状态")]
    end

    subgraph CLIENT["Client 服务节点"]
        CH["游戏 / 管理 HTTP :8001<br/>MultiHttpContext"]
        CR["Routed + Remote Coordinator<br/>HubClient"]
        CF["ClientFallbackController<br/>本地 Coordinator + 按需 TCP :8003"]
        CDB[("Client SQLite<br/>所属玩家状态")]
    end

    HC -->|"多人 HTTP<br/>Base64(MsgPack)"| HH
    HH --> HE
    HE --> HA
    HH -->|"本地 /start、/finish 事务"| HDB

    CC -->|"多人 HTTP<br/>Base64(MsgPack)"| CH
    ADMIN -->|"状态 / 诊断 / probe<br/>只经所属节点 :8001"| HH
    ADMIN -->|"状态 / 诊断 / probe<br/>不经 Hub :8004"| CH
    CH --> CR
    CR -->|"远程房间控制 JSON"| HUB
    HUB --> HE
    HUB --> HA
    CH -->|"本地 /start、/finish 事务"| CDB

    HE -->|"房间与战斗事实"| HT
    HC -->|"NUL + Typepacker array"| HT
    CC -->|"远程房间的 TCP endpoint"| HT

    CR -->|"新房间探测失败"| CF
    CC -->|"之后新建的降级房间<br/>直连本地 TCP"| CF
```

Host 的 HTTP 8001、多人 TCP 8003 和 Hub Control 8004 是同一个 Node.js 服务进程中的不同监听边界。基础设施 Host 不等于游戏房主；Client 节点玩家也可以在 Host 权威房间中主持战斗。每个节点只读写自己的 SQLite，Hub 不复制玩家存档，也不代理主游戏 API、CDN 或后台。

Client 的本地降级只选择之后新建房间的 Coordinator 和 TCP；已经存在的远程房间及其 active quest 不随探测结果迁移。管理状态、诊断与 probe 始终通过所属节点 8001，不通过 Hub Control 8004。

| 事实 | 证据 |
|---|---|
| Host 装配 Embedded Coordinator、TCP 和 Hub Control | `src/multi/runtime/service.ts` |
| Client 使用 Routed/Remote Coordinator，失败时按需启动本地路径 | `src/multi/runtime/service.ts`、`src/multi/runtime/client-fallback.ts` |
| 房间响应下发实际 TCP endpoint | `src/multi/room/serializer.ts` |
| 两个节点各自持有玩家快照、active quest 和结算 | `src/multi/player-context.ts`、`src/multi/http/battle.ts` |
| 管理接口只注册在本机游戏 HTTP | `src/routes/web_api/index.ts` |

本图不表达公开房间列表、真人随机匹配、跨 Hub 房间发现、TLS/NAT 穿透、外置 Coordinator 或消息队列。

## D11a 当前多人建房与开战时序

```mermaid
sequenceDiagram
    participant B as Client 节点玩家（游戏房主）
    participant BS as Client HTTP + SQLite
    participant R as Routed / Remote Coordinator
    participant H as Host Hub / Embedded Coordinator
    participant A as Host 节点玩家
    participant AS as Host HTTP + SQLite
    participant T as 房间权威 TCP / SessionManager
    participant F as BattleFactStore

    B->>BS: create_room [HTTP Base64(MsgPack)]<br/>本地玩家/配队快照
    BS->>R: 创建远程房间
    R->>H: JSON Hub 控制调用
    H-->>R: roomNumber + Host TCP endpoint
    R-->>BS: 远程房间结果
    BS-->>B: roomNumber + Host TCP endpoint
    Note over B,H: 基础设施 Host 与游戏房主分离；本例由 Client 节点玩家主持

    A->>AS: select_room [HTTP Base64(MsgPack)]<br/>按六位房号加入
    AS->>H: 写入本地 admission
    H-->>AS: Host TCP endpoint
    AS-->>A: 房间结果
    B->>T: 握手 [TCP NUL + Typepacker array]<br/>消费远程 admission
    A->>T: 握手 [TCP NUL + Typepacker array]<br/>消费本地 admission
    T-->>B: Mates / Ready / NPC
    T-->>A: Mates / Ready / NPC
    Note over B,T: 后续 Lobby / Battle 消息沿用 TCP Typepacker 协议

    B->>T: StartBattle
    T->>F: 冻结真人参与者并创建 battleSessionId
    B->>BS: /start [HTTP Base64(MsgPack)]<br/>游戏房主扣入场成本
    BS->>BS: 本地事务写 active quest
    A->>AS: /start [HTTP Base64(MsgPack)]<br/>参与者不重复扣房主成本
    AS->>AS: 本地事务写 active quest
    Note over B,A: 客户端执行战斗；双方连接权威 Battle TCP 完成 SceneReady 和消息中继
    T->>F: 记录逐玩家 TCP Finalize
    Note over A,T: Lobby 断线默认保留短暂重连宽限；明确 Bye 立即离开
```

当前没有公开大厅；房间发现只表达六位房号或 access token。所属服务生成最小玩家与配队快照，Host 通过权威 `AdmissionRegistry` 预留真人席位并约束一次性 TCP 握手。房间最多 3 名真人，待入场 admission 与已登记成员共同计数；失败、过期、节点撤销和房间解散都会释放预留。双方分别向自己的服务调用 `/start`，只有游戏房主所属节点扣除房主入场成本。

| 事实 | 证据 |
|---|---|
| 房间创建、房号选择和 admission | `src/multi/http/lobby.ts`、`src/multi/http/room-admission.ts`、`src/multi/admission/registry.ts` |
| TCP 握手消费 admission 并建立复合身份 | `src/multi/tcp/handshake.ts` |
| StartBattle 冻结参与者并创建 battle session | `src/multi/tcp/lobby.ts`、`src/multi/settlement/facts.ts` |
| Battle TCP 负责 SceneReady、中继和 Finalize | `src/multi/tcp/battle.ts` |

本图不表达 `/finish` 结算授权、公开房间列表、真人随机匹配，也不展开全部 NPC 和双场景消息。

## D11b 当前所属节点结算授权

```mermaid
sequenceDiagram
    participant P as 所属节点玩家
    participant S as 所属 HTTP + SQLite
    participant V as SettlementVerifier
    participant R as Routed / Remote Coordinator
    participant H as Host Hub / Embedded Coordinator
    participant F as BattleFactStore
    participant T as 房间 / SessionManager

    P->>S: /finish [HTTP Base64(MsgPack)]
    S->>V: 事务外 verify
    alt active quest 来源为 local
        V->>H: getBattleStatus
        H->>F: 校验 battleSessionId / participant / TCP Finalize
        F-->>H: retained fact 或拒绝原因
        H-->>V: 本地验证结果
    else active quest 来源为 remote
        V->>R: getBattleStatus
        R->>H: JSON Hub 控制调用
        H->>F: 校验 battleSessionId / participant / TCP Finalize
        F-->>H: retained fact 或拒绝原因
        H-->>R: 远程验证结果
        R-->>V: 验证结果
    end

    alt 事实不存在、身份不符或尚未 Finalize
        V-->>S: 拒绝结算
        S-->>P: 错误响应；本地零写入
    else retained fact 有效
        V-->>S: 验证成功
        alt active quest 来源为 local
            S->>H: finalizeBattle
            H->>F: 再次复核该参与者 TCP Finalize
            F-->>H: finalized 或拒绝
            H-->>S: 本地复核结果
        else active quest 来源为 remote
            S->>R: finalizeBattle
            R->>H: JSON Hub 控制调用
            H->>F: 再次复核该参与者 TCP Finalize
            F-->>H: finalized 或拒绝
            H-->>R: 远程复核结果
            R-->>S: 复核结果
        end

        alt finalizeBattle 不可用
            S-->>P: 错误响应；本地零写入
        else 授权成功
            H->>T: 全员完成时释放 BattleFact<br/>房间恢复 Ready / 重赛状态
            S->>S: 单个本地 SQLite 事务<br/>奖励、任务、进度、消费 active quest
            alt 本地事务失败
                S->>S: 整体回滚，保留 active quest 可重试
                S-->>P: 错误响应
            else 提交成功
                S-->>P: 本地结算响应
            end
        end
    end

    Note over P,H: 每名真人都重复该流程，并始终回自己的所属服务节点结算
    Note over S,T: 进程重启不恢复房间/TCP/BattleFact；重新 load 时中止不可恢复多人 active quest 并退款
```

`SettlementVerifier` 和 `finalizeBattle` 都发生在本地 SQLite 写事务之前。验证或复核失败时所属节点零写入；本地事务失败时奖励、任务、进度和 active quest 消费整体回滚。Hub 只保存和验证房间/战斗事实，不发放玩家奖励。

| 事实 | 证据 |
|---|---|
| active quest 保存 local/remote Coordinator 来源 | `src/multi/coordinator/router.ts`、`src/lib/quest/active-quest-service.ts` |
| `/finish` 先验证和复核，再进入本地 SQLite 事务 | `src/multi/settlement/orchestrator.ts` |
| 全员完成时释放事实并恢复房间 | `src/multi/coordinator/embedded.ts` |

本图不表示房间、TCP 或 BattleFact 能跨进程重启恢复，也不展开全部 TCP 枚举、NPC 行为和双场景消息。
