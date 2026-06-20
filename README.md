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

- Node.js ≥ 20 · 打补丁后的 CN 客户端 APK(见"客户端改造")
- 一份 CN CDN 资源,放入 `.cdn/cn/`

### CDN 路径清单文件(PathFile)

客户端经 EntityLists 的"路径清单文件"获取全部资源路径。**服务端对它使用了两套命名且不做归一处理**:

- `src/routes/cn/asset.ts` 的 version_info → `EntityLists/PathFile`
- `src/cn-server.ts` → `EntityLists/10939-android_medium.csv`

不同来源的 CDN 该文件名 / 位置可能不同(内容一致)。请确保 `.cdn/cn/EntityLists/` 下**同时存在** `PathFile` 与 `10939-android_medium.csv`(复制一份改名即可),否则按命中端点不同可能出现资源 404。

## 快速启动

```bash
cd starpoint-cn
npm install
cp .env.example .env          # 按需修改 CN_LISTEN_HOST / CDN_BASE_URL
npm run build && npm run dev:cn   # 监听 CN_LISTEN_PORT(默认 8001)
```

一键(生产式,build + 重启 + 日志):`bash scripts/start-cn.sh`(另有 `scripts/start-cn-tmux.sh`)。

`.env` 加载说明:

- `npm run dev:cn` 与 `bash scripts/start-cn.sh` 经 `node --env-file=.env` **会**加载 `.env`。
- `npm run debug:cn`(ts-node-dev)无 `--env-file`、代码也未引入 dotenv,因此**不会**自动读 `.env`;调试时需自行 export 环境变量,否则走代码默认值。

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
