# Server Bundle v3

Server Bundle 是不携带 Node、原生依赖和运行状态的可验证服务端代码包。默认构建到 `dist/server-bundle`：

v3 在 v2 的必需依赖锁身份上增加 `startup.localPrepareEntry`，使宿主可以在 local CDN 模式下直接监管“内容同步进程 -> 服务进程”，不需要把会再派生 Node 子进程的 wrapper 当作唯一受监管进程。嵌入式运行契约仍是 v1；这里的版本只描述 Server Manifest/Bundle 格式。

```bash
npm run build:bundle
npm run verify:bundle
npm run pack:bundle
npm run verify:bundle -- /path/to/server-bundle --data-schema 24
npm run verify:bundle -- /path/to/server-bundle --dependency-lock sha256:<runtime-pack-lock>
```

`npm run pack:bundle` 依次构建、校验并打包，默认生成
`dist/starpoint-cn-server-bundle-<serverVersion>.zip`。也可以在已有的已校验 Bundle 上直接运行：

```bash
node tools/server-bundle/pack.cjs --bundle /path/to/server-bundle --output /path/to/releases
```

重复打包相同 Bundle 会成功复用字节完全一致的同名归档；同名归档内容不同时会拒绝覆盖。打包过程先生成唯一候选文件，再进行无替换发布。若归档已经提交但临时文件清理未完成，命令仍返回成功并给出只包含临时文件名的警告，操作者可在确认没有并发打包后处理该文件。

构建器收集 `out/`、业务基线 `assets/`、必需的 `web/dist/`，以及 `LICENSE`、`NOTICE`。它排除 TypeScript 增量状态、`assets/asset-patch/` 和 `.gitignore` 版本控制元数据，并且完全不读取 `web/public/`；fresh clone 中该目录不存在也不影响构建。`web/dist/index.html` 不存在或不是普通文件时构建失败，manifest 固定写入 `admin.required=true`；源码中存在遗留 `web/pages` 目录时也会明确拒绝构建。服务启动还会检查 `index.html` 实际引用的本地 `/admin/` 入口资源是否为普通文件，但不重复执行 Bundle 的全文件 SHA256 校验。

`dist/server-bundle` 是离线构建输出，不是 Supervisor 的 active Bundle 指针，也不能用于运行中热替换。构建和校验期间调用者必须独占源码输入或导入 staging，不能让其他进程并发改名、替换目录或文件。已有输出只有先通过当前完整 verifier 才会被构建器认作自身产物；早期契约 Bundle、伪造简化 manifest、混入个人文件或损坏目录都会被保留并拒绝覆盖。升级构建器后应由操作者移走旧离线产物再重新构建，不为生成目录维护跨契约迁移逻辑。Supervisor 应把验证完成的 Bundle 导入自己的不可变版本目录，再切换其管理的 active 指针。

`server-manifest.json` 使用递归键排序的 UTF-8 canonical JSON，并以换行结尾。`files` 按 POSIX 相对路径稳定排序，记录普通文件的字节数和小写 SHA256。manifest 自身不进入 `files`，避免摘要递归；`bundleId` 是移除 `bundleId` 后 canonical manifest 的 SHA256。`requires.dependencyLock` 是构建输入 `package-lock.json` 原始字节的 SHA256；Runtime Pack 必须用同一 lock 执行 `npm ci --omit=dev`，Supervisor 再通过 verifier 的 `--dependency-lock` 做依赖锁兼容校验。Node ABI、平台、CPU 架构和原生模块仍由 Supervisor 按 Runtime Pack manifest 独立校验。

verifier 仅依赖 Node 内置模块和独立 canonical JSON 小模块。它会重新遍历 Bundle，并把 `out`、`assets`、`web/dist`、`LICENSE`、`NOTICE` 作为唯一允许的文件集合；即使伪造的 manifest 与额外文件彼此自洽，`web/public`、`web/pages`、`node_modules`、数据库、内容状态、CDN、APK、`asset-patch`、漫画和增量编译状态仍会被拒绝。它同时拒绝未知字段、不安全或重复路径、错序清单、符号链接、特殊文件、文件集合差异、摘要错误、`admin.required` 不为 `true`、缺少 admin 入口，以及不兼容的 runtime API、Node、Runtime Pack dependency lock 或可选数据 schema。发布契约锚点由下方 `release-contract` 块集中校验。

manifest `ports` 是随发布契约下发的默认值，不是运行时授权或实际监听结果。部署环境可通过服务端支持的环境变量覆盖监听地址和端口；Supervisor 和客户端应以服务启动后的 `RuntimeConfig`、健康输出或部署配置为准，不得直接把 manifest 端口当作运行中的 HTTP、TCP 或 Hub endpoint。

v3 固定 `entry=out/cn-server.js`，并固定 `startup.localPrepareEntry=out/content/sync/entry.js`；两个入口都必须出现在 `files` 中。准备入口是编译后的生产 CLI，只执行一次 Content Sync 并以退出码报告结果，不启动 HTTP/TCP 服务。Supervisor 仅在 `ASSET_MODE=local` 时运行它，并在确认退出码为 `0` 后直接启动 `entry`。v2 Bundle 仍可用于 `client-owned` 和 `remote`，但不能声明 local 已具备受支持的嵌入启动流程。

漫画是宿主或部署者另行准备的外置本地内容。普通开发默认读取项目根 `web/public/comic/`；嵌入模式必须通过绝对 `COMIC_DIR` 显式挂载，未配置时漫画接口返回空列表或 404。该目录不作为通用 `/public` 静态根，也不进入 Server Bundle。

Server Bundle 的可验证形态和格式权威始终是目录。ZIP 只是跨设备导入容器，不替代 `server-manifest.json` 或解包后的 verifier。Launcher 只接受专用的 `starpoint-cn-server-bundle-<serverVersion>.zip`；GitHub 自动生成的 `Source code.zip` 不是 Server Bundle，不能导入 Launcher。专用归档中必须恰好只有一个顶层 `server-bundle/`，其下内容与权威目录一致。解包安全规则、staging 和回滚顺序以[嵌入式运行契约](../embedded-runtime-contract.md)为准。

归档器只使用 Node 内置模块，不增加 npm 依赖，也不改变 Runtime Pack 的 `requires.dependencyLock` 身份。输出采用确定性的 ZIP32 STORE：文件按 UTF-8 路径排序，时间戳和权限元数据固定，内容不压缩。因此相同 Bundle 产生相同字节，但归档体积接近未压缩目录总大小。ZIP32 要求每个文件、中央目录偏移和归档总偏移均不超过 4 GiB 边界，并最多包含 65,534 个条目；超限时打包会在发布前失败。

```release-contract
{
  "serverManifestSchemaVersion": 3,
  "runtimeApiVersion": 1,
  "currentDataSchema": 24,
  "serverEntry": "out/cn-server.js",
  "localPrepareEntry": "out/content/sync/entry.js",
  "adminPath": "web/dist",
  "bundledCdnCatalogVersion": "1.4.54",
  "supportedAssetModes": ["client-owned", "local", "remote"],
  "defaultPorts": { "http": 8001, "tcp": 8003, "hub": 8004 }
}
```
