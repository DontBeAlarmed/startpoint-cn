# 协议文档

本目录整理跨端点、需要长期维护的客户端协议。字段和枚举以官方 CN 1.8.1 客户端反编译代码为主依据，并由实际请求或测试交叉验证。

## HTTP 与抽卡

- [抽卡 C3032](./gacha-c3032.md)
- [卡池生成](./gacha-pool-generation.md)
- [种子验证](./seed-verification.md)

游戏主 HTTP API 使用 Base64 包裹 MsgPack。单端点协议以 CN 1.8.1 反编译代码、当前注册源码、测试和开发者本地自备的脱敏抓包交叉确认。

## 多人联机

- [多人联机协议](./multi-battle.md)
- [可信局域网多人 Hub 架构](./trusted-multi-hub.md)
- [超级猫头鹰多场景分析](./super-owl-multiscene.md)

多人 TCP 使用 Typepacker 枚举数组和空字符分帧，与 HTTP MsgPack 管线不同。新增或修改协议字段前应同时检查反编译客户端、当前状态机和已有测试。

当前树不收录原始抓包；业务覆盖概览见[路由族覆盖矩阵](../reference/routes-status.md)，单端点最终以注册源码和测试为准。
