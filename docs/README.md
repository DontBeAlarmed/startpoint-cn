# StarPoint CN 文档

这里保存项目长期维护的运行说明、当前架构、游戏系统、协议依据和实现状态。首次阅读请按目标选择路径，不需要从目录顺序通读全部文档。

## 运行服务

适合首次安装、部署和排查启动问题：

1. 从[运行服务索引](./getting-started/README.md)确认支持版本、目录和启动入口。
2. 使用 `bash scripts/start-cn.sh` 完成构建并按 `ASSET_MODE` 启动；只有 `local` 模式执行本地内容同步。
3. CDN 下载或版本异常时转到[CDN 文档](./cdn/README.md)。
4. 客户端尚未连接时阅读仓库根目录的[客户端补丁说明](../client-patch/README.md)。

## 开发功能

适合实现路由、业务规则、数据库状态或后台功能：

1. 先读[当前运行时架构](./architecture.md)，确认模块边界和协议管线。
2. 从[游戏系统索引](./systems/README.md)查找已有语义、已知约束和对应代码。
3. 使用[端点状态表](./reference/routes-status.md)判断端点覆盖度，再查[路由参考资料](./reference/routes/README.md)。
4. 按[开发验证工作流](./development/verification-workflow.md)运行相关测试和提交前验证。

数据层位于 `src/data/`，当前包含 22 个领域模块；新功能应优先进入对应领域，而不是继续扩展兼容 barrel `wdfpData.ts`。

## 研究协议

适合核对客户端字段、编码方式和联机状态机：

1. 从[协议索引](./protocol/README.md)进入经过整理的当前协议说明。
2. 单端点请求与响应样本位于[路由参考资料](./reference/routes/README.md)。
3. 新实现以官方 CN 1.8.1 客户端反编译代码为主参考，路由样本只作为证据，不替代当前代码检查。

## 维护 CDN

适合准备官方资源、理解内容同步和排查资源错误：

1. 从[CDN 索引](./cdn/README.md)了解客户端资源、内容表和运行时快照的职责边界。
2. `ASSET_MODE=local` 时，日常使用受支持启动入口自动执行 `content:sync`；其他模式跳过本地同步。
3. 需要离线检查、强制重建或真实 CDN smoke 时再进入专项文档。

## 嵌入式宿主

适合 Android 启动器、桌面壳、容器或进程管理器集成：

1. 阅读[嵌入式运行契约](./embedded-runtime-contract.md)。
2. 阅读[Server Bundle](./runtime/server-bundle.md)，确定包内容、校验和启动职责。
3. 宿主只依赖稳定契约，不应调用内部调试入口或直接修改运行时状态文件。

## 文档规则

文档按用途分为三类：

- **current**：`architecture.md`、`getting-started/`、`systems/`、`protocol/`、`cdn/` 和 `runtime/`。描述当前代码支持的行为；代码变更时必须同步更新。
- **reference**：`reference/`。保存抓包、端点样本和调查依据，可能不完整或早于当前实现；不得仅凭参考文档宣称功能已经完成。
- **status**：`status/`。记录当前实现覆盖、未解决问题和客户端验收结果；状态变化时更新，不复制架构细节。

实施计划、临时执行步骤和个人环境说明不属于长期知识库，不应提交到仓库。历史设计文档将在后续整理中提炼或归档；在完成前，以 current 文档和代码为准。

## 目录入口

- [运行服务](./getting-started/README.md)
- [当前架构](./architecture.md)
- [游戏系统](./systems/README.md)
- [协议](./protocol/README.md)
- [CDN 与内容](./cdn/README.md)
- [参考资料](./reference/README.md)
- [实现状态](./status/README.md)
- [嵌入式运行契约](./embedded-runtime-contract.md)
