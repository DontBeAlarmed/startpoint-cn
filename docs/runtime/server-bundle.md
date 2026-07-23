# Server Bundle v2

Server Bundle 是不携带 Node、原生依赖和运行状态的可验证服务端代码包。默认构建到 `dist/server-bundle`：

v2 将 `requires.dependencyLock` 设为必需字段，因此不会把缺少依赖兼容身份的早期 v1 manifest 当作合法候选。嵌入式运行契约仍是 v1；这里的版本只描述 Server Manifest/Bundle 格式。

```bash
npm run build:bundle
npm run verify:bundle
npm run verify:bundle -- /path/to/server-bundle --data-schema 4
npm run verify:bundle -- /path/to/server-bundle --dependency-lock sha256:<runtime-pack-lock>
```

构建器收集 `out/`、业务基线 `assets/`、旧版管理页和静态资源、可选的 `web/dist/`，以及 `LICENSE`、`NOTICE`。它完整排除 TypeScript 增量状态、`assets/asset-patch/` 和 `web/public/comic/`。`web/dist/index.html` 不存在时不会打包该目录，且 `admin.required=false` 仍是合法 Bundle。

`dist/server-bundle` 是离线构建输出，不是 Supervisor 的 active Bundle 指针，也不能用于运行中热替换。构建和校验期间调用者必须独占源码输入或导入 staging，不能让其他进程并发改名、替换目录或文件。已有输出只有先通过完整 verifier 才会被构建器认作自身产物；伪造简化 manifest、混入个人文件或损坏的旧目录都会被保留并拒绝覆盖。Supervisor 应把验证完成的 Bundle 导入自己的不可变版本目录，再切换其管理的 active 指针。

`server-manifest.json` 使用递归键排序的 UTF-8 canonical JSON，并以换行结尾。`files` 按 POSIX 相对路径稳定排序，记录普通文件的字节数和小写 SHA256。manifest 自身不进入 `files`，避免摘要递归；`bundleId` 是移除 `bundleId` 后 canonical manifest 的 SHA256。`requires.dependencyLock` 是构建输入 `package-lock.json` 原始字节的 SHA256；Runtime Pack 必须用同一 lock 执行 `npm ci --omit=dev`，Supervisor 再通过 verifier 的 `--dependency-lock` 做依赖锁兼容校验。Node ABI、平台、CPU 架构和原生模块仍由 Supervisor 按 Runtime Pack manifest 独立校验。

verifier 仅依赖 Node 内置模块和独立 canonical JSON 小模块。它会重新遍历 Bundle，并把 `out`、`assets`、`web/pages`、`web/public`、可选 `web/dist`、`LICENSE`、`NOTICE` 作为唯一允许的文件集合；即使伪造的 manifest 与额外文件彼此自洽，`node_modules`、数据库、内容状态、CDN、APK、`asset-patch`、漫画和增量编译状态仍会被拒绝。它同时拒绝未知字段、不安全或重复路径、错序清单、符号链接、特殊文件、文件集合差异、摘要错误，以及不兼容的 runtime API、Node、Runtime Pack dependency lock 或可选数据 schema。只要 `web/dist` 出现任何文件，就必须同时存在 `web/dist/index.html`。
