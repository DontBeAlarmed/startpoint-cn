# 管理后台

本文描述当前管理后台的运行边界。后台用于管理本地服务状态，不属于游戏客户端协议，也不是游戏服务启动的必需组件。

## 两套界面

服务端暂时保留两套管理界面：

- 新后台源码位于 `admin/`，使用 React、TypeScript、Vite、Ant Design 和 React Query；
- 兼容旧后台由 `src/routes/web/` 和 `web/pages/` 提供，入口仍为 `/`、`/player`、`/mail` 和 `/seeds`。

新后台构建到 `web/dist/`。服务端发现 `web/dist/index.html` 后在 `/admin/` 挂载静态产物，并为 `/admin/*` 客户端路由回退到同一个入口文件；访问 `/admin` 会跳转到 `/admin/`。没有构建产物时，新后台不可用，但游戏 HTTP、联机 TCP、旧后台和健康检查仍可正常启动。

## Web API

两套界面共享 `src/routes/web_api/` 提供的 JSON 或兼容表单接口，统一挂载在 `/api`：

- `/api/server`：运行状态、服务器时间、账号、存档和默认存档；
- `/api/server/settings/gameplay`：读取和调整持久化的运行时游戏设置；
- `/api/player`：玩家详情、资源、角色、道具、关卡和重置操作；
- `/api/mail`：定向邮件发送与发送历史；
- `/api/lookup`：角色、道具、装备和关卡查询；
- `/api/seeds`：抽卡动画种子状态与管理。

新后台请求携带 `Accept: application/json`。迁移期内，部分旧表单仍调用相同业务入口并接收重定向响应；新增后台功能应优先提供明确的 JSON 请求和响应，不在 React 页面中直接访问 SQLite。

## 构建边界

服务端构建和后台构建彼此独立：

```bash
npm run install:admin
npm run build:admin
```

只有首次安装或 `admin/package-lock.json` 变化时需要执行 `install:admin`。`build:server` 不隐式安装或构建后台，`build:admin` 也不启动 CN 服务端。Vite 开发服务器只用于前端开发，通过代理访问已经运行的服务端；正式测试 `/admin/` 时应使用 `web/dist/` 中的构建产物。

Server Bundle 会在 `web/dist/index.html` 存在时打包完整后台产物；不存在时合法省略，manifest 中的 `admin.required` 当前为 `false`。运行时 `/healthz` 的 `admin.available` 只表示产物是否可挂载，不表示页面功能已经通过人工验收。

## 当前页面与验收边界

新后台目前包含总览、时间与千里眼、账号与存档、玩家详情、邮件、种子管理和游戏设置页面。源码级测试覆盖部分 API 契约、表单规则和页面接线，服务端与后台也可分别构建；尚未建立完整的浏览器交互、响应式设备和破坏性操作回归。

## 运行时游戏设置

数据库 schema 8 增加单例表 `server_gameplay_settings`。这类设置属于运行中的游戏规则，不属于进程监听、文件目录或 CDN 拓扑，因此由管理后台持久化，保存后无需重启服务。

当前仅开放“关卡固定掉落倍率”，允许 `1～10` 的整数，默认值为 `1`。它只影响关卡固定道具、玛纳、经验、属性素材和以太素材的数量，不改变稀有掉落池的命中概率或奖励数量。一次结算只读取一次当前倍率，后台保存的新值从之后发生的结算开始生效。

为兼容旧部署，创建该单例行时会读取一次旧环境变量 `DROP_MULTIPLIER`；未设置时写入 `1`。单例行存在后数据库即为唯一权威，后续启动不会再用环境变量覆盖或校验已有值。完成首次升级启动后可以从本地 `.env` 删除该变量，新部署的 `.env.example` 不再提供它。

`ASSET_MODE`、CDN/数据目录、HTTP/TCP 监听地址和端口等启动边界仍由环境变量或 Supervisor 控制。后台最多只读展示这类状态，不提供在线修改，避免运行中的进程写回部署配置。

因此：

- 自动测试通过不等于新后台已经完成人工验收；
- 修改存档、删除账号、批量邮件等操作应使用测试数据验证；
- 旧后台仍是兼容入口，不应在没有迁移清单和回归证据时删除；
- 当前验收状态统一记录在[支持矩阵](../status/support-matrix.md)和[测试进度](../status/test-progress.md)。

嵌入式打包规则见[Server Bundle](../runtime/server-bundle.md)。
