# 运行服务

本目录是首次安装和日常启动的入口。当前支持官方 CN 1.8.1 客户端与官方 CN 1.4.54 CDN；客户端、CDN 和漫画资源均需自行准备。

## 基本流程

以下流程使用默认的 `ASSET_MODE=local`：

1. 安装 Node.js 和项目依赖。
2. 将完整官方 CDN 放入 `.cdn/cn/`。
3. 从 `.env.example` 创建本地 `.env`，按运行环境填写监听和资源地址。
4. 按[客户端补丁说明](../../client-patch/README.md)修改登录与服务器地址。
5. 使用 `bash scripts/start-cn.sh` 前台启动。

```bash
npm install
cp .env.example .env
bash scripts/start-cn.sh
```

启动入口会先构建服务端。`ASSET_MODE=local` 时，bootstrap 先执行 `content:sync`，成功后再启动 HTTP 与 TCP 服务；`ASSET_MODE=remote` 或 `client-owned` 时不执行本地内容同步，按所选模式直接初始化并启动。

| `ASSET_MODE` | 启动行为 |
|---|---|
| `local`（默认） | 从本地 CDN 生成或复用 Content Release，再启动服务 |
| `remote` | 跳过本地 `content:sync`，使用配置的远程资源地址启动 |
| `client-owned` | 跳过本地 `content:sync`，不向客户端发布资源更新地址 |

## 可选管理后台

游戏服务不依赖新版后台。需要使用 `/admin/` 时，首次构建或 `admin/package-lock.json` 变化后执行：

```bash
npm run install:admin
npm run build:admin
```

## 延伸阅读

- [当前运行时架构](../architecture.md)
- [CDN 与内容](../cdn/README.md)
- [部署说明](../deployment.md)
- [客户端测试进度](../status/test-progress.md)
- [嵌入式运行契约](../embedded-runtime-contract.md)

出现 `H404` 表示端点尚未实现。资源版本或客户端校验错误应先按[CDN 排查手册](../cdn/debugging.md)核对支持边界和当前 Release。
