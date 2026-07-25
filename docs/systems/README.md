# 游戏系统文档

本目录描述当前业务语义、持久状态和客户端对齐结论。系统行为变更时，应更新对应文档；路由族概览见[参考资料](../reference/README.md)，原始抓包仅在本地脱敏保存。

## 核心系统

- [体力](./stamina.md)
- [商店](./shop.md)
- [邮件](./mail.md)
- [存档与输入校验](./save-validation.md)
- [漫画](./comic.md)

## 关卡与活动

- [特殊关卡架构](./special-quest-architecture.md)
- [战阵事件级奖励](./raid-event-overall-rewards.md)
- [狂热激战](./rush-event.md)
- [土俑累计分奖励](./carnival-score-rewards.md)
- [无限演武](./score-attack-event.md)
- [歼灭者讨伐战解锁](./boss-epuration-unlock.md)
- [活动扭蛋箱](./box-gacha.md)
- [关卡入场道具](./quest-entry-items.md)

## 任务与角色

- [任务完成度审计](./mission-completion-audit.md)
- [任务模块优先补全设计](./mission-priority-completion.md)
- [任务系统后续路线图](./mission-roadmap.md)
- [Active Mission](./active-mission.md)
- [任务模块待审阅实现记录](./mission-implementation-assumptions.md)
- [修行之道（Pass Card）](./pass-card.md)
- [任务与关卡映射](./mission-quest-mapping.md)
- [角色觉醒任务](./character-awake-missions.md)
- [角色觉醒刷新](./character-awake-refresh.md)
- [角色分解审计](./character-stack-audit.md)

## 装备、抽卡与内容修复

- [装备强化审计](./equipment-upgrade-audit.md)
- [扭蛋赔率修复](./gacha-odds-fix.md)
- [早期活动代币修复](./event-currency-fix.md)
- [NPC 昵称贡献](./npc-contributor-names.md)

文档中的“已实现”只描述服务端代码状态；是否通过官方客户端验证，以[测试进度](../status/test-progress.md)为准。
