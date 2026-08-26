# 邮件系统

本文描述游戏内邮件列表与领取、管理后台发送目标、附件白名单和当前通知边界。管理页面本身见[管理后台](../admin/README.md)。

## 游戏内端点

| 端点 | 当前行为 |
|---|---|
| `/mail/index` | 按页返回当前存档邮件，默认每页最多 100 条 |
| `/mail/receive` | 在单一事务中校验并发放一封附件、写领取历史、标记 receive time |
| `/mail/receive_all` | 对请求 ID 去重，并在单一事务中完成全部附件、历史和领取标记 |
| `/history/receive` | 按 `page` 返回最近 7 天领取记录，固定每页 100 条，并返回该时间窗内真实总数 |

邮件是否未领取以 `receive_time = '0000-00-00 00:00:00'` 判断。领取记录会写入 `players_receive_history`。

单领和全领都以 SQLite 外层事务覆盖附件发放、`players_receive_history`、邮件领取时间和角色觉醒解锁响应。事务内读取一次权威 Player 前态，标准附件交给 RewardGrant owner 执行，专用附件复用同一前态；owner 不查询 Player，也不建立 plan savepoint。任一步骤异常会回滚整个请求；批量请求中的重复 `mail_id` 只处理一次，不会重复发奖。已经领取或不存在的 ID 仍计入 `already_mail_count`，不会使其他合法邮件失败。

`src/lib/mail-reward-grant.ts` 是邮件领域 adapter。它先校验同批全部有效邮件，再按请求中的有效邮件顺序建立一个标准奖励 plan。plan source 只含 `{ mailId, attachmentIndex }`；角色 `number > 1` 展开为多条 CHARACTER entry，其他标准附件各一条。source、RewardGrant 的 `joined_character_id_list`、`isNew` 和内部 `itemDeltas` 都不会进入邮件协议响应。

成功后每封邮件恰好写一条领取历史。奖励、专用余额、history、领取标记、角色觉醒解锁 reconcile 任一步骤失败，或角色不存在、余额超出安全整数范围时，错误都会离开最外层事务并回滚整次请求；批量中的不支持附件也会使全部有效邮件回滚。

领取历史页码从 1 开始；零、负数、小数或字符串页码会被拒绝。分页按 `create_time DESC, id DESC` 稳定排序，
记录查询和总数统计共享同一数据库读事务，避免并发写入时同一响应的列表与总数来自不同快照。

## 已支持附件

管理后台白名单与游戏领取分支当前共同覆盖 12 种。六种标准类型映射到 RewardGrant 公共类型；六种专用类型保留邮件领域写入，不扩展 RewardGrant：

| type | 附件 | 执行边界 |
|---:|---|---|
| 1 | 道具 | RewardGrant `ITEM` |
| 3 | 付费星导石 | 邮件专用 `vmoney` |
| 4 | 免费星导石 | RewardGrant `BEADS` |
| 5 | 角色 | RewardGrant `CHARACTER`，按 `number` 展开 |
| 6 | 装备 | RewardGrant `EQUIPMENT` |
| 7 | 星之粒 | 邮件专用 `starCrumb` |
| 8 | 免费玛纳 | RewardGrant `MANA` |
| 9 | 经验池 | RewardGrant `EXP` |
| 10 | 羁绊证 | 邮件专用 `bondToken` |
| 11 | Boss boost point | 邮件专用 `bossBoostPoint` |
| 12 | boost point | 邮件专用 `boostPoint` |
| 15 | rank point | 邮件专用 `rankPoint` |

`MailType` 枚举还定义了 13、14、16、17，但后台不允许发送，游戏领取也没有对应发奖分支，因此不属于当前支持类型。存档中若因旧数据或手工写入出现不支持类型，领取接口返回明确错误并保留未领取状态，不再把邮件静默标记为已领取。

`type_id` 只允许并要求用于道具、角色和装备；其他附件带 `type_id` 会被拒绝，不会静默忽略。三类 ID 分别按当前道具、角色和装备资源集合校验。

角色和装备每封只能发送 1 个。普通道具附件数量使用当前 Content Snapshot 的 `item_max_count.json`，其权威来源是 `master/item/item.orderedmap` 的 `max_count` 字段；不再按 ID 范围推测。该校验只保证单封附件数量合法，不读取收件人背包，也不预演领取后的库存；超过玩家当前可持有空间时沿用客户端领取拦截，服务端不实现部分领取或溢出转存。其他资源使用 int32 安全范围。最终规则以 `src/lib/admin-mail-rules.ts` 为唯一事实来源。角色附件统一调用正常角色发放器：重复角色增加 `stack` 并发放对应重复素材，不再错误增加 `entry_count`。

领取响应继续使用旧字段：`user_info` 只包含本次涉及的余额字段，并返回提交后的绝对余额；`item_list` 对同一 ID 只保留数据库最终库存，重复角色补偿亦然；角色和装备列表沿用 RewardGrant 的稳定顺序与去重结果，再在原有时点执行 Awake unlock reconcile。响应不新增 RewardGrant source 或其他内部字段。

## 后台发送目标

`POST /api/mail/send` 支持：

1. `playerId`：只发送到指定存档；
2. `accountId`：发送到账号下全部存档；
3. 两者都不提供：发送到全部账号的全部存档。

同时提供两者时 `playerId` 优先。目标不存在或输入非法时拒绝请求。全服发送逐存档插入，不是跨全部收件人的单一事务；单个插入失败会跳过该存档并继续。

最近 20 条发送记录只保存在进程内，服务重启后清空，不属于审计日志。后台搜索使用道具、装备 lookup 和当前角色 Content snapshot 提供名称与 ID 匹配，不改变附件校验来源。

## `mail_arrived`

`/load`、`/mail/receive` 和 `/mail/receive_all` 会根据当前存档未领取邮件数动态计算 `mail_arrived`。装备、抽卡、商店、任务、关卡、角色/装备养成、兑换、活动扭蛋箱、队伍和解锁等主要成功写响应统一调用 `getMailArrivedSync(playerId)`，不再各自硬编码 `false`。其中经验注入、体力道具使用、商店体力恢复和装备保护设置也属于该范围。

该字段只表示响应时是否仍存在未领取邮件，不代表本次业务一定产生了邮件，也不代表客户端已经打开过邮件页。发送新邮件后，下一次带该字段的业务响应会看到动态状态；领取最后一封未领取邮件后，下一次响应会变为 `false`。

读取响应、尚未实现的 stub，以及携带非成功 `result_code` 的兼容错误响应不保证返回 `mail_arrived`。客户端将缺失字段视为不更新当前通知状态；这些响应不属于“主要成功写响应已统一”的范围。

## 领取查询边界

单封领取使用 `getPlayerMailSync(playerId, mailId, true)` 定点读取目标邮件，不再为了查找一个 ID 扫描最多 1000 封未领取邮件。`receive_all` 使用一次 `id IN (...)` 查询请求中的唯一 ID 集合，再复用已读到的邮件对象完成奖励和条件更新；因此不会对每封邮件再次执行状态查询。邮件领取仍由 `receive_time` 条件更新确认并发，状态变化会使最外层事务回滚。

本次优化保持列表分页接口不变，也保持重复、已领取和不存在 ID 的原有计数语义。默认混合基线中邮件入口仍为 0 错误、行为签名稳定、回滚验证通过；该小基线不是正式并发准入测试。

## 存档与恢复边界

V2 完整存档快照通过玩家领域 Registry 包含 `players_mails` 和 `players_receive_history`，导入、克隆与恢复会一并处理。旧 V1 快照明确标记为 `legacyPartial=true`，不会覆盖这些新领域，不能作为邮件完整备份。

`DELETE /api/player/:id/mail` 可以清空指定存档邮箱，用于误发非法邮件后的管理恢复。该操作不可撤销，且不会回滚已经领取的附件。

## 已知边界

- 12 种支持附件已有单领与混合批量的服务端协议 fixture；13、14、16、17 继续明确拒绝，不推测发奖语义；
- `mail_arrived` 已在主要成功写响应统一；读取、stub 和非成功 `result_code` 响应仍可能不携带该字段，且客户端提示刷新仍需逐类确认；
- 全服发送不是跨收件人事务，也没有持久审计历史；
- V2 已覆盖邮件，旧 V1 仍是部分恢复格式。

## 验证入口

主要相关测试：

- `tests/admin-mail-rules.test.js`；
- `tests/admin-mail-ui-source.test.js`；
- `tools/inventory_rules.test.cjs`；
- `tools/history_receive_route.test.cjs`；
- `tools/mail_notification.test.cjs`；
- `tools/mail_notification_write_routes.test.cjs`；
- `tools/mail_receive_transaction.test.cjs`；
- `tools/mail_reward_fixture.test.cjs`；
- `tools/mail_reward_grant.test.cjs`；
- `tools/mail_reward_owner.test.cjs`；
- `tools/mail_reward_rollback.test.cjs`；
- `tools/expod_inject_exp_route.test.cjs`；
- `tools/rush_event_shop_route.test.cjs`。

修改附件或领取逻辑后运行相关测试，模块提交前运行 `npm run verify:full`。
