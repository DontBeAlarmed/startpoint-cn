# 运行时与宿主集成

本目录描述服务端作为独立运行产物被 Android 启动器、桌面壳、容器或进程管理器托管时的稳定边界。

- [Server Bundle](./server-bundle.md)：可验证服务端代码包、manifest、可选后台产物和校验规则。
- [嵌入式运行契约](../embedded-runtime-contract.md)：Data Volume、启动配置、健康检查、退出和回滚职责。
- [当前运行时架构](../architecture.md)：普通开发启动与 Content Runtime 生命周期。

宿主集成应只依赖公开契约，不直接调用内部调试入口，不在运行中修改 Bundle，也不把进程内多人房间视为可恢复状态。
