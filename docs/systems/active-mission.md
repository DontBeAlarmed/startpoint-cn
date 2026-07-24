# Active Mission

## 官方内容表

国服 1.4.54 的 `wf-assets-cn/orderedmap/active_mission/` 包含：

- `active_mission.json`：96 条任务定义；
- `active_mission_event.json`：4 个活动定义，event ID 为 1、2、3、150；
- `active_mission_reward.json`：96 条任务的阶段与奖励。

仓库运行资产对应为 `mission_active.json`、`mission_active_event.json` 和
`mission_active_reward.json`。运行：

```bash
npm run content:active-mission
```

可从受支持的官方 `wf-assets-cn` 重新生成三张表。Content registry 将其作为 bundled 表纳入
Content Release；这一步只补齐服务端解释 Active Mission 所需的定义，不改变 CDN 包或客户端。

当前 `active-master-data.ts` 与其他尚未完成动态迁移的任务表一致，在进程启动时读取 bundled assets。
因此本轮保证官方 1.4.54 定义可复现且运行时可解释，但尚不宣称切换 Content Release 后可热更新 Active Mission；
repository-backed 读取应与其余任务主表的动态迁移一起完成。

## 当前服务端边界

`/api/index.php/active_mission/receive` 已实现以下能力：

- 校验任务存在、阶段存在、完成阈值和重复请求；
- 在单一 SQLite 事务中写入领取状态并发放星导石、物品、装备、角色、玛纳、经验和称号；
- 返回角色觉醒校准、邮件状态和各类库存变化；
- `/load`、存档导入导出和数据库层可持久化 `all_active_mission_list`。

上述能力只构成安全的领奖与存储链。当前尚没有通用业务入口依据 `mission_active.json` 的 pattern 自动创建并更新
96 条任务进度；除存档导入或既有数据库记录外，`players_active_missions` 不会自行生成完整进度。因此 Active Mission
仍是部分完成，不能只因领奖接口可用就标记为完整。

## 后续实现原则

下一阶段按主数据 pattern type 分批接入权威服务端事实，并保持以下边界：

1. 只实现当前存档或正式请求能够证明的条件；缺等级曲线、战斗统计或客户端检查的数据继续 fail closed。
2. 事件开放期、前置任务和分组关系从 `mission_active.json`、`mission_active_event.json` 读取，不从中文文案推测。
3. 进度创建、增量、领奖和奖励发放保持幂等；领取接口继续以数据库进度为唯一依据。
4. 不修改客户端，不把旧 Active Mission 存储与 category 9 角色觉醒任务重新混用。
