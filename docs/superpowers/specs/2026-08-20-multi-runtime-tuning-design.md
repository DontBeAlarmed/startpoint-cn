# 多人运行时调优配置注入设计

状态：已获准进入设计文档阶段，尚未实施。

## 背景与目标

当前多人服务已经在 `RuntimeConfig` 中解析房间清理和 NPC 招募参数，但 TCP 会话、战斗心跳和可靠发送队列仍有模块直接读取 `process.env`。这会产生两套配置来源：启动时的运行时快照，以及模块加载时的进程环境。

本项只统一配置来源和传递边界，不改变多人协议、房间状态、战斗代次、Hub 路由、降级策略或默认端口。

## 设计

### 1. 单一配置快照

扩展现有 `MultiRuntimeTuningConfig`，新增两个冻结分组：

```text
transport
  handshakeTimeoutMs
  maxFrameBytes
  maxBufferBytes
  keepAliveInitialDelayMs
  sendQueueMaxMessages
  sendQueueMaxBytes
  sendQueueMaxAgeMs

battle
  loadingLeaseMs
  heartbeatLeaseMs
```

房间清理和 NPC 招募配置保持现有结构。所有字段在 `parseCnRuntimeConfig()` 阶段完成解析、默认值填充和边界校验；服务启动后只使用冻结对象。

### 2. 配置传递链路

```text
.env / RuntimeEnvironment
          |
          v
parseCnRuntimeConfig()
          |
          v
CnRuntimeConfig.multiTuning (冻结快照)
          |
          v
MultiRuntimeService.start(..., tuning)
          |
          +--> Session TCP server
          |      +--> 握手、帧和 keepalive
          |      +--> reliable-send 队列
          |      +--> SessionManager 战斗租约
          |
          +--> Client fallback TCP
```

`startSessionServer()` 继续保留现有显式启动选项，作为测试和低层调用的覆盖入口；生产运行时由 `MultiRuntimeService` 将快照中的值传入。模块本身不再读取环境变量。

### 3. 默认值与兼容性

保持当前默认值：

| 配置 | 默认值 |
| --- | ---: |
| `SESSION_HANDSHAKE_TIMEOUT_MS` | `15000` |
| `SESSION_MAX_FRAME_BYTES` | `262144` |
| `SESSION_MAX_BUFFER_BYTES` | `1048576` |
| `SESSION_TCP_KEEPALIVE_MS` | `10000` |
| `MULTI_SEND_QUEUE_MAX_MESSAGES` | `512` |
| `MULTI_SEND_QUEUE_MAX_BYTES` | `4194304` |
| `MULTI_SEND_QUEUE_MAX_AGE_MS` | `15000` |
| `BATTLE_LOADING_LEASE_MS` | `60000` |
| `BATTLE_HEARTBEAT_LEASE_MS` | `25000` |

显式 `startSessionServer()` 选项优先于运行时快照中的对应值，以保留现有测试和低层调用契约。未提供覆盖值时使用传入快照，而不是重新读取环境。

### 4. 校验与失败行为

- 所有时间和数量配置必须是正的安全整数。
- `maxBufferBytes` 不得小于 `maxFrameBytes`。
- 队列字节上限继续保持不低于当前安全下限 `1024`。
- 配置非法时在运行时配置解析阶段抛出现有 `INVALID_RUNTIME_CONFIG`，服务不启动。
- 运行中的服务不动态读取 `.env`，修改配置需要按现有流程重启服务。

### 5. 责任边界

- `RuntimeConfig` 负责解析、默认值和跨字段校验。
- `MultiRuntimeService` 负责把快照传给实际启动路径，包括 Client 的本地 fallback TCP。
- TCP server 负责将启动选项规范化并应用到当前 server generation。
- `SessionManager` 只负责使用已注入的战斗租约配置。
- `reliable-send` 只负责使用已注入的队列限制，不知道 `.env` 或后台配置来源。
- 壳和后台后续只能读取公开的运行时配置投影，不直接修改上述模块状态。

## 验证范围

1. 配置解析覆盖默认值、合法覆盖、非法值、帧/缓冲区关系和冻结属性。
2. 运行时服务把完整快照传入 Host、Embedded 和 Client fallback TCP。
3. TCP server 不再直接读取 `process.env`。
4. SessionManager 的 loading/active 租约继续保持现有行为，只改变配置来源。
5. reliable-send 的队列上限和背压超时继续保持现有行为，只改变配置来源。
6. 多人 lobby、battle heartbeat、relay、Hub control、remote settlement 回归保持通过。
7. 类型检查、构建、文档检查和卫生检查通过。

## 明确不做

- 不新增后台管理页面或账号鉴权。
- 不允许运行中动态修改网络端口、Hub 地址或客户端资源。
- 不调整 25 秒 lobby 重连宽限、房间解散、战斗重连或自动降级语义。
- 不把配置快照写入玩家存档或跨服同步。
