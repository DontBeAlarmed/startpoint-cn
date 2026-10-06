# 专项交接：防御机制死锁残留自愈（服务端侧）

> 状态：待执行
> 范围：仅 `starpoint-cn` 仓库。壳（worldflipper-cn-launcher）已另行完成自身六项自愈修复，壳侧只对 sync.lock 做了冷启动清障兜底，**治本仍在本文档**。
> 背景事故：2026-10-07 05:46，壳内服务启动报 `CONTENT_SYNC_LOCK_TIMEOUT`（pid 32745）：启动器重装 APK 杀死正在执行内容同步的进程，`sync.lock` 残留，此后每次启动空转超时失败，需 `adb shell run-as … rm` 人工删除。事故后对两仓做了全量防御机制审计，本文档是审计中服务端结论的执行交接。
> 关联先例：`src/multi/hub/credential-lock.ts:108,179-183` 已实现 `isProcessAlive` + stale 接管——本专项 S1/S2 即要求 sync.lock 补齐同类能力。

## 一、sync.lock 设计分析

### 必要性（不是过度设计）

content sync 是长时、重 IO、整体重写 `state/content/`（`current.json`、catalog、关卡派生表）的操作。并发方在真实部署形态下存在：

1. 服主误操作双开两个服务进程指向同一 `DATA_DIR`；
2. 服务运行中手动执行 `content:sync` / `patch-check` 类 CLI；
3. supervisor 快速重启时旧进程未死净、新进程已启动。

没有锁会产生撕裂的内容状态。壳形态进一步放大暴露面：内容准备进程每次启动必跑（`src/content/startup/bootstrap.ts:124-136`），而 Android 杀进程是日常。

### 真正的缺陷（按严重度）

1. **pid 写入锁记录却从不检活**（`src/content/sync/lock.ts:276` 写入、`lock.ts:329-334` 超时时仅把 pid 打进报文）。失败模式被设计成"宁可卡死等人删"，而不是"检测持有者已死则接管"。
2. **最常见崩溃窗口恰好落在自愈覆盖不到的分支**：SIGKILL 落在 `open(O_EXCL)` 与 `writeFile` 之间留下空锁文件，必然走进 `parseLockRecord` 的 `CONTENT_SYNC_LOCK_LEGACY` fail-closed 分支（`lock.ts:91-110`），即使将来加了检活也救不了空文件。
3. 硬化（`O_NOFOLLOW`、token 所有权、dev/ino 身份断言）与威胁模型不匹配——防的是攻击者，实际对手是误操作——但这部分不产生运维负担，与全仓 fail-closed 风格一致，**保留不动**。

## 二、修复清单（按 误触发频率 × 运维负担 排序）

### S1 sync.lock 增加 pid 检活 + stale 接管

- 位置：`src/content/sync/lock.ts:262-337`（等待主循环）、`:329-334`（超时分支）。
- 现状：等待期间只轮询睡眠直到超时，不读已有锁的 pid，不做存活探测，无任何接管路径。
- 方案：移植 `credential-lock.ts:108,179-183` 的模式——等待轮询中读锁记录，`process.kill(pid, 0)` 探测：`ESRCH`（进程不存在）且锁龄超过 stale 阈值 → 经既有 token/dev-ino 校验后 unlink 接管；pid 存活 → 继续等待。锁龄取锁文件 mtime（锁记录当前无时间戳；若加字段需处理 `schemaVersion` 兼容，优先 mtime 方案避免 schema 变更）。
- 误判方向论证（写进测试注释）：pid 探测的误判只会导致"不接管"（pid 被复用为无关进程时 ESRCH 不出现），不会误删活锁；接管失败回落到既有超时语义。
- 测试：死 pid + 锁龄超阈值 → 接管成功；死 pid + 新锁 → 等待到超时（阈值防误删）；活 pid（可注入 fake）→ 不接管；接管后原等待者正常获得锁。

### S2 空锁 / 崩溃残留锁自动清理

- 位置：`src/content/sync/lock.ts:91,97,110`（LEGACY 三处）、`:159`（symlink）、`:165`（非普通文件）。
- 现状：空文件、非当前 schema、垃圾内容一律 `CONTENT_SYNC_LOCK_LEGACY` fail-closed，等待结束后仍抛，不清理。
- 方案：**空文件（0 字节）**在等待超时后自动 unlink 接管（崩溃残留的唯一可靠特征）；非空但解析失败的内容同样在超时后接管 + WARN——本仓只有这一种锁格式，"格式冲突的另一个同步进程"在所有部署形态下不存在。**symlink 与非普通文件保持 fail-closed**（防攻击底线不动）。
- 测试：空锁 → 超时后接管；垃圾内容锁 → 超时后接管 + WARN；symlink → 仍拒绝；接管路径不绕过 NOFOLLOW/dev-ino 校验。

### S3 credential-lock 过度硬化收敛

- 位置：`src/multi/hub/credential-lock.ts:58`（mode≠0600 一票否决且无修正）、`:138-139`（`Atomics.wait` 同步阻塞事件循环最长 5s）、`:145,191-196`（SIGKILL 残留 `*.lock.<pid>.<rand>.tmp` 候选文件无清扫）。
- 方案：
  - mode 校验改为 `fchmod(0600)` 尽力修正，修正失败才维持 UNSAFE——部分 Android 存储/备份恢复会丢权限位，现状是凭据增删**永久 500**；
  - 持锁 finally 中清扫本 pid 的候选 tmp 文件；
  - `Atomics.wait` 改造为事件驱动超出本专项范围，记录为已知问题即可。
- 不做：embedded 模式退化为进程内互斥（架构变更，收益低；CLI `multi:token` 与运行中服务并存时跨进程锁仍有真实价值）。

### S4 hub credentials 损坏后的显式恢复路径

- 位置：`src/multi/hub/credential-store.ts:64-66,266-283`（readTable 任何字段不合规即抛）、`credential-reloader.ts:95-103`（运行中拒载新快照）。
- 现状：表文件损坏后 `create`/`revoke` 都先 readTable → 管理端自身也无法重建，唯一出路是手工修文件；host 带空快照启动还会拒掉所有 client 节点认证。
- 方案：`npm run multi:token -- rebuild` 子命令：损坏（或管理者显式确认）时把现有文件改名留存（如 `multi-hub-credentials.json.corrupt-<ISO时间戳>`），再从空表重建。已分发令牌全部失效，需重新分发——命令输出必须提示这一点。
- 明确不做自动重建：静默清空安全敏感文件不可接受，fail-closed 判定本身保留。

### S5 server-time legacy offset 读取降级

- 位置：`src/runtime/server-time/store.ts:142-157`（本体 fail-closed，**保留**）、`:159-186`（`readLegacyOffset`：旧版 `active_account.json` 损坏 → 启动中止）。
- 方案：legacy 文件损坏 → WARN + 视为不存在（该偏移本就允许为 null）；一次性迁移提示不值得启动一票否决。本体 `server-time.json` 的 fail-closed 是反作弊底线，不动。
- 测试：legacy 文件垃圾内容 → 启动继续 + WARN；本体损坏 → 仍拒绝。

### S6 一次性迁移 tmp 固定名 + 清理失败即启动失败

- 位置：`src/runtime/data-paths.ts:145-162,193-226`（`.active_account.json.migrate.tmp` 固定名；`cleanupTemporaryFile` unlink 失败 → throw → `prepareDataVolume` 失败）。
- 方案：tmp 改唯一名（pid/随机后缀），清理失败降级 WARN 继续，不阻塞启动。严重度低，可与 S5 同批完成。

## 三、验收

- 每项带新测试；`src/content/sync`、`src/multi/hub`、`src/runtime` 既有套件全绿；`npm test` 全量通过。
- S1/S2 落地后的验收场景：启动器重装 APK 杀死同步进程 → 下一次启动自动接管残留锁，零人工恢复；独立部署 `kill -9` 同理。
- 契约不回退：全部安全硬化（NOFOLLOW、token、dev/ino、原子写）保留；`CONTENT_SYNC_LOCK_*` 错误码对既有调用方兼容（LEGACY 分支语义收窄为"仅 symlink/非普通文件"时，确认没有调用方依赖旧文案）。

## 四、审计确认必要、明确不动清单

- hub `IdempotencyCache`、`NodeSessionRegistry` TTL sweep、房间/弃战清扫、重连租约、`AdmissionRegistry` TTL——全部内存态、重启即清，防护 host/client 形态下真实的网络掉线场景；
- `CredentialReloader` 1s 指纹轮询——支撑"手改凭据文件即时吊销泄漏 token"的文档化运维动作，fail-safe 且不阻塞；
- `ContentObjectStore` 摘要/NOFOLLOW/dev-ino 记忆、digest-cache、gacha-seed-quarantine 的原子写+容错解析——防内容损坏底线，天然自愈；
- server-time 本体 fail-closed（反作弊底线）；hub credentials fail-closed 判定（S4 只加恢复路径）。

## 五、壳侧已完成（供参考，不在本仓）

launcher `dev`（5814a76 起）已落地六项自愈：冷启动清除自身 `server-data` 下残留 `sync.lock`、SPAWNING 租约自愈、租约 pid 复用发布 EXITED、损坏 update journal 降级、CDN 指纹失败诊断、快照 staging 启动清理、进程收割调度简化。这些只覆盖壳形态；独立部署的残留锁仍需本文档 S1/S2 治本。
