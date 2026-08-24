# StarPoint CN 文档

这里保存项目长期维护的运行说明、当前架构、游戏系统、协议依据和实现状态。首次阅读请按目标选择路径，不需要从目录顺序通读全部文档。

## 运行服务

适合首次安装、本地或局域网运行和排查启动问题：

1. 从[运行服务索引](./getting-started/README.md)确认支持版本、目录和启动入口。
2. 使用 `bash scripts/start-cn.sh` 完成构建并按 `ASSET_MODE` 启动；只有 `local` 模式执行本地内容同步。
3. CDN 下载或版本异常时转到[CDN 文档](./cdn/README.md)。
4. 客户端尚未连接时阅读仓库根目录的[客户端补丁说明](../client-patch/README.md)。
5. 跨设备运行前确认[网络支持边界](./getting-started/network-boundary.md)。

受支持的前台入口统一交给 bootstrap 选择资源模式；不要用低级调试入口代替常规启动流程。

## 开发功能

适合实现路由、业务规则、数据库状态或后台功能：

1. 先读[当前运行时架构](./architecture.md)，再从[当前架构图集](./architecture/README.md)确认模块、事务和协议边界。
2. 从[游戏系统索引](./systems/README.md)查找已有语义、已知约束和对应代码。
3. 使用[路由族覆盖矩阵](./reference/routes-status.md)判断业务边界，再以注册源码和测试确认单端点状态。
4. 按[开发验证工作流](./development/verification-workflow.md)运行相关测试和提交前验证。

管理功能的当前边界见[管理后台](./admin/README.md)，开发命令与门禁从[开发与验证索引](./development/README.md)进入。

数据层位于 `src/data/`；新增持久化能力应优先进入对应领域，避免继续扩展跨领域兼容导出。

## 研究协议

适合核对客户端字段、编码方式和联机状态机：

1. 从[协议索引](./protocol/README.md)进入经过整理的当前协议说明。
2. 新实现以官方 CN 1.8.1 客户端反编译代码、当前注册源码和测试为主参考。
3. 需要抓包交叉验证时，使用开发者本地自备且已经脱敏的样本；当前树不收录原始抓包。

## 维护 CDN

适合准备官方资源、理解内容同步和排查资源错误：

1. 从[CDN 索引](./cdn/README.md)了解客户端资源、内容表和运行时快照的职责边界。
2. `ASSET_MODE=local` 时，日常使用受支持启动入口自动执行 `content:sync`；其他模式跳过本地同步。
3. 需要离线检查、强制重建或真实 CDN smoke 时再进入专项文档。

## 嵌入式宿主

适合 Android 启动器、桌面壳、容器或进程管理器集成：

1. 阅读[嵌入式运行契约](./embedded-runtime-contract.md)。
2. 从[运行时与宿主集成](./runtime/README.md)进入 Server Bundle、校验和启动职责。
3. Android 壳的产品边界和客户端补丁规则见 [Android Launcher 契约](./runtime/android-launcher.md)。
4. 宿主只依赖稳定契约，不应调用内部调试入口或直接修改运行时状态文件。

## 文档规则

文档按用途分为三类：

- **current**：`architecture.md`、`architecture/`、`embedded-runtime-contract.md`、`admin/`、`development/`、`getting-started/`、`systems/`、`protocol/`、`cdn/` 和 `runtime/`。描述当前代码支持的行为；代码变更时必须同步更新。
- **reference**：`reference/`。保存路由族覆盖等当前参考入口；原始抓包和含设备、令牌形态的数据不进入公共仓库。
- **status**：`status/`。记录当前实现覆盖、未解决问题和客户端验收结果；状态变化时更新，不复制架构细节。

实施计划、临时执行步骤、已完成的重构流水账和个人环境说明不属于长期知识库，不应提交到仓库。历史变更由 Git 记录；当前行为以 current 文档和代码为准。

## 目录入口

- [运行服务](./getting-started/README.md)
- [当前架构](./architecture.md)
- [当前架构图集](./architecture/README.md)
- [管理后台](./admin/README.md)
- [开发与验证](./development/README.md)
- [游戏系统](./systems/README.md)
- [协议](./protocol/README.md)
- [CDN 与内容](./cdn/README.md)
- [参考资料](./reference/README.md)
- [实现状态](./status/README.md)
- [运行时与宿主集成](./runtime/README.md)
- [嵌入式运行契约](./embedded-runtime-contract.md)
