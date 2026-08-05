# Multi Hub 进程测试夹具

`tests/multi-hub-process.test.js` 不保存数据库、令牌、端口或日志夹具。测试运行时会在系统临时目录中完成以下准备：

1. 从当前构建的 Table Registry 复制已登记的 bundled 运行表和 CDN catalog；
2. 只为活动开放期场景给 `advent_event_quest 1001` 与 `challenge_dungeon_event_quest 2001` 加入固定测试时间窗；
3. 通过现有 `multi:token` CLI 所用的密钥存储流程生成两条一次性 Client 凭据；
4. 为 Host、Client B、Client C 分配独立 `DATA_DIR`、SQLite 和空闲回环端口；
5. 直接启动三个 `out/cn-server.js` 进程，结束时关闭 TCP/HTTP handle、终止进程并删除临时目录。

三个进程共享同一份只读运行表，因此内容摘要一致；玩家、会话、active quest、扣费和奖励始终写入各自数据库。确定性的裸 `viewerId` 冲突通过临时 SQLite 会话改写构造，测试结束后不会留下设备 ID、凭据明文或运行数据。

该夹具只服务于进程边界验证，不是可部署的内容 Release，也不替代 CN 客户端真机验收。
