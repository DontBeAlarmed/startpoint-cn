# 兼容空响应与未实现路由审计

本文记录会返回固定值、空对象或空列表的路由，区分“有意关闭的外围能力”和“仍缺少业务状态的真实桩”。它补充[路由族覆盖矩阵](./routes-status.md)，不把 HTTP 200 等同于功能完成。

## 分类规则

| 分类 | 判定标准 | 处理原则 |
|---|---|---|
| 关闭能力 | 私服明确不提供对应平台或运营能力，响应只负责让客户端安全跳过 | 返回关闭状态，不能同时宣告功能可用 |
| 空配置 | 服务端没有配置对应内容，空列表本身就是合法业务结果 | 保留空响应；以后由配置或后台内容驱动 |
| 兼容取舍 | 与官方持久状态不同，但项目明确采用更简单且可用的体验 | 必须在文档中说明，不能标记为完整对齐 |
| 延期功能 | 客户端存在真实流程，但当前服务端没有状态模型或执行逻辑 | 标记为 Stub 或 Missing，不用推测数据填充 |
| 实现矛盾 | 同一能力在不同入口的声明或状态不一致 | 优先修正声明；业务实现另立模块 |

## 可以保留的兼容响应

| 路由 | 当前行为 | 结论 |
|---|---|---|
| `/tool/check_social_link_enable` | 返回 `enable: false` | 社交账号绑定关闭，属于外围平台能力 |
| `/tool/contact_active` | 返回 `enable_customer_service: false` | 官方客服关闭，属于外围平台能力 |
| `/tool/custom_notify` | 返回空对象 | 当前没有自定义运营通知，空响应合法 |
| OpenAPI push token、heartbeat 等 | 接受请求但不维护推送平台状态 | 仅承担雷霆 SDK 登录兼容；不应描述为真实推送服务 |
| `/news/system_index`、`/news/latest_forced*` | 返回空系统公告或无强制弹窗 | 当前没有对应配置源时为空是合法结果；普通 `/news/index` 仍读取 `assets/news.json` |
| `/episode_trial_reading/finish` | 返回空对象 | CN 客户端请求只携带 `character_id`、`quest_id`，完成回调不合并持久字段；它是卡池角色剧情试读，不是普通角色剧情阅读记录 |
| `/patch/cn/recovery/empty.csv` | 返回恢复流程所需空文件 | CDN 恢复协议兼容资源，不代表缺少业务实现 |
| `/reproduce/post` | 接受后丢弃设备诊断日志 | 项目不收集玩家设备日志；属于隐私边界内的兼容接收，不是存档恢复能力 |
| 联机 `/micro_community` | 返回空对象，不发布到外部社区 | 外部社区关闭；本地房间不依赖该入口 |
| 联机 `/publish_room` | 返回 `success: false` | 客户端会读取该布尔值，不能用空对象伪造发布成功 |
| 联机 `/share_room` | 仅房主可调用并返回空成功对象 | 客户端成功回调不读取业务字段；本地 room number 和随机 token 由房间模块维护 |

## 空响应但业务已执行

以下路由的空对象或空数组是成功回调形状，不能因响应为空标记为 Stub：

| 路由族 | 空响应前已经完成的状态 |
|---|---|
| `/tool/get_header_response`、`/tool/signup` | 会话和公共头已生成；业务数据位于 `data_headers` |
| `/tutorial/finish_trigger` | 教程触发 ID 已校验、去重并在一个事务内持久化 |
| `/party_group/edit` | 编队组颜色在一个事务内写入，未知组不返回成功 |
| 战阵、狂热激战的 `/battle/start`、`/select_folder`、`/reset` | 活跃关卡、当前文件夹或已用队伍状态已经更新 |
| `/shop/set_campaign_lineup_id` | 选择结果已按玩家、商店、活动持久化并检查冲突 |
| `/character/set_illustration_settings` | 已校验六项数组与角色所有权后写入插画设置 |
| 联机 `/disband_room` | 已广播解散消息并清理房间；空对象只是 HTTP 确认 |

商店和自动连战的部分错误分支也会返回空 `data`，但同时通过 `data_headers.result_code` 传递客户端协议结果；
审计时必须同时读取响应头对象，不能只搜索 `data: {}`。

## 明确的兼容取舍

### 百科全部解锁

官方 CN 1.8.1 客户端把百科状态分为锁定、未读和已读。离开百科详情页时，客户端通过 `/encyclopedia/read_keyword` 提交本次阅读项；下一次进入百科时，`/encyclopedia/index` 应重新返回持久化后的 `read` 状态。

当前服务端的 `assets/encyclopedia.json` 固定返回 1551 条 `read: true`，即采用“百科全部解锁且全部已读”的兼容体验。因此：

- `/encyclopedia/read_keyword` 回显 `read: true` 但不持久化，在当前策略下不会造成可见状态丢失；
- 该路由不能标记为官方语义完整实现；
- 只有决定恢复官方锁定、解锁和未读提示时，才应同时设计玩家百科表、解锁生产者、`index` 合并和存档 V2 覆盖；不能只持久化 `read_keyword`，否则会把当前可见内容错误锁回去。

百科表继续保留 bundled 来源，原因见 [Content Sync](../cdn/content-sync.md)。

### 付费兼容

`/payment/item_list` 返回空商品，表示私服不开放真实内购；雷霆支付查询路由只维持客户端 SDK 流程。与此同时，`/payment/finish` 仍包含按本地商品表增加付费石的模拟逻辑，并使用进程内购买次数。

这两种职责目前不一致。因为它不影响免费单人主流程，本轮不扩展支付系统；后续应单独决定“完全关闭支付”或“实现明确的本地模拟购买”，不能把现状写成完整支付能力。

## 已确认的延期功能

| 路由 | 当前缺口 | 优先级与依赖 |
|---|---|---|
| `/attention/action` | 只返回零分，没有真人匹配队列 | 低；依赖真人联机阶段，不影响 NPC 联机 |
| `/attention/logger` | 丢弃客户端 attention 日志 | 低；只有实现真人匹配诊断时才需要持久化 |
| `/event/raid/ranking` | 固定返回空排名 | 低；战阵本地三队流程可用，真实排行榜需要跨玩家聚合与周期快照 |
| `/event/raid/ranking/party` | 固定返回空队伍 | 低；依赖真实排行榜条目和其他玩家编队快照 |
| `/event/raid/ranking_reward` | 固定返回无奖励 | 低；依赖排行榜结算、幂等领取和奖励周期 |
| 礼包码兑换 | 没有兑换路由、配置、次数限制或领取状态 | 低；`load` 与 `/tool/check_enable_gift` 现已统一关闭入口 |

战阵排名接口不能用本地 NPC 数据伪造。排行、排行编队和排行奖励应作为同一个模块实现，不能分别填空列表来宣称完成。

## 本轮修正

`load` 原本返回 `enable_gift: false`，但 `/tool/check_enable_gift` 返回 `enable_gift: true`，会在礼包业务不存在时重新向客户端宣告入口可用。本轮统一为 `false`，只修正能力声明，不新增礼包系统。

普通剧情 finish 原本在事务外先发首通奖励，再写剧情进度；进度写入失败会留下重复领取窗口。它还遗漏
`story_join_character_id_list`，并让城镇领取接口直接接受任意角色 ID。本轮已按官方
`story_join_character` 区分剧情直加入与城镇领取，统一普通/跳过剧情的事务结算、重复请求对象响应、
`item_list` 和动态邮件通知。任务奖励时序的取舍见[普通剧情结算](../systems/story-quest-settlement.md)。

第二玛纳板原本没有服务端开放期门控，load 会把跨时间存档的板二索引直接发给当前只构造板一的客户端。
本轮已接入官方开放期表，对 load 显示索引做非破坏性降级，并阻止打开、学习和领取接口绕过开放期；详见
[第二玛纳板开放期](../systems/mana-board-availability.md)。

## 后续审计顺序

1. 支付边界：由项目职责决定完全关闭还是保留本地模拟，不在路由层继续堆叠兼容分支。

2026-07-28 对 `src/routes/` 与 `src/multi/` 的 198 个 Fastify 注册点完成空对象、空数组、TODO 和 Stub
复扫。除上表新增的外围关闭能力外，没有发现新的“宣告可用但完全不写状态”核心单人路由；该结论不替代
客户端人工验收。

普通战斗关卡的剩余分类与事务复扫已经完成：单人通用分类和活动专用分支都在同一个 finish 总事务内；协力
结算同样覆盖奖励、进度、任务事实和 active quest 删除。提交后的队友资料查询只用于响应展示，单个查询失败会
记录警告并跳过该项，不再把已经提交的结算变成 HTTP 500。详细边界见[战斗关卡结算事务](../systems/quest-finish-transactions.md)。

练习战 finish 履历、查询和持久化已完成，手动 abort 的耗时证据缺口见[练习战履历](../systems/practice-battle-history.md)。
