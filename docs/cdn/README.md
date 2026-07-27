# CDN 与内容运行时

本目录说明官方 CDN、Content Release、服务端业务表和客户端资源下载之间的边界。当前支持官方 CN 1.4.54 CDN 的 `EntityLists/` 与 `entities/` 两种已知 dump 布局，不承诺兼容损坏、自制或其他版本资源。

## 建议阅读顺序

1. [机制总览](./overview.md)：CDN 文件布局与客户端访问方式。
2. [运行支持边界](./runtime-support.md)：当前明确支持和不支持的输入。
3. [Content Sync](./content-sync.md)：启动同步、Release 和快照选择。
4. [Catalog 与 Planner](./catalog-planner.md)：归档目录、版本图与下载计划。
5. [客户端流程](./client-flow.md)：版本检查、清单与下载交互。
6. [排查手册](./debugging.md)：同步、归档和客户端错误定位。

## 职责边界

- CDN 保存客户端资源归档和可提取的内容源。
- `content:sync` 根据受支持输入生成或复用 Content Release；CDN 版本、生成器版本或服务端表注册契约变化时自动重建。
- `content:audit` 是显式运行的只读发布门禁：检查全部 Registry 运行表，并对任务关键表执行官方提取源一致性与引用闭包校验；它不参与服务启动。
- Content Runtime 在进程启动时加载固定 snapshot，向业务模块提供已接入的运行表。
- 服务端通过 Catalog 向客户端声明版本、大小和下载归档。
- SQLite 保存玩家状态，不保存或替代 CDN 内容定义。

当前 Registry 为 `102 CDN + 5 bundled + 4 server`。只有已注册 CDN 转换器的表会动态生成，其中 35 张直接表按一至三层 OrderedMap 结构原样还原，6 张奖励表、1 张 Additional Reward 规则表、5 张玩法表、3 张活动扭蛋箱表、1 张玛纳节点表和 8 张物品装备表按权威字段映射派生，20 张关卡表与 5 张关卡索引在同一批次生成；其余 `assets/` 是明确保留的版本内置兼容或审计数据。加入新 CDN 并不等于任意业务表都会自动更新；但服务端新增、移除注册表或调整表转换元数据后，下一次 normal sync 会自动生成兼容的新 Release，不要求部署者手动 `--force`。
