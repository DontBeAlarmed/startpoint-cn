# Startpoint CN 全面整改与资产治理设计

> 状态：方案 A 已批准，待书面规格复核
> 日期：2026-07-15
> 项目根：`D:\WF\startpoint-cn`

## 1. 目标

本轮整改解决两个相互关联的问题：当前项目的安全、存档和 CDN 基础链存在高风险缺口；角色创建、资源整理和发布又分散在大量目录、快照和工具中，导致新角色制作效率低、失败后难以判断问题位于哪一层。

最终状态必须同时满足：

1. LAN 服务不再暴露可越权读取或无鉴权管理能力；
2. 存档导入和角色发布均为失败可回滚的事务；
3. 从受支持客户端版本到当前版本的 CDN 更新路径可计算、可验证且不中断；
4. 无效资产由证据分类，先隔离、可恢复，首轮不永久删除；
5. 新角色统一通过现有 `character-pack-v1` 和原子发布链进入运行环境；
6. 测试、启动、CI 和文档能够阻止同类问题再次出现。

## 2. 当前基线与问题证据

设计基于 2026-07-15 的现场检查，实施前仍需生成一次机器可读基线：

- 当前分支为 `release/modes-20260714`；已有 4 个受用户控制的资产 JSON 修改、2 份未跟踪角色生成器文档和未跟踪 `work/`，全部视为受保护现状；
- `/patch/cn/asset-patch/active/:file` 将解码后的路由参数直接拼接到文件路径，现场编码穿越请求能够读取项目外层文件；
- CN 服务绑定 LAN 地址，`/api/server`、`/api/player`、`/api/mail`、`/api/seeds` 和 `/api/mod-admin` 未统一鉴权；
- `replacePlayerDataSync()` 先删除玩家，再执行多表插入，任一后续失败都会留下残缺或消失的存档；
- CDN 差分当前按目标版本分组，并把最大的旧差分目标误当成角色发布链唯一合法基点；角色链即使连接在一个可达的较早节点，也会被判为脱离；
- TypeScript 集成测试会读取真实 `assets/asset-patch/active`，测试夹具不能隔离现场资源；
- `.cdn/cn` 约 10.3 GiB，其中全量包承担首次安装恢复职责，不能因“旧”直接删除；
- `弹国服` 约 61.4 GiB，包含活动 store、压缩源、解压副本和可重新生成的 `restored*` 输出；
- `work/character_releases`、`work/ai_canary`、`mod-tools/work/char_snapshots` 和 `mod-tools/work/char_gen` 是当前回滚或角色制作材料，不属于无效资产；
- `.git` 松散对象约 28 GiB，但 Git 对象不是本轮资产隔离对象，需另行验证所有 worktree、refs 和 reflog 后才能维护。

## 3. 范围与硬边界

### 3.1 本轮包含

- P0 路径安全、后台鉴权、存档事务和 CDN 图修复；
- 可审计的资产扫描、计划、隔离和恢复工具；
- 对已证明可重新生成、完全重复或过期的资产执行首轮隔离；
- 角色包、运行时 staging、发布和回滚入口整合；
- 服务端、Python 工具、管理前端、启动脚本、CI 和操作文档的针对性补强；
- 整改后的全量离线测试和受控在线烟雾验证。

### 3.2 本轮明确不包含

- 不执行 M4，不修改或删除 `web/pages/`、`src/routes/web/`、`web/public/`；
- 不删除或迁移 `decompile/`、`ffdec_26.2.1/`、`pc-run/`、`instrument/` 等逆向工作区；
- 不把角色生成器改造成新的独立发布后端；生成器只作为角色包的上游生产者；
- 不在首轮永久删除隔离资产；
- 不运行 `git gc --prune`、repack 或其他 Git 对象清理；
- 不清空客户端数据、不强制全量重下、不替换用户账号或存档；
- 不自动提交当前已有的用户资产修改、角色生成器文档或 `work/` 内容。

## 4. 总体实施顺序

四个阶段必须顺序执行，上一阶段的验收证据写入 `work/remediation/<run-id>/` 后，下一阶段才能开始：

1. **P0 基础修复**：先封住安全和数据一致性风险，修通版本图；
2. **资产治理**：在可信引用图上分类、隔离并恢复验证；
3. **角色创建链整合**：以角色包为唯一发布输入，消除多入口直接写现场数据；
4. **工程收尾**：启动、CI、依赖、文档和最终烟雾验证。

任何阶段失败都停止后续阶段，不以“部分通过”冒充完成。

## 5. 阶段一：P0 基础修复

### 5.1 安全文件访问

新增一个只负责“受控根目录下固定格式文件”的路径模块，供两个补丁下载路由复用。规则如下：

- active patch 的 `file` 只能是单个 ZIP 文件名，拒绝绝对路径、斜杠、反斜杠、空段、`.`、`..`、双重编码后的路径分隔和非 ZIP 后缀；
- production upload 的 `prefix` 必须是两位十六进制，`hash` 必须符合实际 store 哈希格式；
- 路径经 `resolve`、`relative` 和真实路径检查后必须仍在允许根目录内；
- 拒绝符号链接、junction 或其他会把最终文件指向根目录外的重解析路径；
- 非法路径统一返回 404，不返回磁盘路径或内部异常；
- 文件读取改为异步打开和流式响应，避免同步读取大 ZIP 阻塞事件循环。

测试至少覆盖普通文件、编码 `../`、双重编码、Windows 反斜杠、绝对盘符、UNC、同名前缀逃逸、符号链接/junction 和合法 ZIP。

### 5.2 管理面统一鉴权

游戏 API `/api/index.php/**` 保持现有雷霆鉴权，不并入后台会话。管理面保护范围为：

- `/api/server/**`
- `/api/player/**`
- `/api/mail/**`
- `/api/lookup/**`
- `/api/seeds/**`
- `/api/mod-admin/**`
- 旧管理页面的页面路由

新增 `/api/admin-auth/login`、`session` 和 `logout`。浏览器登录成功后获得 `HttpOnly`、`SameSite=Strict` 的短期会话 Cookie；启用 HTTPS 时同时设置 `Secure`。命令行和自动化可使用 `Authorization: Bearer <CN_ADMIN_TOKEN>`。令牌不得写入前端 bundle、日志、Git 或 `localStorage`。

启动规则采用安全默认值：

- 非 loopback 监听时，缺少或强度不足的 `CN_ADMIN_TOKEN` 直接拒绝启动；
- loopback 无令牌模式也必须由显式 `CN_ADMIN_ALLOW_INSECURE_LOOPBACK=true` 开启；
- 比较令牌和会话签名使用恒定时间比较；
- Cookie 请求的写操作必须通过同源 `Origin`/`Referer` 校验；Bearer 请求不依赖浏览器 Cookie；
- 登录失败限速，响应不区分“令牌不存在”和“令牌错误”。

配套脚本使用系统加密随机源生成至少 32 字节令牌，只追加到已被 Git 忽略的本地 `.env`，不覆盖其他变量；终端仅显示配置文件位置和令牌指纹，不回显令牌本体。脚本同时把文件 ACL 收紧到当前用户和系统账户。

旧后台文件保持零改动。旧页面在同源登录 Cookie 存在时继续工作；现有带副作用 GET 路由暂时保留为“已鉴权兼容入口”并记录弃用日志，新 React 后台一律使用 POST。彻底移除兼容 GET 属于后续 M4 决策。

### 5.3 存档替换事务

存档导入流程分为三步：

1. 在数据库写入前完成 JSON 结构、玩家 ID、账号归属、必需集合、主键重复和引用一致性校验；
2. 在单个 `better-sqlite3` 同步事务中执行删除旧玩家和全部新数据插入；
3. 提交后重新读取关键表并核对玩家 ID、账号 ID 和集合计数。

事务内不包含网络、文件或异步操作。任何删除后故障、约束错误或读回不一致都触发自动 rollback，原存档的逐表内容保持不变。导入端点只在事务成功后返回成功，不把解析成功当作导入成功。

故障注入测试必须在玩家主表删除后、角色插入中途和最后一张表写入前分别抛错，并证明旧存档仍完整存在。

### 5.4 CDN 差分图

差分单位从“按目标版本的一条记录”改为 `ReleaseEdge(from, to, archives[])`。旧 CDN 差分、`assets/asset-patch/active` 和 `character-releases/active.json` 都转换为边，再按 `(from, to)` 合并归档；不得只按 `to` 合并，因为那会吞掉分支来源。

图构建规则：

- 版本必须严格递增，拒绝自环和回退边；
- 同一 `(from, to)` 的 common、medium、android 和 asset-patch 归档合并、去重并稳定排序；
- 角色 `active.json` 继续验证字段、连续版本、文件名、大小和 SHA-256；
- `active.json.base_version` 只需是旧差分图中从受支持基线可达的节点，不再要求等于最大的旧差分目标；
- 对每个请求的 `res_ver` 计算最高可达目标，并返回到该目标的确定性最短路径；版本相同时按边数和稳定字典序决胜；
- 首次安装从 full 包声明版本计算可达路径；已有客户端从自身 `res_ver` 计算；
- `/load` 的 `available_asset_version` 和 `/asset/get_path` 的目标版本必须使用同一图快照；
- 无路径时不得虚报更高版本，健康检查必须明确报告断点、孤立边或损坏归档。

受支持基线由 `CN_SUPPORTED_ASSET_BASES` 明确声明，并自动加入 full 包版本。当前部署的首次配置至少包含现场已观察到的 `1.4.102` 与 `1.4.133`；每次新增或移除基线都必须先通过图可达性测试。受保护的 `/api/mod-admin/cdn-health` 返回每个基线的路径、目标、断点和归档校验状态。

当前场景中，角色链可从 `1.4.133` 接入，并在相同 `(from, to)` 上与后续 legacy/asset-patch 归档合并。这样 `1.4.102 → 1.4.133 → … → 当前尾部` 成为一条完整路径，同时不会漏掉同版本上的其他补丁。

测试夹具必须注入临时 CDN 根和临时 asset-patch 根，禁止再读取真实 `assets/asset-patch/active`。覆盖线性链、分支、同边多归档、较早节点接入角色链、损坏 active manifest、缺失归档、孤立高版本和首次安装路径。

## 6. 阶段二：资产治理

### 6.1 工具与数据模型

新增 `mod-tools/wf_asset_maintenance.py`，提供以下子命令：

- `scan`：只读扫描显式配置的根目录；
- `plan`：按证据和保留策略生成计划，不移动文件；
- `quarantine`：只执行计划中可自动隔离的条目；
- `restore`：按清单恢复全部或指定条目；
- `verify`：隔离后核对哈希、引用图和项目测试；
- `purge`：保留命令接口，但首轮不执行。

每次运行生成唯一 `run_id`。隔离根固定为 `D:\WF\asset-quarantine\startpoint-cn-<run_id>`，其中保存：

- `manifest.jsonl`：原路径、隔离路径、类型、大小、SHA-256、mtime、原因、证据和动作状态；
- `summary.json`：分类数量、字节数、失败和保护项；
- `restore.ps1`：只调用工具的恢复入口，不自行拼接删除命令；
- `evidence/`：归档测试、成员清单、引用清单和验证输出。

同卷文件使用原子 rename。若未来改为跨卷隔离，则必须先复制、核对大小和 SHA-256，再删除源文件。扫描不跟随符号链接或 junction，Windows 深路径统一使用扩展长度路径处理。

隔离在同一 D: 盘只会整理项目目录，不会立即增加磁盘可用空间；只有后续经再次批准的 `purge` 才真正释放空间。

### 6.2 分类

每个条目只能进入以下一种分类：

1. `protected`：活动 store、全量 CDN、可达差分、数据库、有效发布快照、当前角色生成材料、逆向工作区；
2. `live_referenced`：被 profile、manifest、路径表、ZIP 成员、代码配置或当前发布图直接引用；
3. `exact_duplicate`：内容 SHA-256 完全相同，且保留位置有完整恢复来源；
4. `proven_regenerable`：生成脚本、输入和版本均存在，且重建抽样或全量验证通过；
5. `stale_cache`：`.pyc`、`__pycache__`、已结束进程的临时文件和空 staging；
6. `retention_expired`：超过明确保留策略且未被快照或发布记录引用的备份；
7. `corrupt`：归档测试、声明哈希或解码验证失败；
8. `unknown`：证据不足或用途不能证明。

首轮自动隔离仅允许 `exact_duplicate`、`proven_regenerable`、`stale_cache` 和 `retention_expired`。`corrupt` 只报告并保留，避免删掉唯一损坏但仍可能修复的来源；`unknown` 永不自动移动。

### 6.3 保留与隔离规则

必须保护：

- `弹国服/WorldFlipper` 的活动 production store；
- `.cdn/cn/archive-*-full`；
- 从 full 版本和受支持 `res_ver` 可达的全部差分边；
- `.cdn/cn/character-releases/active.json` 引用的归档和对应 snapshot/recovery；
- `work/character_releases`、`work/ai_canary`、`mod-tools/work/char_snapshots`、当前 `mod-tools/work/char_gen`；
- 当前数据库、显式数据库备份、角色包源、pathlist/CSV 路径映射和逆向材料。

首轮候选规则：

- `.pyc`、`__pycache__` 和空 staging 可直接进入隔离计划；
- `.bak-wfmod-*` 按目标文件分组，保留最新 3 份、最新一次成功发布之前的最后恢复点，以及被角色快照/发布日志引用的全部备份；其余才可标记 `retention_expired`；
- `restored` 与 `restored_readable` 只有在生成脚本、输入 store/bundle、路径映射和重建验证都存在时，才可标记 `proven_regenerable`；
- `弹国服/assets` 只有在 `assets.rar` 完整性测试通过、规范化成员清单的路径/大小/CRC 与解压树一致，并确认归档仍保留时，才可标记为解压重复副本；
- `单机版数据包.zip`、活动 store 和 `assets.rar` 之间不凭目录大小判断重复。必须证明成员清单和内容关系，并始终保留至少一个完整恢复源；
- 旧 CDN 差分只有在阶段一的图验证完成、支持基线明确且确认不再位于任何有效路径时，才可能进入后续人工清理计划；首轮不自动隔离。

### 6.4 隔离后的验证

隔离完成后必须重新运行：

- 资产维护工具 `verify`；
- CDN 图可达性和归档哈希检查；
- 角色包 preflight；
- Python 测试、TypeScript 测试和 typecheck；
- 数据库 `quick_check` 与外键检查；
- 服务启动和只读健康检查。

随后执行一次“恢复演练”：随机选取至少一个缓存条目、一个旧备份和一个大型生成目录，恢复后核对全量哈希，再重新隔离。恢复演练不通过则整批清理不算完成。

## 7. 阶段三：角色创建链整合

### 7.1 唯一发布契约

保留并强化现有 `mod-tools/wf_character_pack.py`、`schemas/character-pack-v1.schema.json` 和 `wf_release.py`，不再建立第二套直接写 live store 的生成器发布逻辑。

角色创建数据流固定为：

`模板/生成器工作目录 → character-pack-v1 → preflight → snapshot → isolated staging → semantic readback → 三根增量归档 → active.json 原子提交 → 客户端拉取验证`

GUI、脚本或后续 AI 生成器都只能生成或更新 package 工作目录；真正写 live roots 和 CDN 的权限只属于 `PackTransaction` 与 `AtomicReleasePublisher`。

### 7.2 一致性要求

新角色包必须声明并验证：

- 服务端 `assets/cdndata/*`、客户端 orderedmap 和服务端 `assets/character.json` 三层一致；
- 所有角色索引表均有预期键，包含普通表和 `character_image`、`mana_board` 等嵌套表；
- 跨表复制按目标表实际宽度适配，禁止盲目 padding；
- `character_status` 与 `character_awake_status` 使用各自真实列序；
- 嵌套 orderedmap 内层键序保持不变；
- `set_text_rows` 新键写入后必须读回证明真实落盘；
- 资源模板达到当前检查器定义的 37 个必要项（37/37）；缺少战斗技能预览等任一必要文件时不得标记 release-ready；
- 所有文件记录逻辑路径、大小和 SHA-256，发布包只包含实际变化的 common/medium/android/server 文件；
- package 的 `requires_client_base` 必须是阶段一 CDN 图中的可达节点；过期包必须显式 rebase，不能静默套到新现场数据。

现有未提交角色资产和 `work/` 被视为输入材料，不自动吸收到 package，也不在无明确 package claim 时写入发布链。

### 7.3 制作效率入口

角色包工具增加一个面向操作者的编排入口，但复用现有事务实现：

- `init`：按模板角色、新 ID 和 code name 创建隔离 package 工作目录，并列出三层表、嵌套表和 37 项资源矩阵；
- `status`：按内容哈希显示已完成、缺失、过期和需要重新生成的步骤；
- `preflight`：一次输出表宽、新键、三层一致性、资源和 CDN 基线问题；
- `publish`：调用现有 `PackTransaction` 与 `AtomicReleasePublisher`；
- `rollback`：基于 release snapshot 生成反向增量。

状态文件只记录输入哈希和产物哈希，因此中断后可从上次通过的阶段继续，未变化的 PNG、语音、orderedmap 和归档不重新处理。现有《角色生成器方案》作为上游内容生成设计保留；它交付 package 工作目录，不获得 live store 写权限。

### 7.4 失败与回滚

- preflight 失败：零写入；
- staging 或语义读回失败：删除本事务拥有的 staging，live roots 不变；
- live roots 写入中失败：从 snapshot 恢复全部声明文件；
- 归档生成失败：不更新 `active.json`；
- `active.json` 提交后清理失败：发布视为已提交，只修复 recovery，不反向伪装成未发布；
- 回滚生成反向增量，不覆写历史 ZIP，不删除旧 release record。

## 8. 阶段四：工程收尾

### 8.1 启动与运行

`start-cn.bat` 改为每次启动前执行服务端构建或可靠的新旧时间戳检查，构建失败不得启动旧 `out`。端口 8001 被占用时只允许终止由本项目 PID 记录且命令行匹配的旧服务；其他进程只报告 PID 和命令行并退出，不再无条件 `taskkill /f`。

启动日志显示实际 `CN_LISTEN_HOST`、端口、CDN 根、管理鉴权状态和发布图尾部，不硬编码 LAN IP。

### 8.2 CI 与依赖

CI 至少包含：

- 根项目 TypeScript typecheck/build；
- Node 测试；
- `admin` typecheck/build；
- Python 单元测试；
- CDN 图隔离夹具测试；
- 资产维护 dry-run/restore 单元测试；
- 现有 hygiene 与 gitleaks。

依赖修复按“可验证的小批次”进行，不使用破坏性 `npm audit fix --force`。每批 lockfile 变更都必须通过上述矩阵；不能安全升级的漏洞记录包名、可达性、缓解措施和后续升级条件。

### 8.3 文档

更新项目操作文档，使其反映实际分支、当前已跟踪的 mod-tools、鉴权配置、角色包入口、资产隔离/恢复方法和 CDN 健康检查。M4 状态仍保持未批准，不借文档整改删除旧后台。

## 9. 审计记录与错误处理

所有整改运行记录写入 `work/remediation/<run_id>/`，至少包含：

- `baseline.json`：Git HEAD/status、监听地址、数据库检查、发布图和受保护路径；
- `actions.jsonl`：计划动作、结果、错误和回滚状态；
- `verification.json`：测试命令、退出码和关键计数；
- `final-report.md`：实际隔离内容、可恢复路径、未处理项和后续永久删除候选。

记录中不得包含管理令牌、Cookie、完整存档内容或其他秘密。任何部分失败都保留日志和已完成回滚证据，不继续执行依赖该结果的后续动作。

## 10. 验收标准

以下条件全部成立，才可宣称本轮整改完成：

1. 编码路径穿越、盘符、UNC、junction/symlink 测试均无法读取允许根外文件；
2. LAN 管理接口无 Cookie/Bearer 时统一拒绝，游戏 API 仍可正常登录和加载；
3. 三个故障注入点均证明存档替换自动 rollback；
4. 已声明受支持版本均可通过同一 CDN 图到达当前发布尾部，`/load` 与 `get_path` 目标一致；
5. 真实 asset-patch 不再污染测试夹具；
6. 首轮隔离清单可逐条解释，`unknown`、逆向材料、活动 store、全量包和有效快照零误移；
7. 恢复演练后文件大小和 SHA-256 全部一致；
8. 新角色包通过三层、嵌套表、表宽、资源完整度和发布基线校验；
9. 根项目、admin、Node、Python、数据库、CDN 和自检全部通过；
10. 服务实际从新构建产物启动，在线只读烟雾检查成功；
11. 交付最终报告，分别列出已隔离、继续保留、证据不足和未来可永久删除的字节数；
12. 首轮未执行永久删除和 Git 对象清理。

## 11. 提交与回滚边界

代码提交按阶段拆分，使用明确前缀并只暂存本阶段文件；不把现有用户修改混入提交。建议顺序：

1. `docs: add remediation and asset governance design`
2. `fix(security): harden patch paths and admin access`
3. `fix(data): make save replacement transactional`
4. `fix(cdn): build reachable release graph`
5. `feat(mod-tools): add reversible asset maintenance`
6. `refactor(mod-tools): consolidate character package flow`
7. `ci: enforce remediation verification matrix`
8. `docs: document secured operations and asset recovery`

代码回滚使用小提交；数据回滚使用事务 snapshot；资产回滚使用 quarantine manifest；CDN 回滚使用反向增量和原子 manifest。四类回滚互不替代。
