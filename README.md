# StarPoint CN

世界弹射物语(World Flipper)CN(雷霆 Leiting)版本的服务端模拟器。

## 功能状态

已实现(部分端点沿用国际服设计,对 CN 的通用性尚未验证):

- 账号:设备自动绑定(`device_id`)、Web 管理面板
- 时间系统:全局 / 按存档时间偏移(默认 2024-08-14,规避 CDN 报错)
- 关卡:主线 / 部分活动·Boss / 单人战斗结算
- Gacha:角色·武器卡池、兑换、C3032 动画修复、抽卡种子验证
- 多人联机(NPC 协战):Phase 2 — 建房 + NPC 招募 / 召唤 / 结算
- 系统:狂热激战 · 体力 · 商店 · 漫画 · 邮件群发
- 养成:升级 / 突破 / 魔晶板 / EX / 羁绊;武装:觉醒 / 熔解;编队 · 图鉴 · 教程

⚠️ 已知失效 / 注意:

- 存档导入 / 导出:已修复 —— 采用 MergedPlayerData 快照格式(仅管理面板备份/恢复,非游戏客户端 load）。
- 漫画资源**不随项目分发**,需自行导入。
- 多个端点沿用国际服(global)设计,不保证对 CN 客户端通用。

> 端点状态见 [docs](./docs/README.md) · [端点实现状态](./docs/reference/routes-status.md)

## 环境需求

- Node.js（日常使用当前默认版本；`package.json` 的 `engines` 要求 >=20.12.0） · 打补丁后的 CN 客户端 APK(见"客户端改造")
- 一份 CN CDN 资源,放入 `.cdn/cn/`

### CDN 路径清单文件(PathFile)

客户端经 EntityLists 的"路径清单文件"获取全部资源路径。**服务端对它使用了两套命名且不做归一处理**:

- `src/routes/cn/asset.ts` 的 version_info → `EntityLists/PathFile`
- `src/cn-server.ts` → `EntityLists/10939-android_medium.csv`

不同来源的 CDN 该文件名 / 位置可能不同(内容一致)。请确保 `.cdn/cn/EntityLists/` 下**同时存在** `PathFile` 与 `10939-android_medium.csv`(复制一份改名即可),否则按命中端点不同可能出现资源 404。

## 快速启动

### 前置

```bash
cd starpoint-cn
npm install
cp .env.example .env
```

管理后台依赖独立维护。首次安装，或 `admin/package-lock.json` 发生变化后，执行一次：

```bash
npm run install:admin
```

日常构建不重复安装后台依赖，各命令边界如下：

| 命令 | 边界 |
|------|------|
| `npm run build:server` | 仅编译 CN 服务端入口及其依赖，不构建 CSS 或管理后台 |
| `npm run start:cn` | 使用已有构建，先执行 `content:sync` normal，成功后启动 CN 游戏服务 |
| `npm run dev:cn` | 先执行 `build:server`，再执行与 `start:cn` 相同的同步和启动流程 |
| `npm run build:legacy` | 使用原 `tsconfig.json` 编译 legacy 全量 TypeScript，不构建 CSS |
| `npm run build` | 保留原有 legacy 全量 TypeScript + Tailwind CSS 构建语义 |
| `npm run build:admin` | 仅构建管理后台，不安装依赖 |
| `npm run content:sync` | 手动执行内容同步；支持 `--check` 或 `--force` |
| `npm run content:smoke -- --cdn-root <CDN_PARENT> --content-root <TMP_ROOT>` | 在显式隔离目录执行真实 CDN force smoke，不启动服务 |
| `npm run verify:full` | 依次执行类型检查、完整测试、仓库卫生检查和 CN 服务端构建 |
| `npm run cdn` / `npm run unzip` | 先同步完成 legacy 编译，再运行对应 CDN 工具 |

### 本地局域网（开发/测试）

`.env.example` 的局域网区块默认激活，`cp .env.example .env` 后可直接启动：

```bash
# 前台模式（build + content:sync + 启动）
bash scripts/start-cn.sh

# 开发模式（热重载，无需 build）
npm run debug:cn
```

如果客户端在**另一台设备**上，需编辑 `.env`：
- `CN_LISTEN_HOST`=`你的 LAN IP`（如 `192.168.x.x`）
- `CDN_BASE_URL`=`http://你的LAN_IP:8001/patch/cn`

### 公网云服务器

1. 按 [`docs/deployment.md`](./docs/deployment.md) 配置 nginx 反向代理 + 防火墙
2. 编辑 `.env`，激活公网区块：

```bash
CN_LISTEN_HOST="127.0.0.1"                        # 仅监听本地
CDN_BASE_URL="https://<你的域名>/patch/cn"        # 公网域名 + HTTPS
SESSION_PUBLIC_HOST="<你的域名>"                  # 联机 TCP 公网地址
```

3. 启动：

```bash
bash scripts/start-cn.sh
```

### 两种部署方式 `.env` 对比

| 配置项 | 局域网 | 公网 |
|--------|--------|------|
| `CN_LISTEN_HOST` | `0.0.0.0` / LAN IP | `127.0.0.1` |
| `CDN_BASE_URL` | `http://<LAN_IP>:8001/patch/cn` | `https://<域名>/patch/cn` |
| `SESSION_HOST` | `0.0.0.0` | `127.0.0.1` |
| `SESSION_PUBLIC_HOST` | 不设 | 公网域名 |
| 前置层 | 无 | nginx + SSL + 防火墙 |

### `.env` 加载说明

- `npm run start:cn`、`npm run dev:cn` 与 `bash scripts/start-cn.sh` 通过 bootstrap 加载可选 `.env`；文件不存在时沿用当前环境。
- `npm run debug:cn` 保留现有 ts-node-dev 热重载与 `--env-file=.env` 语义，不经过 bootstrap，也不会自动执行内容同步。

### 启动入口边界

受支持入口会先完成 `content:sync` normal，只有同步成功才启动游戏服务。`scripts/start-cn.sh` 在前台依次执行 `build:server` 和 bootstrap，不执行 `pkill`、不创建 `nohup` 后台进程，也不写固定日志文件；需要后台运行时由调用者或进程管理器托管该前台命令并收集标准输出和标准错误。

`node out/cn-server.js` 是低级调试入口，不会自动同步；直接使用前必须自行确认当前内容 Release 已准备并激活。

Content Sync 的 fallback、`check`/`force`、Release 布局、真实 CDN smoke 和错误回退步骤见 [`docs/cdn/content-sync.md`](./docs/cdn/content-sync.md)。

## 关键配置(.env)

- `CN_LISTEN_HOST` / `CN_LISTEN_PORT` — HTTP 绑定地址 + 联机 TCP 房间显示 IP;客户端在别的设备时设为你的 LAN IP(默认端口 8001)。
- `CDN_BASE_URL` — `http://<你的LAN_IP>:<端口>/patch/cn`。
- `CN_RES_VERSION` — 须与客户端 resourceVersion 一致(当前 1.4.54)。
- `DROP_MULTIPLIER` / `NPC_*` — 测试与联机调参。

## 客户端改造(最小功能)

连接本服务需对官方 APK 打两处改动(免登录 + 重定向到本服),详见 [`client-patch/`](./client-patch/README.md):

- **免登录** — `pinball/config/core/DevConfig.as`:`sdkDummy = false` → `true`
- **重定向到本服** — `pinball/config/gbits/DevConfig_gf_android.as`:域名 → 你的服务器,`"https"` → `"http"`

用 FFDec 导出 APK 的 AS3 后执行:

```bash
bash client-patch/apply.sh <AS3_导出目录> <你的LAN_IP>:8001
```

再用 FFDec 回封、重打包签名。完整 APK / 反编译说明见本地环境文档 `docs/setup/`。

## Web 管理面板(`http://<CN_LISTEN_HOST>:<端口>/`)

`/` 时间设置 · `/player` 账号·存档·玩家 · `/player/:id` 玩家详情 · `/mail` 群发邮件

> 面板对写入端点做**结构安全校验**(拒绝未知字段 / 类型错误 / 超 2³¹ 的非法值并明确报错),但不限制游戏平衡数值;重要操作仍建议先用「下载 JSON」导出备份。
> 若误发非法邮件导致客户端在邮件界面崩溃,可用玩家详情页的**清空邮件箱**恢复。

## FAQ

- `H404` = 该功能 / 端点尚未实现。

## 致谢 / 相关项目

- [wdfp-extractor](https://github.com/ScripterSugar/wdfp-extractor) — 资源提取
- [wfax](https://github.com/blead/wfax) — 资源转换 / 修改
- 上游 [Duosion/starpoint](https://github.com/Duosion/starpoint) — 全球服模拟器基础
- [starview](https://github.com/duosii/starview) — APK 打补丁工具(基础;本仓库最小补丁见 [`client-patch/`](./client-patch/README.md))
- [wf-2.1.125-cn-decompiled](https://github.com/dennis96292/wf-2.1.125-cn-decompiled) — CN 客户端反编译参考
