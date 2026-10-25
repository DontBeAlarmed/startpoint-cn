# 开发与验证

本目录保存对当前代码持续有效的开发约束和验证入口，不保存单次实施计划、临时执行步骤或已完成的重构过程。

- [验证工作流](./verification-workflow.md)：测试分组、变更选择、提交前验证与性能基线。
- [已知问题台账](./known-issues.md)：只记录不修复的问题定位（现象/根因/触发链路/状态）。
- [全表列语义字典台账](./master-dictionary.md)：只记录不修复的问题定位（现象/根因/触发链路/状态）。
- [当前运行时架构](../architecture.md)：模块边界、协议管线与持久化职责。
- [文档入口](../README.md)：current、reference 和 status 文档分层。

文档修改应运行 `npm run docs:check`。完整模块提交前仍以 `npm run verify:full` 为总入口；自动测试结果和 CN 客户端人工验收必须分别记录。
