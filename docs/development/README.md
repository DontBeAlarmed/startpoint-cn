# 开发与验证

本目录保存对当前代码持续有效的开发约束和验证入口，不保存单次实施计划、临时执行步骤或已完成的重构过程。

- [验证工作流](./verification-workflow.md)：测试分组、变更选择、提交前验证与性能基线。
- [当前运行时架构](../architecture.md)：模块边界、协议管线与持久化职责。
- [文档入口](../README.md)：current、reference 和 status 文档分层。

文档修改应运行 `npm run docs:check`。完整模块提交前仍以 `npm run verify:full` 为总入口；自动测试结果和 CN 客户端人工验收必须分别记录。
