# 账号管理与继承码

## 范围

本模块实现的是服务端的账号生命周期和客户端已有的“继承”协议，不是官方账号登录系统。
当前客户端启动时仍以设备码作为身份入口，默认 `DeviceCodeIdentityProvider` 负责把设备映射到本地账号；将来如果接入官方账号或自制账号，只替换身份提供者，不需要改动玩家、存档和清理业务。

继承码也不改变普通登录优先级，不把继承码当作高于设备码的常规登录身份。它只在客户端明确调用 `/take_over/*` 流程时，把当前设备上的旧存档迁移到目标账号。

## 架构

```text
客户端设备码
      |
      v
DeviceCodeIdentityProvider -------> accounts <------ 未来 AccountIdentityProvider
                                      |
                         +------------+------------+
                         |                         |
                   players / sessions       cleanup policy
                         |                         |
                   device_bindings       AccountCleanupService
                                                   |
                                  自动清理 / 管理端手动清理

客户端已有继承协议
      |
      v
takeOver routes -- 校验目标账号/密码/当前设备 -- 单事务迁移 -- transfer audit
```

`accounts` 是身份和生命周期的边界；`players` 是账号下的存档。`device_bindings` 仍保留为当前客户端兼容所需的设备来源映射，但设备名称从现在起只作为向后兼容的管理入口，并同步写入账号级 `admin_note`。

## 账号清理

新账号默认使用 `cleanup_policy=retain`，不会因为没有备注而自动删除。服主可以在全局设置中选择 `delete_after_timeout`，并配置超时时间；三天只是示例默认值，不代表游戏业务规则。

账号备注是保留标识：

- 有备注：自动清理不会删除；
- 无备注且策略为 `delete_after_timeout`，并且当前时间已经超过 `cleanup_due_at`：自动删除；
- 策略为 `retain`：始终保留。

这里不增加额外的“活跃会话冲突”阻断。服主明确选择自动删除后，删除风险由服主负责；服务端只保证删除事务、级联数据和审计记录的一致性。自动清理服务启动时执行一次扫描，之后每分钟扫描一次。

删除在一个 SQLite 事务中完成：先写 `account_cleanup_audit`，再删除账号，由外键级联删除会话、设备映射和玩家领域；事务成功后清理进程内默认存档和活动存档选择。管理端提供全局设置、单账号标识/策略、立即扫描和手动删除接口。

## 继承流程

服务端兼容客户端已有的以下接口：

- `/take_over_register/get_take_over_setting`
- `/take_over_register/register_take_over_data`
- `/take_over/get_user_data_by_take_over_data`
- `/take_over/take_over_by_take_over_data`

密码只保存 bcrypt 哈希，客户端请求中的密码不写入日志。迁移时服务端重新检查目标账号、密码、当前 viewer 会话、设备映射和请求 `udid`，避免预览与正式提交之间使用过期判断。

迁移语义：

1. 当前设备上的旧账号是目标账号之外的源账号；
2. 目标账号保留其自身存档，源账号存档迁移到目标账号的身份上下文；
3. 源账号有 `admin_note` 时保留账号和玩家，但删除旧设备映射及旧会话，并标记为 `orphaned`；
4. 源账号没有 `admin_note` 时删除源账号及其玩家，写入迁移审计；
5. 新设备映射指向目标账号，旧目标设备会因 `takeover_udid` guard 被拒绝，直到重新走正常设备绑定流程。

源账号的“保留”只表示数据保留，不表示它还能继续登录；死账号的后续清理规则属于未来账号清理扩展，本阶段不实现。

继承完成后写入 `account_transfer_audit`。删除源账号、移动设备映射、清理旧会话、更新目标继承设备标识和写审计必须属于同一个事务；事务失败时不留下半完成迁移。

## 管理接口

管理 API 挂载在 `/api/server`：

| 接口 | 用途 |
|---|---|
| `GET /accountCleanup` | 查看全局策略和账号清理摘要 |
| `POST /accountCleanup/settings` | 设置默认策略与超时时间 |
| `POST /accountCleanup/account` | 设置单账号备注和清理策略 |
| `POST /accountCleanup/run` | 立即执行一次到期扫描 |
| `POST /accountCleanup/delete` | 服主明确指定账号并立即删除 |
| `POST /device/rename` | 保留旧兼容接口，同时同步账号备注 |

服务端不提供后台账号鉴权；公网暴露、反向代理和访问控制由服主负责。客户端没有继承入口时，不要求服务端为其恢复菜单；接口存在只是为了兼容已有或修改过的客户端。

## 数据版本

账号生命周期字段和两张审计表随数据库 schema 17 创建。旧数据库启动时会补列、补表，并把已有设备备注中最近一次非空值迁移到账号备注；没有备注的旧账号保持默认 `retain`，不会因为升级自动删除。
