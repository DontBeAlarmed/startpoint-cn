# Runtime Pack v1

Runtime Pack 是低频更新的 Node 运行时和生产依赖包。它与 Server Bundle 分开发布；业务 JavaScript、后台页面或 `assets/` 变化时不需要替换 Runtime Pack，Node、Node ABI、原生模块或生产依赖变化时必须发布新的 Runtime Pack。

## 标准布局

```text
runtime-pack/
  node/
    bin/node
    lib/                 # Node 运行时及共享库
  node_modules/          # npm ci --omit=dev 的生产依赖
  runtime-pack-manifest.json
```

Runtime Pack 只能包含 `node/`、`node_modules/` 和 manifest；不允许符号链接、特殊文件、数据库、CDN、日志或 Server Bundle。构建器应在发布前将依赖安装结果复制为普通文件，并记录需要由宿主设置可执行权限的文件。

## Manifest

`runtime-pack-manifest.json` 使用递归键排序的 UTF-8 canonical JSON，并以换行结尾。manifest 不进入 `files`，`runtimeId` 是删除 `runtimeId` 后 canonical manifest 的小写 SHA-256：

```json
{
  "schemaVersion": 1,
  "runtimeId": "sha256:<manifest-content-digest>",
  "runtimeApi": 1,
  "node": {
    "version": "20.12.2",
    "abi": "115",
    "platform": "android",
    "arch": "arm64"
  },
  "dependencyLock": "sha256:<package-lock digest>",
  "entry": "node/bin/node",
  "executables": ["node/bin/node"],
  "files": [
    {
      "path": "node/bin/node",
      "bytes": 12345678,
      "sha256": "<lowercase file digest>"
    }
  ]
}
```

必需字段和规则如下：

- `schemaVersion`、`runtimeApi` 当前必须分别为 `1`、`1`；宿主遇到不支持的主版本必须拒绝导入。
- `runtimeId`、`dependencyLock` 使用 `sha256:<64 位小写十六进制>`；`dependencyLock` 是构建输入 `package-lock.json` 原始字节的摘要。
- `node.version` 是完整的 `major.minor.patch`，`node.abi` 是 `process.versions.modules`；`platform` 和 `arch` 是构建 Node 报告的 `process.platform`、`process.arch`。
- `entry` 当前固定为 `node/bin/node`。`executables` 是稳定排序、无重复的 POSIX 相对路径列表，必须包含 `entry`；宿主解包后应为这些文件设置可执行权限。
- `files` 按 UTF-8 字节序稳定排序，每项记录 POSIX 相对路径、字节数和小写 SHA-256。路径不能是绝对路径、包含 `..`、反斜杠、空段或符号链接。

服务端 Bundle 的 `requires.runtimeApi`、`requires.dependencyLock` 必须分别与 Runtime Pack 的 `runtimeApi`、`dependencyLock` 一致。Android 可行性验证固定使用一个完整 Node 20 版本和目标 ABI；版本或 ABI 变化必须重新构建整套 Runtime Pack。

## 校验

仓库提供不依赖构建器的校验器：

```bash
npm run verify:runtime-pack -- <RUNTIME_PACK> \
  --platform android \
  --arch arm64 \
  --node-abi 115 \
  --dependency-lock sha256:<package-lock digest>
```

校验器验证 canonical manifest、Runtime Pack 文件集合、路径安全、文件大小和摘要，并可验证平台、CPU ABI、Node ABI、Runtime API 和依赖锁兼容性。Launcher 必须在执行 `node/bin/node` 前完成等价校验。
