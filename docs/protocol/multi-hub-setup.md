# 可信多人 Hub 设置教程

本文面向希望让两台或多台独立 `starpoint-cn` 服务端共同联机的服主。Hub 只支持受信任局域网或 VPN；各服务端继续保存自己的账号、SQLite、体力、门票、奖励和任务进度。

默认 `MULTI_MODE=embedded` 不需要本教程。只有确认需要跨服务端联机时，才把一个节点设为 `host`，其余节点设为 `client`。

## 端口与路径

```text
A（Host）本地玩家：客户端 HTTP -> A:8001，游戏 TCP -> A:8003
B（Client）远程联机：客户端 HTTP -> B:8001 -> A:8004，游戏 TCP -> A:8003
B 降级后的新房间：客户端 HTTP -> B:8001，游戏 TCP -> B:8003
```

`8004` 只承载服务端之间的房间控制，不代理游戏 TCP、主游戏 API、CDN、后台或存档。A 本地玩家不经过 A 的 `8004`。

## 配置 Host

在 A 的 `.env` 中设置：

```dotenv
MULTI_MODE="host"
SESSION_HOST="0.0.0.0"
SESSION_PORT="8003"
SESSION_PUBLIC_HOST="<A 的局域网或 VPN 可达地址>"
MULTI_HUB_HOST="0.0.0.0"
MULTI_HUB_PORT="8004"
```

`SESSION_PUBLIC_HOST` 是游戏客户端实际连接的地址，不能填写 `0.0.0.0`。启动 A 后生成一条只发给 B 的令牌：

```bash
npm run multi:token -- create "B 服务器"
```

命令会把凭据写入 A 的私有运行数据，并只显示一次明文令牌。若命令询问是否把令牌写入当前 `.env`，纯 Host 可以选择不写；把明文令牌通过可信渠道交给 B 即可。

查看和撤销凭据：

```bash
npm run multi:token -- list
npm run multi:token -- revoke <credentialId>
```

每个 Client 建议使用独立令牌。撤销某条凭据不会影响使用其他凭据的节点。

## 配置 Client

在 B 的 `.env` 中设置：

```dotenv
MULTI_MODE="client"
MULTI_HUB_URL="http://<A 的局域网或 VPN 地址>:8004"
MULTI_HUB_TOKEN="<A 为 B 生成的令牌>"
```

如果 B 只服务同机游戏客户端，不设置本地 TCP 变量时，降级路径默认使用 `127.0.0.1:8003`。如果 B 本身也是供其他设备连接的多人服务器，还应设置：

```dotenv
SESSION_HOST="0.0.0.0"
SESSION_PORT="8003"
SESSION_PUBLIC_HOST="<B 的局域网或 VPN 可达地址>"
```

B 正常启动时不会立即监听本地 fallback TCP。只有新多人操作确认 A 的 Hub 不可用后，B 才按需启动自己的 TCP；A 恢复后，后续新房间重新优先使用 A。

## 自动降级边界

- 已经属于 A 的房间、战斗和 active quest 始终保持 `remote`，不会迁移到 B。
- A 不可用后，B 只让后续新房间使用自己的本地协调器和 TCP。
- A 恢复后，B 已有本地房间继续留在 B；后续新房间恢复使用 A。
- 远程写请求已经发出但响应丢失时，不会把同一请求重试到本地。
- `load` 遇到网络不可用会保留 active quest；只有 Hub 明确报告房间不存在时才清理。
- Hub 不会同步或修改另一节点的 CDN、Content Release、Mod 或服务器时间。

## 管理接口

运行中的服务提供以下管理动作。当前不内置后台账号、权限或公网鉴权；这些接口可以通过远程后台调用，服主负责限制 `8001` 的可达范围并自行提供访问控制：

```text
GET    /api/server/multiplayer/credentials
POST   /api/server/multiplayer/credentials
DELETE /api/server/multiplayer/credentials/:credentialId
GET    /api/server/multiplayer/authentication-rejections
POST   /api/server/multiplayer/probe
PUT    /api/server/time-package
```

`GET /api/server/time-package` 可导出三字段时间包；导入只修改全局服务器时间，不修改任务周期、商店购买、奖励或玩家存档。Launcher 和后台应调用这些服务接口，不得直接编辑凭据表、`server-time.json`、房间状态或 SQLite。`8004` 仍然只承载 Hub 控制协议，不承载这些管理接口。

## 排查顺序

1. 确认 A 的 `8003` 和 `8004` 对 B 所在的受信网络可达。
2. 确认 B 的 `MULTI_HUB_URL` 是完整根 URL，令牌来自 A 且未撤销。
3. 在 B 本机调用 Hub probe，区分远程可用、降级和不可用状态。
4. 跨服务端加入失败时，检查双方 `APP_VER`、`RES_VER`、Content 与 Mod 摘要差异；服务端只输出差异，不自动更新资源。
5. 若 B 已降级且外部玩家无法连接，检查 B 的 `SESSION_PUBLIC_HOST` 是否是玩家可达地址。

安全、身份、兼容性和失败恢复的完整依据见[可信局域网多人 Hub 架构](./trusted-multi-hub.md)。
