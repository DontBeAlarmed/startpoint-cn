# 参考资料

本目录只保存可以公开维护的当前参考入口。原始路由抓包可能包含令牌、设备标识和已经过期的版本字段，因此当前树不再收录，也不作为 current 文档的一部分。旧提交中的历史样本不会因 HEAD 删除而消失，必须通过单独的历史清理流程处理，并将其中的凭据形态视为已经公开。

- [路由族覆盖矩阵](./routes-status.md)：按业务路由族记录当前服务端覆盖边界。
- [兼容空响应与未实现路由审计](./stub-route-audit.md)：区分合法空配置、兼容取舍、延期功能和能力声明矛盾。
- [帮助文本标尺审计（8 线）](./help-audit-stamina.md)：游戏内 [帮助] 官方文字教程与实现的对照审计；体系线：[扭蛋](./help-audit-gacha.md)、[共斗](./help-audit-multi.md)、[角色](./help-audit-character.md)、[装备强化](./help-audit-equipment.md)、[商店杂项](./help-audit-shop-misc.md)、[活动框架](./help-audit-event-campaign.md)、[战斗机制与覆盖缺口](./help-audit-battle-mechanics.md)。
- [客户端解析契约审计（6 文档）](./contract-audit-economy.md)：反编译客户端解析面与服务端响应面的逐字段比对；端点族：[会话](./contract-audit-session.md)、[单人战斗链](./contract-audit-quest-battle.md)、[角色成长链](./contract-audit-character-growth.md)、[共斗与社交](./contract-audit-multi-social.md)。
- [审计发现真机复现指南](./audit-repro-guide.md)：全部审计发现的设备级复现步骤与可测性分级。

实现协议时，以官方 CN 1.8.1 客户端反编译代码、当前注册源码和自动测试为主要依据。需要网络样本时，由开发者在本地自行准备并完成脱敏；样本不得包含真实账号、令牌、设备标识或其他可关联信息。
