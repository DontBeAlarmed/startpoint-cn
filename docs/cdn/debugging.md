# CDN 排查手册

本文面向官方 CN 1.4.54 CDN 与官方 CN 1.8.1 客户端，只记录当前服务端可执行的诊断流程。自制、损坏或其他版本 CDN 的修复不属于项目支持范围。

机制、版本链和客户端判断顺序分别见[机制总览](./overview.md)、[Catalog 与 Planner](./catalog-planner.md)和[客户端流程](./client-flow.md)。

## 1. 先确认运行模式

服务启动前先确认 `ASSET_MODE`：

| 模式 | CDN 由谁提供 | 启动行为 |
|---|---|---|
| `local` | 当前服务端 | 启动入口先执行 `content:sync`，再加载本地 Catalog 与 Content snapshot |
| `remote` | 外部 HTTP CDN | 跳过本地内容同步，服务端只返回配置的远程资源地址 |
| `client-owned` | 客户端已有资源 | 跳过服务端 CDN 下载流程 |

受支持的前台入口：

```bash
bash scripts/start-cn.sh
```

常规启动由 `tools/start_cn.cjs` bootstrap 编排同步与服务进程，并由前台脚本透传退出状态。`node out/cn-server.js` 是不会自动同步内容的低级调试入口，只适用于已经确认 Release 可用的场景。网络地址变量及本机/局域网边界见[网络支持边界](../getting-started/network-boundary.md)。

## 2. 启动失败

### `content:sync` 失败

1. 确认 `.cdn/cn/`、`EntityLists/` 或 `entities/` 资源清单目录以及归档目录存在；
2. 直接运行 `npm run content:sync`，保留第一条错误及其路径；
3. 检查 `CONTENT_RELEASES_DIR`、`CONTENT_ACTIVE_RELEASE_FILE` 等路径是否可写；
4. 运行 `npm run content:smoke` 验证同步产物能否被当前运行时加载；
5. 修改 CDN 后需要强制重建同版本 Release 时，按[Content Sync](./content-sync.md)使用受支持的 force 参数。

服务端只解析已注册转换器对应的表。某张表没有转换器时，加入新 CDN 不会自动替换内置 `assets/` 数据。

### Content snapshot 无法加载

检查启动日志中的 Release ID、目标 CDN 版本和 active pointer。运行时在进程启动时固定 snapshot；替换文件后必须完成同步并重启，不能期待运行中的模块热切换到另一份表。

## 3. 客户端没有下载或版本不更新

按以下顺序核对：

1. `/load` 返回的 `available_asset_version` 是否等于当前 snapshot 的目标版本；
2. 客户端请求 `/asset/get_path` 时是否带有预期的 `RES_VER`；
3. Planner 是否为该起始版本找到唯一可达路径；
4. 响应中的 `full`、`diff`、`target_asset_version` 和归档 URL 是否一致；
5. `CDN_BASE_URL` 是否为客户端实际可达地址；
6. 客户端 `info.json` 是否仍记录旧版本或未完成下载状态。

已在目标版本时，`full` 和 `diff` 都为 `null` 是正常结果。未知起始版本、断裂版本链或歧义路径应由服务端明确拒绝，不应伪造一条更新路径。

## 4. 下载大小或归档列表异常

下载大小来自 Catalog 中每个归档的真实 `size` 之和，不应使用固定显示值。出现大小不符时：

1. 对照 `/asset/get_path` 返回的归档数量和 `size`；
2. 检查目标平台及 `fulfill`/`shortened` 请求模式；
3. 确认 Catalog 指向的文件与磁盘归档是同一份；
4. 运行 `npm run cdn:manifest` 仅在确实需要重建运行时清单时生成 manifest；
5. 使用 `node tools/audit_cdn_catalog.cjs` 做独立 Catalog 审计。

服务端不会为了被修改的 CDN 做恢复、猜测缺失归档或修补版本链。审计工具用于定位输入问题，不改变运行时责任边界。

## 5. ZIP 请求失败

### 404

- 确认 URL 属于当前 Catalog allowlist；
- 确认归档位于配置的 CDN 根目录内；
- 检查文件名大小写和平台目录；
- 不要通过软链接把路径引出 CDN 根目录。

### Range 或断点续传失败

资源路由支持完整响应、HEAD、closed/open/suffix Range 和 416。先用自动测试复现：

```bash
node tools/test-workflow/run.cjs --files tools/cdn_files.test.cjs
```

如果只有真实设备失败，再记录请求的 `Range`、响应状态、`Content-Range` 与连接中断位置。不要把原始 token、设备标识或完整请求头提交到仓库。

## 6. C8601

C8601 表示客户端资源读取或一致性流程失败，不是单一服务端错误码。当前支持环境中按以下顺序定位：

1. 确认客户端版本为 CN 1.8.1、CDN 目标版本为 1.4.54；
2. 确认 `/load`、`/asset/get_path` 和客户端本地 `info.json` 的版本一致；
3. 确认所有声明的 ZIP 已完整下载并成功解压；
4. 确认 Catalog 文件大小和 SHA256 与磁盘文件一致；
5. 确认错误发生在下载阶段、解压阶段还是进入主场景读取表时；
6. 若官方输入文件校验失败，重新准备官方 CDN；服务端不兜底修复非法 CDN。

客户端会继续执行自己的下载状态和资源完整性判断。服务端只保证按 Catalog 提供协议与文件，不把客户端校验结果重新实现为一套恢复系统。

## 7. 服务端业务表与客户端显示不一致

CDN 归档供客户端使用，Content Release 中的业务表供服务端使用。两者同源但不是同一个运行时对象。出现角色、卡池或商店不一致时：

1. 确认目标表已经注册转换器；
2. 运行 `npm run content:sync`；
3. 检查 active Release 是否发生变化；
4. 重启服务，确认启动日志加载了新 snapshot；
5. 对照 `src/content/` 转换器测试与对应 repository 测试；
6. 未接入动态转换的表继续以仓库内置数据为准。

相关回归入口：

```bash
npm run test:changed
npm run test:integration
npm run verify:full
```

## 8. 诊断资料卫生

允许提交：

- 已脱敏且长期有效的协议结论；
- 可重复生成的最小测试 fixture；
- 不含个人环境信息的自动测试；
- 当前架构、责任边界和故障决策树。

不得提交：

- 原始抓包、访问令牌、设备 ID、UDID、登录会话或真实存档；
- APK、CDN ZIP、keystore、签名密码和私钥；
- 本机绝对路径、局域网地址和临时日志；
- 单次排查时间线、已废弃方案和不存在于仓库的命令；
- 为修复自制或损坏 CDN 而加入的运行时兜底。

需要保留原始证据时放在仓库外，并在公开文档中只记录已经验证、可复现且完成脱敏的结论。
