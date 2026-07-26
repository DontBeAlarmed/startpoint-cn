# 项目支持矩阵

本表把四种证据分开记录：服务端代码是否存在、自动测试覆盖到哪里、CN 客户端或宿主是否人工验收、应以哪份 current 文档解释行为。自动测试通过不能替代客户端或宿主验收。

| 模块 | 服务端实现 | 自动测试 | CN 客户端 / 宿主验收 | 权威文档 |
|---|---|---|---|---|
| 运行时启动 | 基本完成：构建、资源模式、Content snapshot、HTTP/TCP 生命周期、信号退出和健康检查已接线 | 启动顺序、失败清理、信号和编译产物覆盖较强 | CN 客户端可登录和运行；资源模式组合仍需按部署环境复核 | [当前架构](../architecture.md)、[运行服务](../getting-started/README.md) |
| CDN Content Sync | 阶段 A：角色、卡池、商店由 CDN 动态转换；其他业务表继续使用 bundled `assets/` | 转换器、Release、Catalog、snapshot 和启动同步覆盖较强；真实完整 CDN smoke 为手工流程 | 官方 CN 1.4.54 基线可运行；Range、断点续传和不同部署模式待专项复核 | [Content Sync](../cdn/content-sync.md)、[运行支持边界](../cdn/runtime-support.md) |
| 账号与存档 | 设备绑定、多存档、默认存档、导入、导出和克隆已实现；完整性仍是部分完成 | 数据层和部分后台行为有覆盖，缺少完整导入导出端到端矩阵 | 日常登录与存档选择有实际使用；完整导入、恢复和克隆仍待系统复核 | [存档与输入校验](../systems/save-validation.md) |
| 邮件 | 列表、单领、全领、后台定向发送已实现；主要装备、抽卡、商店、养成、任务和关卡成功写响应统一动态返回 `mail_arrived`，读取、stub 和非成功 `result_code` 响应不保证携带 | 附件规则、通知 helper、四类核心写响应接线和部分后台逻辑有覆盖，缺少全部支持类型与通知链路测试 | 若干附件问题已实测修复；当前 12 种支持附件、各业务响应后的未读刷新和异常回滚待完整验收 | [邮件](../systems/mail.md) |
| 管理后台 | React/Vite 新后台与旧后台并存，Web API 已接入；新后台为可选产物 | 后台构建、部分 API helper 与源码契约有覆盖，无完整浏览器交互测试 | 不属于 CN 客户端验收；手机、平板、电脑和破坏性操作人工验收未完成 | [管理后台](../admin/README.md) |
| 抽卡 | 核心抽取、票券、兑换、权重、CDN 卡池转换和装备动画已实现；部分特殊卡池、费用与角色动画仍不完整 | 权重、执行计划、票券、装备动画和转换器有覆盖 | 可抽取角色的数量与种类已验收；费用、保底、特殊卡池和角色动画待测 | [扭蛋赔率修复](../systems/gacha-odds-fix.md)、[卡池生成](../protocol/gacha-pool-generation.md) |
| 普通关卡 | 单人 start、finish、abort、体力、门票、奖励和进度已实现；自动连战体力耗尽使用非致命停止响应；同步结算与任务奖励共享事务，仍有分类分支待补全 | 入场、abort、active 恢复、自动连战停止判定和部分结算规则有覆盖 | 主线常用流程通过；自动连战耗尽提示与回到配队页待客户端确认 | [关卡入场道具](../systems/quest-entry-items.md)、[体力](../systems/stamina.md) |
| 多人联机 | NPC 建房、招募、TCP、开始与结算可用；真人匹配、部分战斗帧和多场景流程未完成 | 房间生命周期、清理、身份、房主状态和协议 helper 覆盖较强 | 基础 NPC 房主流程已有实际使用；重赛、昵称显示、TCP 中断完整矩阵待验收；真人双客户端流程缺少验收条件 | [多人联机协议](../protocol/multi-battle.md) |
| 土俑 | 分数、独立配队、累计奖励、动画所需字段、幂等和存档恢复已实现 | 资产、结算、奖励和配队有专项测试 | 已通过客户端验收 | [土俑累计分奖励](../systems/carnival-score-rewards.md) |
| 狂热激战 | 基础流程、独立配队、结算事务和常驻批次推测回退已实现 | 商店、事务、首次与重复通关有覆盖 | 全流程待客户端验收；推测回退缺少官方服务端证据 | [狂热激战](../systems/rush-event.md) |
| 无限演武 | category 27、评级、跨档奖励、事务和持久化已实现；履历端点仍为空 | 服务层与真实 Fastify/SQLite 事务覆盖较强 | 待客户端重新验收 | [无限演武](../systems/score-attack-event.md) |
| 战阵 | 本地三队 Raid、独立配队、start、权重推进、分关卡次数、summary 事件级累计击破奖励和 finish 已实现 | required kill、10 槽解析、阈值选择、重复 summary、事务回滚和状态持久化有专项测试 | 待客户端重新验收，重点确认奖励数量、动画和页面刷新 | [战阵事件级奖励](../systems/raid-event-overall-rewards.md) |
| 歼灭者讨伐战 | 房主解锁、门票预扣、abort 返还和重启恢复已实现 | 房主/成员身份与门票生命周期有覆盖 | 房主解锁已通过；成员不解锁降为低优先级；门票待验收 | [歼灭者解锁](../systems/boss-epuration-unlock.md) |
| 任务系统 | 部分完成：普通/每日/每周、收集、1127 条称号、805 条严格活动协力规则、344 条活动关卡/物品/竞速安全规则、Pass 三分类与等级奖励、觉醒已有；Active Mission 已有动态定义读取、开放/依赖/phase 判定、幂等结算、安全领奖核心、Contents Guide 首任务生产链，以及 38 个 pattern（83 条定义）的 `/load` 校准；其中 15 条回归定义仍需资格回调，其余 13 条定义未接入权威生产者；旧 939 条不安全空 selector 规则已移除，Attention 禁用 | QuestRange、活动关卡、累计物品、累计使用技能、累计获得锻造石、单次最高连击、累计冲刺、领主战累计通关、单人最高分、单人限时通关、挑战副本累计通关、ExpertSingle、WorldStory、Advent、Carnival 和 HardMulti 精确单关、指定角色信赖称号、第二玛纳板节点集合、累计体力、累计登录、章节主线与高难全通、练习关卡 SS、珍品商店购买、指定 Boss 超级难度、Active Mission 核心/领奖事务、Contents Guide 首任务、Main/Ex/WorldStoryEvent 任务完成、任务依赖、角色养成、玛纳节点和商店购买状态已有覆盖；其余 1363 条复杂活动谓词、回归资格、Active Mission 其余事实链与其他称号缺完整协议矩阵 | 觉醒核心时序已通过；严格活动规则、Pass、Active Mission、称号条件和其他未验收分类仍需客户端全流程测试 | [任务完成度审计](../systems/mission-completion-audit.md)、[Active Mission](../systems/active-mission.md)、[任务-关卡映射](../systems/mission-quest-mapping.md)、[修行之道](../systems/pass-card.md) |
| 角色觉醒 | 核心解锁与领奖时序已实现并解耦；144 条任务条件不能标记为全部正确 | 解锁、结算、刷新、迁移与幂等覆盖较强；部分条件缺真实端点测试 | “完成后立即解锁、回第一页领奖”的核心时序已通过；条件全集待复核 | [角色觉醒任务](../systems/character-awake-missions.md)、[刷新与解锁时序](../systems/character-awake-refresh.md) |
| 角色与装备养成 | 广泛实现；角色分解、特殊装备升级和追忆装备阶段强化已修复 | 角色 stack、装备强化和库存规则有专项测试 | 上述三个重点流程已通过；其余养成尚无统一验收矩阵 | [角色分解审计](../systems/character-stack-audit.md)、[装备强化审计](../systems/equipment-upgrade-audit.md) |
| 嵌入式运行契约 | 契约 v1、Bundle v2、Data Volume、生命周期和健康接口已实现 | manifest、Bundle、配置、健康与生命周期覆盖较强 | 不属于 CN 客户端验收；真实 Android 或桌面 Supervisor 集成待做 | [嵌入式运行契约](../embedded-runtime-contract.md)、[Server Bundle](../runtime/server-bundle.md) |
| NPC 昵称 | 轻量数据契约、校验、无放回抽样和房间内稳定绑定已实现 | 校验器和抽样器有专项测试 | 客户端昵称显示、重赛稳定性和重名体验待验收 | [NPC 昵称贡献](../systems/npc-contributor-names.md) |

更细的未解决项见[已知问题](./known-issues.md)，人工验收顺序见[测试进度](./test-progress.md)，业务路由概览见[路由族覆盖矩阵](../reference/routes-status.md)。
