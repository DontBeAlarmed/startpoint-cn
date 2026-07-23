# CDN 与内容运行时

本目录说明官方 CDN、Content Release、服务端业务表和客户端资源下载之间的边界。当前支持官方 CN 1.4.54 CDN，不承诺兼容损坏、自制或其他版本资源。

## 建议阅读顺序

1. [机制总览](./overview.md)：CDN 文件布局与客户端访问方式。
2. [运行支持边界](./runtime-support.md)：当前明确支持和不支持的输入。
3. [Content Sync](./content-sync.md)：启动同步、Release 和快照选择。
4. [Catalog 与 Planner](./catalog-planner.md)：归档目录、版本图与下载计划。
5. [客户端流程](./client-flow.md)：版本检查、清单与下载交互。
6. [排查手册](./debugging.md)：同步、归档和客户端错误定位。

## 职责边界

- CDN 保存客户端资源归档和可提取的内容源。
- `content:sync` 根据受支持输入生成或复用 Content Release。
- Content Runtime 在进程启动时加载固定 snapshot，向业务模块提供已接入的运行表。
- 服务端通过 Catalog 向客户端声明版本、大小和下载归档。
- SQLite 保存玩家状态，不保存或替代 CDN 内容定义。

当前只有已注册转换器的表会由 CDN 动态生成，其余 `assets/` 仍是版本内置数据。加入新 CDN 并不等于任意业务表都会自动更新。
