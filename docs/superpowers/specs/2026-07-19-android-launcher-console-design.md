# Android 启动器与控制台 APK 设计

> 日期：2026-07-19
> 状态：仅完成分析，尚未实现
> 范围：Android 壳定位、服务端运行管理、CDN 管理、客户端补丁与启动、配置联动
> 不包含：ADB 代理拦截、root 静默安装、完整服务端移植实现计划、UI 视觉稿

## 结论

Android 壳应定位为 **World Flipper CN 启动器/控制台 APK**，而不是单纯的“服务端 APK”，也不是单纯的 `starview` 图形界面。

它的职责是统一管理本地私服运行体验：

1. 启动、停止和配置服务端。
2. 管理 CDN、数据库、日志和后台管理入口。
3. 生成、安装和启动 patched 游戏客户端。
4. 维护服务端监听配置与客户端 `apiServer` 补丁配置的一致性。

本轮明确不考虑 ADB 代理模式。原因是代理拦截效果受 Android 版本、系统代理行为、证书信任、游戏网络栈和 TCP 会话连接影响，不适合作为“单击游戏”的基础路径。

## 产品定位

### 推荐定位

```text
壳 = 启动器 + 服务控制台 + 客户端补丁管理器
```

用户打开壳后应看到一个可执行的启动面板，而不是配置清单：

```text
服务端：未运行 / 运行中 / 异常退出
CDN：未配置 / 可用 / 缺文件
客户端：未导入 / 未生成 / 已安装 / 配置过期

主要操作：
  启动服务
  启动游戏
  打开后台
  查看日志

次级入口：
  服务端配置
  CDN 管理
  客户端补丁
  数据导入导出
```

### 不采用的定位

#### 仅作为独立服务端 APK

该方案能解决 Android 本机启动服务端，但无法解决客户端配置同步问题。只要服务端监听地址可改，游戏 APK 的 `apiServer` 也必须随之更新，否则用户仍需手工运行 `starview`、重新签名并安装客户端。

#### 仅作为客户端生成器

该方案会退化成 `starview` GUI，无法覆盖服务端常驻、日志、后台管理、CDN 校验和数据目录管理。本项目的主体仍是 `starpoint-cn` 服务端，客户端补丁只是把游戏接入本地服务的必要入口。

## 项目归属

### 可选方案

#### 作为 `starpoint-cn` 分支内模块

把 Android 启动器放在 `starpoint-cn/launcher-android/` 或 `starpoint-cn/android-launcher/` 下，与服务端文档、bundle 产物格式和管理后台 API 一起演进。

优点：

- 与当前唯一受版本控制的主项目一致，避免依赖顶层本地目录。
- 服务端 bundle manifest、管理 API、日志格式和启动器能在同一提交中保持兼容。
- 本项目的隐私和提交卫生规则已经覆盖 `starpoint-cn`。
- 适合当前阶段快速验证，因为启动器仍强依赖 `starpoint-cn` 的运行包、CDN 路由和管理后台。

缺点：

- Android 构建系统会让 `starpoint-cn` 仓库变重。
- 如果未来要支持多个服务端实现，放在 `starpoint-cn` 内会显得偏专用。
- 需要明确 Gradle、Android SDK、服务端 Node 依赖之间的构建边界，避免污染现有 `npm run build`。

#### 作为附属于 `starpoint-cn` 的独立子项目

在同一公开仓库内保留独立目录，例如：

```text
starpoint-cn/
  launcher-android/
  src/
  docs/
  package.json
```

该方案本质仍属于 `starpoint-cn`，但工程上保持独立：Android 有自己的 Gradle 配置、README、测试和产物目录；服务端仍由现有 Node 项目构建。

优点：

- 保持版本同步，同时不把 Android 构建混进服务端构建。
- 可以把启动器与服务端通过 manifest、bundle 和 HTTP API 明确解耦。
- 最符合当前目标：壳、服务端、CDN、客户端补丁器解耦，但仍围绕 CN 私服场景。

缺点：

- 仓库会同时包含 Node 服务端和 Android 工程，需要 CI/文档清楚区分。
- 如果 Android 壳未来独立发布，需要再抽离仓库或建立 release 流程。

#### 作为完全独立项目

创建新仓库，例如 `worldflipper-cn-launcher`，只通过服务端 bundle manifest 和公开 API 与 `starpoint-cn` 连接。

优点：

- 仓库职责最清晰，Android 构建、发布和 issue 可以独立管理。
- 可以把它设计成通用私服启动器，不被 `starpoint-cn` 目录结构限制。
- 不会增加 `starpoint-cn` 的构建复杂度。

缺点：

- 当前阶段会显著增加联调成本。服务端 manifest、运行参数、日志格式、后台入口和补丁 profile 的变更需要跨仓库同步。
- 本地顶层目录不是完整受控 monorepo，独立仓库会让当前资料、`starview` 参考和 `starpoint-cn` 文档之间更松散。
- 容易过早抽象，导致壳为了“通用”牺牲 CN 私服的一键体验。

### 推荐归属

第一阶段应作为 **附属于 `starpoint-cn` 的独立子项目** 开发：

```text
starpoint-cn/
  launcher-android/
    app/
    core/
    patcher/
    docs/
```

理由：

1. 当前启动器的核心价值是让 `starpoint-cn` 在 Android 上成为可启动、可管理、可连接游戏客户端的一体体验，而不是独立通用工具。
2. 服务端 bundle、管理后台、日志格式、CDN 校验规则和客户端补丁 profile 都需要和 `starpoint-cn` 同步演进。
3. Android 工程应有独立构建入口，不能影响现有 `npm run build`、`npm run dev:cn` 和服务端 TypeScript 编译。
4. `starview/` 当前是本地辅助项目，不属于 `starpoint-cn` 版本控制边界。启动器需要提取的是补丁意图和协议知识，不应直接依赖未纳入主仓库的 `starview` 目录。

建议在文档和代码中把边界写清楚：

```text
launcher-android 是 starpoint-cn 的 Android 启动器子项目。
它可以内置或导入 starpoint-cn server bundle。
它不拥有服务端业务逻辑。
它不拥有 CDN 数据。
它不把 starview 作为运行时依赖。
```

未来满足以下条件后，可以再拆成独立仓库：

- 服务端 bundle manifest 稳定。
- Android 壳能通过公开协议管理服务端，而不是依赖仓库内路径。
- Client Patcher 已稳定支持目标 APK 版本。
- 发布、签名、测试和问题反馈流程需要独立于服务端。

## 模块职责

### Launcher UI

Launcher UI 负责把状态和动作组织成可操作流程：

- 显示服务端、CDN 和客户端三类状态。
- 提供“启动服务”“启动游戏”“打开后台”“查看日志”四个高频入口。
- 提供模式选择：本机单击、局域网服务、自定义。
- 在配置过期时提示重新生成游戏客户端，例如服务端地址从 `127.0.0.1:8001` 改为局域网 IP 后，已安装客户端仍指向旧地址。
- 不承载游戏业务逻辑，不直接读写 `starpoint-cn` 数据库表。

### Server Runtime

Server Runtime 负责运行 `starpoint-cn` 服务端包：

- 启动 HTTP API、管理后台、CDN 静态路由和 TCP 会话服务。
- 通过前台服务保持运行，并显示常驻通知。
- 接收壳传入的环境变量和目录配置。
- 将 stdout、stderr 和结构化运行事件写入日志管线。
- 支持替换服务端 bundle，避免壳 APK 和服务端迭代强绑定。

服务端应继续以环境变量作为外部配置入口：

```text
CN_LISTEN_HOST=127.0.0.1
CN_LISTEN_PORT=8001
SESSION_HOST=127.0.0.1
SESSION_PORT=8003
CDN_DIR=/storage/emulated/0/WorldFlipperCN/cdn
DATABASE_DIR=/storage/emulated/0/WorldFlipperCN/database
LOG_DIR=/storage/emulated/0/WorldFlipperCN/logs
```

服务端不应感知自己运行在桌面 Node、Termux、Android 原生进程或未来的嵌入式运行时中。Android 适配层只负责提供同等环境变量和可写目录。

### CDN Store

CDN Store 负责保存和校验资源文件，不参与服务端业务逻辑：

- 用户选择或导入 CDN 根目录。
- 校验 `EntityLists/10939-android_medium.csv` 和 archive 目录是否存在。
- 统计 ZIP 数量、缺失目录和估算资源体积。
- 向 Server Runtime 提供 `CDN_DIR`。
- 不把 10GB 级 CDN 打进壳 APK。

推荐外部目录结构：

```text
/storage/emulated/0/WorldFlipperCN/
  server/
    current/
  cdn/
    cn/
      EntityLists/
      archive-common-full/
      archive-common-diff/
      archive-medium-full/
      archive-medium-diff/
      archive-android-full/
      archive-android-diff/
  database/
    wdfp_data.db
  logs/
    server.log
  client/
    original.apk
    patched.apk
    patch-profile.json
```

### Client Patcher

Client Patcher 负责生成可连接本地服务的游戏 APK：

- 选择原始 CN APK。
- 修改 `apiServer` 到指定地址。
- 可选启用 `sdkDummy=true` 跳过雷霆登录。
- 重新打包、签名并生成 patched APK。
- 调用系统安装器安装 patched APK。
- 调用系统 Launcher Intent 启动游戏。

第一版不建议把完整 `starview` 和 FFDec 直接塞进 Android 壳。`starview` 当前链路依赖桌面 Java/FFDec、脚本导出导入、`zipalign` 和 `apksigner`。这些能力适合桌面 CLI，不适合在 Android APK 内原样运行。

推荐把 `starview` 的补丁意图提取为最小 Android 补丁器：

```text
apiServer:
  定位 DevConfig_gf_android 中的 ApiServerKind.Custom("https","shijtswygamegf.leiting.com")
  改为 ApiServerKind.Custom("http","127.0.0.1:8001") 或用户指定地址

sdkDummy:
  定位 DevConfig.sdkDummy 默认值
  将 false 改为 true
```

实现上应优先研究 SWF/ABC 常量池或字节码级定点补丁，避免在手机上运行 FFDec。若短期内字节码补丁风险过高，可以保留桌面 `starview` 作为备用生成路径，但壳的长期目标仍应是 Android 本地生成 patched APK。

### Log Pipeline

Log Pipeline 负责把服务端和补丁器输出转成可查看、筛选和导出的日志：

- 按来源区分：服务端、TCP 会话、客户端补丁、CDN 校验、壳自身。
- 按级别筛选：info、warn、error、debug。
- 支持关键词过滤和时间范围过滤。
- 支持导出当前筛选结果和完整日志文件。
- 对 `/debug`、`/crash`、`BEACON` 等游戏信标保留原始文本，便于和现有排查流程对应。

日志导出必须默认脱敏本机路径、设备 ID、局域网 IP 以外的敏感字段。用于公开 issue 或 commit 的日志应另走手动确认。

### Profile Config

Profile Config 负责保存一组可复用运行配置：

```json
{
  "mode": "local",
  "serverListenHost": "127.0.0.1",
  "serverListenPort": 8001,
  "sessionHost": "127.0.0.1",
  "sessionPort": 8003,
  "clientApiBaseUrl": "http://127.0.0.1:8001",
  "cdnDir": "/storage/emulated/0/WorldFlipperCN/cdn",
  "databaseDir": "/storage/emulated/0/WorldFlipperCN/database",
  "skipLogin": true
}
```

`serverListenHost` 和 `clientApiBaseUrl` 必须分开保存。局域网模式下服务端通常监听 `0.0.0.0`，但客户端不能 patch 到 `0.0.0.0`，必须 patch 到当前手机的局域网 IP。

## 模式设计

### 本机单击模式

```text
服务端 HTTP: 127.0.0.1:8001
服务端 TCP:  127.0.0.1:8003
客户端 API:  http://127.0.0.1:8001
```

这是默认推荐模式。优点是无需局域网、无需 ADB、无需代理、暴露面最小。适合“服务端和游戏都在同一台 Android 设备上”的单机体验。

### 局域网服务模式

```text
服务端 HTTP: 0.0.0.0:8001
服务端 TCP:  0.0.0.0:8003
客户端 API:  http://<当前手机局域网IP>:8001
```

该模式允许另一台手机、平板或模拟器连接本机服务端。壳需要显示当前 Wi-Fi IP，并在 IP 变化时标记客户端配置过期。

局域网模式下管理后台也会暴露到局域网。第一版应至少显示风险提示；若未来支持长期局域网使用，应补充管理后台认证。

### 自定义模式

用户手动指定监听和客户端目标地址：

```text
服务端监听 Host
服务端 HTTP Port
TCP Host
TCP Port
客户端 API Base URL
CDN 目录
数据库目录
```

该模式用于模拟器、热点、端口冲突和开发调试。壳只做格式校验和连通性检测，不猜测用户网络拓扑。

## 关键数据流

### 首次配置

```text
用户打开壳
  -> 选择本机单击模式
  -> 选择或导入 CDN 目录
  -> 选择原始 CN APK
  -> 壳生成 patched APK，apiServer=http://127.0.0.1:8001，sdkDummy=true
  -> 用户确认安装 patched APK
  -> 壳启动服务端
  -> 壳启动游戏
```

### 日常启动

```text
用户打开壳
  -> 壳检查 CDN、服务端 bundle、数据库和客户端 patch-profile
  -> 用户点击启动服务
  -> 服务端进入前台服务运行
  -> 用户点击启动游戏
```

如果服务端未运行，点击启动游戏时应提示先启动服务，或提供“启动服务并打开游戏”的组合动作。

### 地址变更

```text
用户将模式从本机单击改为局域网服务
  -> 壳更新服务端监听为 0.0.0.0
  -> 壳计算客户端 API 地址为当前 Wi-Fi IP
  -> 壳发现已安装客户端 patch-profile 指向旧地址
  -> 标记客户端配置过期
  -> 用户重新生成并安装 patched APK
```

## APK 签名与安装

patched 游戏 APK 必须重新签名。签名变化带来两个行为：

1. 官方原包通常不能被直接覆盖安装，首次安装 patched 包可能需要卸载原包。
2. 只要壳持续使用同一把签名 key，后续壳生成的 patched APK 可以互相覆盖安装。

第一版可以使用壳首次运行生成的本机签名 key，并存放在壳私有目录。这样不会把固定 keystore 长期硬编码到公开 APK 中，也能保证同一设备后续覆盖安装一致。

普通 Android 应用不能静默安装 APK。壳只能调用系统安装器，由用户确认安装。root、设备所有者模式和 ADB 静默安装不进入本轮设计。

## 服务端 bundle 解耦

壳 APK 不应和服务端业务代码强绑定。推荐支持两种来源：

1. 壳内置一个默认服务端 bundle，用于首次启动。
2. 用户导入新的服务端 bundle，用于快速迭代。

服务端 bundle 至少需要包含：

```text
out/
web/
assets/
package manifest
runtime manifest
```

manifest 记录：

```json
{
  "name": "starpoint-cn",
  "version": "1.0.1",
  "entry": "out/cn-server.js",
  "requires": {
    "node": ">=20.0.0"
  },
  "ports": {
    "http": 8001,
    "tcp": 8003
  }
}
```

服务端 bundle 的具体运行时仍需单独验证。当前最大技术风险是 `better-sqlite3` 原生模块在 Android ABI 上的构建和加载。该风险属于后续实现计划，不改变本设计中的职责边界。

## 配置一致性规则

壳必须维护一份客户端补丁档案：

```json
{
  "sourceApkSha256": "原始 APK 哈希",
  "patchedApkSha256": "生成 APK 哈希",
  "apiBaseUrl": "http://127.0.0.1:8001",
  "skipLogin": true,
  "generatedAt": "2026-07-19T00:00:00.000Z",
  "installerPackage": "android.intent.action.VIEW"
}
```

以下情况应标记客户端配置过期：

- `clientApiBaseUrl` 变化。
- `skipLogin` 勾选状态变化。
- 原始 APK 文件变化。
- 补丁器版本变化且声明需要重新生成。

以下情况不应强制重新生成客户端：

- CDN 目录变化但 HTTP 路径和服务端地址不变。
- 数据库目录变化。
- 日志目录变化。
- 管理后台 UI 更新。

## 错误处理

### 服务端启动失败

壳应展示退出码、最近日志和常见原因：

- 端口被占用。
- CDN 目录不可读。
- 数据库目录不可写。
- 服务端 bundle 不完整。
- Android 原生模块加载失败。

用户可直接导出日志，不需要连接电脑。

### CDN 校验失败

CDN 缺失不应阻止服务端启动，但应阻止“推荐的一键启动游戏”流程。否则用户会进入游戏后遇到 C8601 或资源下载失败。

壳应允许开发者跳过 CDN 校验，但需要明确标记为调试行为。

### 客户端补丁失败

补丁失败必须保留原始 APK，不写坏用户选择的源文件。失败时展示阶段：

```text
读取 APK
提取 SWF
定位补丁点
写入补丁
重打包
签名
安装
```

定位不到 `sdkDummy` 或 `apiServer` 时应停止并提示“不支持该 APK 版本”，不能做模糊替换。

## 验收清单

### 壳定位

- 主屏能同时显示服务端、CDN 和客户端状态。
- 用户可以从主屏完成启动服务、启动游戏、打开后台和查看日志。
- 服务端运行和客户端补丁互不阻塞；未导入客户端时仍可启动服务端和后台。

### 模式配置

- 本机单击模式生成 `127.0.0.1` 监听和客户端地址。
- 局域网服务模式监听 `0.0.0.0`，客户端地址使用当前手机局域网 IP。
- 自定义模式允许手动配置监听地址和客户端 API 地址。
- 服务端监听地址变化后，壳能判断已安装客户端是否过期。

### 客户端补丁

- 能选择原始 APK 并生成 patched APK。
- 能只修改 IP、只跳过登录或同时启用两者。
- patched APK 使用同一设备上的稳定签名 key。
- 安装通过系统安装器确认，不依赖 root 或 ADB。
- 不支持的 APK 版本被明确拒绝，不输出半成品。

### 服务端与 CDN

- 服务端 bundle 可独立替换。
- CDN 目录可独立选择和校验。
- 数据库目录和日志目录与服务端 bundle 分离。
- 日志可按来源、级别和关键词筛选并导出。

## 后续规划边界

本设计通过后，下一步应拆成实现计划，而不是直接写代码。建议后续计划按风险顺序拆分：

1. Android 壳骨架与状态模型。
2. 外部目录、配置 profile 和日志管线。
3. 服务端运行时可行性验证，重点验证 Node 运行和 `better-sqlite3`。
4. CDN 目录校验。
5. Client Patcher 原型，先验证 SWF/ABC 定点补丁。
6. 系统安装器和游戏启动流程。

其中第 3 和第 5 是最高风险点，应先做小原型验证，再扩展成完整应用。
