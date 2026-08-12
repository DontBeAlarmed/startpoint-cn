# 运行时与宿主集成

本目录描述服务端作为独立运行产物被 Android 启动器、桌面壳、容器或进程管理器托管时的稳定边界。

- [Server Bundle](./server-bundle.md)：可验证服务端代码包、manifest、必需后台产物和校验规则。
- [服务端能力契约](./server-capabilities.md)：本地发布工具消费的只读运行身份与能力事实。
- [Runtime Pack](./runtime-pack.md)：Node、原生模块、依赖锁和运行包 manifest 校验规则。
- [Android Launcher](./android-launcher.md)：壳与服务端、客户端补丁、CDN、日志之间的接入契约。
- [嵌入式运行契约](../embedded-runtime-contract.md)：Data Volume、启动配置、健康检查、退出和回滚职责。
- [当前运行时架构](../architecture.md)：普通开发启动与 Content Runtime 生命周期。

宿主集成应只依赖公开契约，不直接调用内部调试入口，不在运行中修改 Bundle，也不把进程内多人房间视为可恢复状态。
