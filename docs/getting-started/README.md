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
npm ci
cp .env.example .env
bash scripts/start-cn.sh
```

启动入口会先构建服务端。`ASSET_MODE=local` 时，bootstrap 先执行 `content:sync`，成功后再启动 HTTP 与 TCP 服务；`ASSET_MODE=remote` 或 `client-owned` 时不执行本地内容同步，按所选模式直接初始化并启动。

| `ASSET_MODE` | 启动行为 |
|---|---|
| `local`（默认） | 从本地 CDN 生成或复用 Content Release，再启动服务 |
| `remote` | 跳过本地 `content:sync`，使用配置的远程资源地址启动 |
| `client-owned` | 跳过本地 `content:sync`，不向客户端发布资源更新地址 |

## 管理后台

React 管理后台是服务端唯一管理界面，也是受支持构建和启动的必需产物。根目录 `npm ci` 会按同一份 `package-lock.json` 安装服务端与 `admin` workspace 依赖。标准 `build`、`bash scripts/start-cn.sh` 和 `npm run dev:cn` 都会通过 `build:server` 先生成后台；`npm run start:cn` 明确复用已有构建，适用于已经完成构建的部署目录。运行时会校验 `web/dist/index.html` 及其引用的本地入口资源。

```bash
npm ci
npm run build
```

缺少后台入口文件或入口引用的脚本、样式、图标时，服务端会在初始化阶段明确拒绝启动。`/` 和旧管理路径只重定向到 `/admin/` 下的对应 SPA 页面，不再提供旧 HTML。

## 网络范围

当前支持本机和受信任的局域网运行。监听地址、客户端可达地址与明确不支持的公网能力见[网络支持边界](./network-boundary.md)。管理后台不具备公网鉴权，不能直接作为互联网管理控制台使用。

## 延伸阅读

- [当前运行时架构](../architecture.md)
- [CDN 与内容](../cdn/README.md)
- [网络支持边界](./network-boundary.md)
- [可信多人 Hub 设置教程](../protocol/multi-hub-setup.md)
- [客户端测试进度](../status/test-progress.md)
- [嵌入式运行契约](../embedded-runtime-contract.md)

出现 `H404` 表示端点尚未实现。资源版本或客户端校验错误应先按[CDN 排查手册](../cdn/debugging.md)核对支持边界和当前 Release。
