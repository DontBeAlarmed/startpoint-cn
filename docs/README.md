# StarPoint CN 文档索引

> tracked 持久知识库。环境/敏感(搭建、连接、APK)见本地环境文档(需自行准备,不随本仓库分发)。

## 架构与协议
- [架构](./architecture.md)
- 协议: [多人联机](./protocol/multi-battle.md) · [抽卡 C3032](./protocol/gacha-c3032.md) · [种子验证](./protocol/seed-verification.md)

## 游戏系统
- [狂热激战](./systems/rush-event.md) · [体力](./systems/stamina.md) · [商店](./systems/shop.md) · [漫画](./systems/comic.md) · [邮件](./systems/mail.md) · [存档与校验](./systems/save-validation.md)

## CDN
- [机制总览](./cdn/overview.md) · [客户端流程](./cdn/client-flow.md) · [排查手册](./cdn/debugging.md)

## 参考与状态
- [端点实现状态](./reference/routes-status.md) · [路由抓包索引](./routes/README.md)
- [已知问题](./status/known-issues.md) · [变更日志](./status/changelog.md) · [测试进度](./status/test-progress.md)

## 贡献流程

### 实现一个端点
1. 用 mitmproxy 抓取游戏客户端与官方服务器之间的流量(连接方式需自行搭建)。
2. 用 [msgpack-converter](https://ref45638.github.io/msgpack-converter/) 解码 MsgPack 请求/响应体。CN 主 API(`*.wdfp.*`)走 base64(msgpack);其余端点走纯 JSON。
3. 在 `src/routes/cn/`(CN 专属)或 `src/routes/api/`(双服共享)实现端点。
4. 更新 [端点实现状态](./reference/routes-status.md),并在 [路由抓包索引](./routes/README.md) 补充对应抓包记录。

### What's Left
所有已发现路由及其实现状态见 [端点实现状态](./reference/routes-status.md);各路由的 client↔server 数据细节见 [路由抓包索引](./routes/README.md)。

### Project Structure(要点)
- `src/routes/cn/` — CN 专属端点(asset / load / leitingAuth / versionCheck 等)。
- `src/routes/api/` — 双服共享 API 路由。
- `src/data/` — SQLite 数据层,`db.ts` 为共享实例,`domains/` 下 16 个领域模块,`wdfpData.ts` 为兼容 barrel。
- `src/cn-server.ts` — CN 入口;`src/server.ts` — 全局入口。
- 完整分层、模块系统(CommonJS)、协议编码(MsgPack→Base64)、时间系统等见 [架构](./architecture.md)。

### Scripts(要点)
- `scripts/start-cn.sh` — 一键构建并以生产方式重启 CN 服务。
- `scripts/cdn_download.py` — 下载官方 CDN 副本。
- `scripts/converter.py` — 将游戏资源转换为服务器可读格式(`in/` → `out/`)。
- `scripts/mitm-redirect-traffic.py` — mitmproxy 脚本,把游戏流量重定向到本服务。
