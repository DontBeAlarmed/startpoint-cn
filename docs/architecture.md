# StarPoint CN 当前运行时架构

本文描述 `dev` 分支当前有效的服务端结构和运行边界。业务路由覆盖见[参考资料](./reference/README.md)，功能完成度见[状态文档](./status/README.md)。

## 1. 系统边界

StarPoint CN 连接官方 CN 1.8.1 客户端与官方 CN 1.4.54 CDN。服务端负责协议适配、玩家状态、业务规则、内容表读取、资源归档供给和多人会话；客户端渲染与战斗执行、CDN 制作和 APK 封装不属于服务端职责。

主要技术栈为 Node.js、TypeScript、Fastify、SQLite（`better-sqlite3`）和 `msgpackr`。TypeScript 使用 CommonJS，源码位于 `src/`，构建产物位于 `out/`。

```text
local CDN -> Content Sync -> Content Release -> Content snapshot -> 业务模块
     |                                                        |
     +--------------------- 资源归档 -------------------------> CN 客户端
remote CDN --------------------------------------------------> CN 客户端

CN 客户端 -> HTTP API -> 业务规则 -> SQLite 玩家状态
CN 客户端 -> TCP 会话 -> 进程内房间与联机状态机
管理后台 -> Web API -> 业务规则 -> SQLite 玩家状态
嵌入式宿主 -> 进程、数据目录与健康检查契约
```

## 2. 启动链

受支持的前台入口是 `bash scripts/start-cn.sh`：

1. 根 `build` 与启动脚本统一进入 `build:server`，先构建并校验 React 管理后台，再编译 CN 服务端入口及其依赖。
2. bootstrap 读取 `ASSET_MODE`。
3. `local` 模式先执行 `content:sync`，成功后启动 `out/cn-server.js`；同步失败则不启动。
4. `remote` 和 `client-owned` 模式跳过本地 `content:sync`，直接启动 `out/cn-server.js`。
5. 运行时解析配置并初始化 SQLite。
6. 按资源模式加载本次进程固定使用的 Content snapshot。
7. Fastify 完成路由注册并监听 HTTP。
8. 联机 TCP 会话服务启动，运行时进入 `ready`。

SIGINT 或 SIGTERM 会进入统一关闭流程：停止接收 HTTP、停止 TCP、checkpoint SQLite 并关闭数据库。`node out/cn-server.js` 是不执行内容同步的低级入口，只用于明确知道当前 Release 已准备好的调试场景。

## 3. 网络协议

### 3.1 HTTP API

游戏主 API 通常挂载在 `/api/index.php/`。请求体采用 `base64(msgpack(object))`，常见请求 Content-Type 为 `application/x-www-form-urlencoded`；Fastify parser 先解 Base64，再由 `msgpackr` 解码。响应对象经 onSend hook 编码为 MsgPack 和 Base64，并返回 `application/x-msgpack`。

CN 客户端不能正确处理部分 `uint32` 标记，响应层会把安全范围内的 MsgPack `0xCE` 标记改写为等长的 `int32` 标记 `0xD2`。端点不得绕过统一响应管线自行拼接近似格式。

版本检查、CDN 资源、漫画图片、健康检查和后台页面不使用游戏主 API 的 MsgPack 包装；具体格式由各自路由定义。普通开发的漫画图片默认来自 `web/public/comic/`，嵌入模式由绝对 `COMIC_DIR` 显式挂载，并统一通过 `/api/index.php/comic/image` 业务接口读取；不存在通用 `/public` 静态挂载。

### 3.2 TCP 联机

多人会话使用独立 TCP 服务和 Flash XMLSocket 风格的空字符分帧。消息载荷是 Typepacker 枚举数组 `[index, params...]`，不是 HTTP 使用的 MsgPack，也不是带枚举字段的普通 JSON 对象。

房间、NPC 队友、状态机和 TCP 会话分别位于 `src/multi/room/`、`src/multi/npc/`、`src/multi/state/` 和 `src/multi/tcp/`。房间表、TCP 连接和联机状态机都保存在进程内存中，不写入 SQLite；服务重启后现有房间与会话不会恢复。协议细节见[多人联机文档](./protocol/multi-battle.md)。

## 4. Content Runtime

`src/content/` 将 CDN 读取与业务代码隔开：

- `sync/` 扫描受支持输入、生成或复用 Content Release；
- `converters/` 把 CDN 源表转换为服务端运行表；
- `cdn/` 建立归档 Catalog、版本图和下载计划；
- `runtime/` 加载并冻结当前 Content snapshot；
- `startup/` 保证本地资源模式先同步、后启动。

同一进程中的资产版本、下载清单和业务表来自同一 snapshot，不在请求期间重新扫描 CDN。当前转换器只覆盖已接入的表，其余 `assets/` 数据仍作为版本内置数据使用。职责与支持边界见[CDN 与内容索引](./cdn/README.md)。

## 5. SQLite 状态

`src/data/db.ts` 管理共享 SQLite 实例，schema 初始化和迁移位于 `initializers/`、`updaters/`。`src/data/domains/` 的 22 个领域模块负责账号、玩家、角色、装备、道具、任务、关卡、商店、邮件、活动和认证会话等持久状态。这里的认证会话不包括多人房间、TCP 连接或联机状态机。

路由应通过领域 API 完成读取和事务写入。`wdfpData.ts` 仅保留为兼容导出层，不是新增业务的归属位置。序列化工具把数据库实体转换为客户端需要的完整玩家快照。

设备绑定以 `device_id` 关联账号；运行时没有全局活动账号。时间统一使用服务器 `timeOffset`，存档中的 `time_offset` 只为数据库兼容保留。

## 6. 业务模块

HTTP 路由分为三组：

- `src/routes/cn/`：雷霆登录、CN load、版本检查、CDN 与 MsgPack 适配；
- `src/routes/api/`：角色、装备、抽卡、关卡、任务、商店、邮件等业务端点；
- `src/routes/web_api/`：管理后台使用的结构化管理接口。

复杂规则下沉到 `src/lib/`。任务位于 `src/lib/mission/`，关卡结算位于 `src/lib/quest/finish/`，抽卡、体力、装备和校验各有独立模块。路由负责协议边界和事务编排，不应重复实现业务计算。

## 7. 管理后台

React 后台是唯一管理界面，由 `admin/` 构建到 `web/dist/`，在 `/admin/` 提供静态资源和客户端路由。`/` 与旧管理路径只做兼容重定向，不再存在服务器渲染的旧 HTML。

后台通过 `src/routes/web_api/` 或既有领域 API 操作同一 SQLite 状态。`web/dist/index.html` 是构建、运行时初始化和 Server Bundle 的共同硬前置；缺失时构建或启动失败。SPA fallback 只处理 `/admin/*` 中不带扩展名且接受 HTML 的 GET 客户端路由；`/admin/assets/*`、带扩展名路径、游戏 API、管理 API 和 `/healthz` 均不进入 fallback。

页面范围、构建边界和当前验收限制见[管理后台](./admin/README.md)。

## 8. 嵌入式运行契约

Android 启动器、桌面壳、容器和 Supervisor 通过稳定的外部契约托管服务端，而不是依赖仓库内部路径：

- Server Bundle 提供可验证的服务端文件集合；
- Data Volume 保存数据库、Content Store 和可变运行数据；
- 环境变量提供监听、资源和数据目录配置；
- 健康检查暴露进程阶段、数据库、内容、HTTP、TCP 和后台状态；
- 退出信号触发有序关闭，启动阶段使用稳定退出码。

完整约束从[运行时与宿主集成](./runtime/README.md)进入，核心文档为[嵌入式运行契约](./embedded-runtime-contract.md)和[Server Bundle](./runtime/server-bundle.md)。这些契约约束宿主与服务端的边界，不改变游戏客户端协议。

## 9. 维护原则

- 协议字段以 CN 1.8.1 客户端反编译和实际请求为依据，不猜测字段。
- 当前行为写入 architecture、systems、protocol、cdn 或 runtime；原始样本写入 reference；完成度写入 status。
- 业务状态写入 SQLite，内容定义来自固定 snapshot，二者不得在请求中隐式互换。
- 每个功能模块完成后运行对应测试和类型检查，并同步更新其权威文档。
