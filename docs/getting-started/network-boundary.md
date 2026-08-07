# 网络支持边界

当前项目支持在本机或受信任的局域网中运行。游戏客户端、HTTP/CDN 服务和联机 TCP 可以位于同一设备，也可以通过局域网地址互相访问。

## 配置变量

| 变量 | 协议作用 |
|---|---|
| `CN_LISTEN_HOST` | CN HTTP 服务的绑定地址。只在本机使用时可绑定回环地址；局域网客户端需要绑定可被该网络访问的接口 |
| `CDN_BASE_URL` | 客户端接收的资源下载根 URL。`local` 模式可覆盖自动推导地址，`remote` 模式必须提供，`client-owned` 模式忽略 |
| `SESSION_HOST` | 多人联机 TCP 服务的绑定地址。局域网其他设备需要连接时，应绑定可被该网络访问的接口 |
| `SESSION_PUBLIC_HOST` | 服务端在房间响应中告知客户端的 TCP 可达主机名或地址；建议跨设备运行时显式设置 |
| `CN_PUBLIC_HOST` | `SESSION_PUBLIC_HOST` 的兼容回退，也用于部分 HTTP/CDN 公共地址推导；新配置仍推荐显式设置用途更明确的 `SESSION_PUBLIC_HOST` |
| `MULTI_MODE` | `embedded`、`host` 或 `client`。未设置时为 `embedded`，普通本机使用无需修改 |
| `MULTI_HUB_HOST` / `MULTI_HUB_PORT` | `host` 模式的可信 Hub 控制接口绑定地址与端口；默认端口语义为 `8004` |
| `MULTI_HUB_URL` | `client` 模式访问 Host 控制接口的完整 HTTP(S) 根 URL，只用于多人控制面 |
| `MULTI_HUB_TOKEN` | `client` 模式使用的节点明文令牌，只放在本机 `.env` 或壳私有运行配置中 |

绑定 `0.0.0.0` 表示监听所有本机网络接口，不等于服务端自动获得公网安全能力。`CDN_BASE_URL` 和 `SESSION_PUBLIC_HOST` 必须是客户端实际能够访问的地址，但项目不负责配置路由器、域名或外部网络。

以下多人生命周期参数属于可选高级配置，普通部署应保留默认值：

| 变量 | 默认值 | 作用 |
|---|---:|---|
| `MULTI_ROOM_INCOMPLETE_EXPIRY_MS` | `900000` | 未满 3 人房间的过期时间 |
| `MULTI_ROOM_FULL_EXPIRY_MS` | `1800000` | 满 3 人房间的过期时间 |
| `MULTI_ROOM_CLEAN_INTERVAL_MS` | `60000` | 过期房间检查间隔 |
| `NPC_JOIN_DELAY_MS` | `2000` | NPC 加入房间前的延迟 |
| `NPC_READY_DELAY_MS` | `500` | NPC 加入后进入准备状态的额外延迟 |

这些值以毫秒为单位，仅在进程启动时解析并进入只读运行配置；修改后必须重启服务。管理后台不提供在线修改入口，运行过程中不会热更新；重启后的生命周期会使用新的配置。

联机地址只按 `SESSION_PUBLIC_HOST`、`CN_PUBLIC_HOST`、`CN_LISTEN_HOST` 的顺序选择，完全不读取 HTTP 请求。前两项都未设置且 `CN_LISTEN_HOST` 是 `0.0.0.0` 或 `::` 时，服务端使用操作系统网络接口枚举中的首个非回环 IPv4，找不到时回退到 `127.0.0.1`。多网卡、VPN 或虚拟网卡环境中自动结果可能不是客户端可达地址，应显式设置 `SESSION_PUBLIC_HOST`。

## 多人 Hub 拓扑

默认 `embedded` 在同一服务进程内提供 `8001` 游戏 HTTP 与 `8003` 多人 TCP，不监听 `8004`。可选 `host` 在自己的 `8001` 之外同时提供 `8003` Hub TCP 与 `8004` Hub 控制接口；`client` 正常状态只提供自己的 `8001`，远程 Hub 不可用时才为后续新房间按需启动本地 `8003`：

```text
Host:     本地客户端 -> Host 8001 -> 本地 SQLite
          所有参与者 -----------> Host 8003
          Client 服务 ----------> Host 8004

Client:   本地客户端 -> Client 8001 -> Client 自己的 SQLite
          降级后的新房间 -----> Client 8003
```

Host 与每个 Client 都保留自己的账号、存档、active quest、体力、门票和奖励结算。只有游戏房主所属数据库扣入场成本，每名参与者的 finish 只写自己的 SQLite。Host 不复制或合并其他节点存档。

节点会严格比较客户端版本、资源版本、Content Release 摘要和 Mod 摘要。差异映射为客户端现有的 NotPlayable 或通用 Failure，不触发 `asset_update`，不下载、切换或修复另一节点的 CDN。各节点服务器时间可以不同，只要目标关卡在该节点自己的时间下处于开放期；开放期外只拒绝该成员，不删除房间。

Host 使用 `npm run multi:token -- create <label>` 生成 Client 令牌，明文只在创建时输出一次。Client 通过 `MULTI_HUB_TOKEN` 读取该令牌；`8004` 不提供密钥管理、后台、主游戏 API 或 CDN。可操作步骤见[多人 Hub 设置教程](../protocol/multi-hub-setup.md)，详细身份、撤销与错误映射见[可信多人 Hub 架构](../protocol/trusted-multi-hub.md)。

## 不提供的公网能力

服务端当前没有公网管理后台鉴权、多人 TCP TLS、Hub 公网认证模型、互联网级限流、云防护或公网安全承诺。`8001`、`8003`、`8004` 只应位于本机、受信任局域网或可信 VPN。以下工作由部署者独立负责，不属于项目支持范围：

- 将端口暴露到公网；
- 反向代理、TLS 终止和证书管理；
- 防火墙、访问控制、域名与 DNS；
- 云平台、安全组、容器网络和公网故障排查。

管理后台包含修改和删除存档等高权限操作，只应在受信任网络中使用。需要公网部署时，部署者必须自行设计和审计完整安全边界；本项目文档不提供特定代理、防火墙或证书工具教程。

仓库中的 [`deployment/`](../../deployment/README.md) 是上游遗留的兼容工具目录，仅为旧启动脚本依赖而保留，不属于 CN 受支持流程。
