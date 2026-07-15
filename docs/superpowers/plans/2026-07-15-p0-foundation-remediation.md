# P0 Foundation Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 封堵补丁文件路径穿越和无鉴权管理面，把存档替换改为原子事务，并让 CN 客户端从受支持版本稳定到达当前 CDN 发布尾部。

**Architecture:** 将安全路径、后台会话、存档校验和 CDN 图分别放进可注入、可单测的小模块；`cn-server.ts`、`player.ts` 和路由文件只负责接线。所有现场写入前先生成基线，测试使用临时目录和临时数据库，不读取真实 asset-patch 或修改真实存档。

**Tech Stack:** Node.js 20、TypeScript 5、Fastify 5、better-sqlite3、React 18、Node test runner、Python 3 标准库。

## Global Constraints

- 项目根固定为 `D:\WF\startpoint-cn`，当前工作分支为 `release/modes-20260714`。
- 不修改或删除 `web/pages/`、`src/routes/web/`、`web/public/`；M4 未获批准。
- 不改动用户已有的 `assets/cdndata/character.json`、`assets/cdndata/character_text.json`、`assets/character.json`、`assets/mana_node.json`、未跟踪角色生成器文档和 `work/`。
- 不触碰 `decompile/`、`ffdec_26.2.1/`、`pc-run/`、`instrument/`、`弹国服/` 的内容。
- ①层 JSON 变更依靠服务重载/重启生效；②层 orderedmap 变更只能经 CDN 发布，不使用 adb 手推。
- 嵌套 orderedmap 内层键序不得重排，跨表写入必须按目标表实际宽度处理。
- 每个任务只暂存任务列出的路径；每次提交前运行对应失败测试、通过测试和 `git diff --check`。
- 不执行永久资产删除、Git GC、客户端清数据或全量重下。

---

## File Structure

- Create `mod-tools/wf_remediation_baseline.py`: 生成不含秘密的整改基线与运行目录。
- Create `mod-tools/tests/test_remediation_baseline.py`: 基线脱敏和临时目录测试。
- Create `src/lib/safe-root-file.ts`: 允许根目录内文件的格式、realpath 和 reparse 边界。
- Create `src/routes/cn/patch-files.ts`: 两个补丁下载路由及流式响应。
- Create `src/tests/cn-patch-files.test.ts`: Fastify 注入式路径攻击测试。
- Create `src/lib/admin-auth.ts`: 配置校验、会话签名、Cookie/Bearer 与同源判定。
- Create `src/routes/web_api/admin-auth.ts`: login/session/logout 路由。
- Create `src/tests/admin-auth.test.ts`: 鉴权和 CSRF 测试。
- Create `admin/src/pages/Login.tsx`: 管理后台登录页。
- Create `scripts/generate-admin-token.ps1`: 本地令牌生成和 ACL 收紧。
- Create `src/data/validation/merged-player.ts`: 存档快照运行时校验。
- Create `src/tests/player-replace-transaction.test.ts`: 临时数据库故障注入测试。
- Create `src/lib/cn-asset-graph.ts`: 差分边、图验证、路径选择和缓存快照。
- Create `src/tests/cn-asset-graph.test.ts`: 线性、分支、孤立和三根归档测试。
- Modify `src/cn-server.ts`: 注册新路由与后台 guard，删除不安全内联下载实现。
- Modify `src/routes/web_api/index.ts`: 注册 admin-auth 路由。
- Modify `src/routes/cn/asset.ts`: 使用请求对应的图路径和可注入根目录。
- Modify `src/routes/cn/load.ts`: 使用同一图快照计算 `available_asset_version`。
- Modify `src/lib/cn-character-release.ts`: 只验证 active manifest 自身连续性，由图层验证接入点。
- Modify `src/lib/version.ts`: 从 CDN 图得出请求对应目标，不再取文件名最大值。
- Modify `src/data/index.ts`: 支持测试专用 `WF_DATABASE_DIR`。
- Modify `src/data/domains/player.ts`: 单事务替换和可注入阶段钩子。
- Modify `src/routes/web_api/player.ts`: 写入前运行快照校验，成功后读回。
- Modify `admin/src/api/client.ts`: 带 Cookie、处理 401。
- Modify `admin/src/App.tsx`: 会话 gate 和登录路由。
- Modify `.env.example`: 安全 loopback 默认值、令牌和受支持版本示例。

### Task 1: Capture a Protected Baseline

**Files:**
- Create: `mod-tools/wf_remediation_baseline.py`
- Test: `mod-tools/tests/test_remediation_baseline.py`

**Interfaces:**
- Produces: `capture_baseline(repo_root: Path, output_root: Path, env: Mapping[str, str]) -> Path`
- Produces: `$outputRoot/$runId/baseline.json`
- Consumes: Git CLI、SQLite `PRAGMA quick_check`、`.cdn/cn/character-releases/active.json`。

- [ ] **Step 1: Write the failing redaction and output test**

```python
def test_capture_baseline_redacts_secrets_and_preserves_dirty_paths():
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        out = root / "work" / "remediation"
        result = baseline.capture_baseline(
            root,
            out,
            {"CN_ADMIN_TOKEN": "secret", "CN_LISTEN_HOST": "127.0.0.1"},
            runner=lambda argv, cwd: " M assets/character.json\n",
        )
        payload = json.loads((result / "baseline.json").read_text("utf-8"))
        self.assertNotIn("secret", json.dumps(payload))
        self.assertIn("assets/character.json", payload["git"]["status"])
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `python -m unittest mod-tools.tests.test_remediation_baseline -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'wf_remediation_baseline'`.

- [ ] **Step 3: Implement deterministic baseline capture**

```python
SECRET_NAMES = {"CN_ADMIN_TOKEN", "OPENAI_API_KEY", "GITHUB_TOKEN"}

def capture_baseline(repo_root, output_root, env, runner=_run):
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = output_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    safe_env = {key: value for key, value in env.items()
                if key.startswith(("CN_", "CDN_")) and key not in SECRET_NAMES}
    payload = {
        "schema_version": 1,
        "run_id": run_id,
        "git": {
            "head": runner(["git", "rev-parse", "HEAD"], repo_root).strip(),
            "status": runner(["git", "status", "--short"], repo_root).splitlines(),
        },
        "environment": safe_env,
        "database": _database_checks(repo_root),
        "character_release": _active_manifest_summary(repo_root),
    }
    _atomic_json(run_dir / "baseline.json", payload)
    return run_dir
```

The CLI accepts only `baseline --repo-root D:\WF\startpoint-cn --output-root D:\WF\startpoint-cn\work\remediation` plus equivalent absolute paths used by isolated tests. It prints the final run directory, never environment values.

- [ ] **Step 4: Run isolated and full Python tests**

Run: `python -m unittest mod-tools.tests.test_remediation_baseline -v`

Expected: PASS, with no writes outside the temporary directory.

Run: `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`

Expected: all existing tests pass; the known environment-only skip remains a skip.

- [ ] **Step 5: Generate the real read-only baseline**

```powershell
$runDir = python mod-tools/wf_remediation_baseline.py baseline --repo-root D:\WF\startpoint-cn --output-root D:\WF\startpoint-cn\work\remediation | Select-Object -Last 1
if (-not (Test-Path (Join-Path $runDir 'baseline.json'))) { throw 'Baseline output was not created' }
```

Expected: exit 0 and a new `$runDir\baseline.json`; `git.status` lists the four protected JSON files and no secret value appears.

- [ ] **Step 6: Commit the baseline tool only**

```bash
git add mod-tools/wf_remediation_baseline.py mod-tools/tests/test_remediation_baseline.py
git diff --cached --check
git commit -m "feat(mod-tools): capture remediation baselines"
```

### Task 2: Replace Inline Patch Downloads with a Safe Route

**Files:**
- Create: `src/lib/safe-root-file.ts`
- Create: `src/routes/cn/patch-files.ts`
- Test: `src/tests/cn-patch-files.test.ts`
- Modify: `src/cn-server.ts:525-552`

**Interfaces:**
- Produces: `resolveSafeLeaf(root: string, leaf: string, pattern: RegExp): string | null`
- Produces: `patchFileRoutes(fastify, { productionRoot, activeRoot }): Promise<void>`
- Consumes: active filenames matching `^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$`; production store splits the 40-hex SHA-1 into prefix `[0-9a-f]{2}` plus leaf `[0-9a-f]{38}`.

- [ ] **Step 1: Write Fastify injection tests for traversal and legal files**

```ts
test("active patch route cannot escape its root", async () => {
    const fixture = makePatchFixture();
    const app = Fastify();
    await app.register(patchFileRoutes, fixture.options);
    const attacks = [
        "%2e%2e%2fpackage.json", "%252e%252e%252fpackage.json",
        "..%5cpackage.json", "C:%5cWindows%5cwin.ini", "%5c%5cserver%5cshare%5cx.zip",
    ];
    for (const file of attacks) {
        const response = await app.inject({ method: "GET", url: `/patch/cn/asset-patch/active/${file}` });
        assert.equal(response.statusCode, 404);
    }
});

test("active patch route streams an allowed zip", async () => {
    const response = await app.inject({ method: "GET", url: "/patch/cn/asset-patch/active/pinball-safe.zip" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "fixture-zip");
});
```

Also create a temporary directory symlink/junction to a file outside the root and assert 404.

- [ ] **Step 2: Run the focused test and verify the unsafe route remains**

Run: `npx tsc && node --test out/tests/cn-patch-files.test.js`

Expected: FAIL because `safe-root-file` and `patch-files` do not exist.

- [ ] **Step 3: Implement containment and stream responses**

```ts
export function resolveSafeLeaf(root: string, leaf: string, pattern: RegExp): string | null {
    if (!pattern.test(leaf) || decodeURIComponent(leaf) !== leaf) return null;
    const rootReal = realpathSync.native(root);
    const candidate = path.resolve(rootReal, leaf);
    const relative = path.relative(rootReal, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!existsSync(candidate) || !lstatSync(candidate).isFile()) return null;
    const fileReal = realpathSync.native(candidate);
    const realRelative = path.relative(rootReal, fileReal);
    return !realRelative.startsWith("..") && !path.isAbsolute(realRelative) ? fileReal : null;
}
```

`patch-files.ts` validates `prefix` and the 38-hex remainder, calls `openSafeRelativeFile` against the unchanged production root (never treating `prefix` as a new trust root), sets the correct content type and streams the opened handle. All validation failures return 404.

- [ ] **Step 4: Remove only the two inline routes and register the plugin**

```ts
fastify.register(patchFileRoutes, {
    productionRoot: path.join(__dirname, "..", "assets", "asset-patch", "production", "upload"),
    activeRoot: path.join(__dirname, "..", "assets", "asset-patch", "active"),
});
```

Do not change the old admin page files or the static `/patch` registration.

- [ ] **Step 5: Run attack, type and regression tests**

Run: `npx tsc && node --test out/tests/cn-patch-files.test.js out/tests/cn-character-release.test.js`

Expected: all tests PASS; traversal responses are 404 and legal ZIP response is 200.

- [ ] **Step 6: Commit the path fix**

```bash
git add src/lib/safe-root-file.ts src/routes/cn/patch-files.ts src/tests/cn-patch-files.test.ts src/cn-server.ts
git diff --cached --check
git commit -m "fix(security): contain patch file downloads"
```

### Task 3: Add a Secure Admin Session and Route Guard

**Files:**
- Create: `src/lib/admin-auth.ts`
- Create: `src/routes/web_api/admin-auth.ts`
- Create: `src/tests/admin-auth.test.ts`
- Modify: `src/cn-server.ts:509-512`
- Modify: `src/routes/web_api/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `loadAdminAuthConfig(env, listenHost): AdminAuthConfig`
- Produces: `createAdminSession(token, nowMs, ttlMs): string`
- Produces: `verifyAdminSession(cookie, token, nowMs): boolean`
- Produces: `installAdminGuard(fastify, config): void`
- Protects: `/api/server`, `/api/player`, `/api/mail`, `/api/lookup`, `/api/seeds`, `/api/mod-admin` and legacy page routes; excludes `/api/index.php/**` and `/api/admin-auth/**`.

- [ ] **Step 1: Write failing pure crypto and Fastify guard tests**

```ts
test("LAN binding rejects a missing admin token", () => {
    assert.throws(() => loadAdminAuthConfig({}, "0.0.0.0"), /CN_ADMIN_TOKEN/);
});

test("loopback without a token requires an explicit insecure opt-in", () => {
    assert.throws(() => loadAdminAuthConfig({}, "127.0.0.1"), /CN_ADMIN_ALLOW_INSECURE_LOOPBACK/);
    assert.equal(loadAdminAuthConfig({ CN_ADMIN_ALLOW_INSECURE_LOOPBACK: "true" }, "127.0.0.1").mode,
        "insecure-loopback");
});

test("tokens shorter than 32 UTF-8 bytes are rejected", () => {
    assert.throws(() => loadAdminAuthConfig({ CN_ADMIN_TOKEN: "too-short" }, "127.0.0.1"), /32 bytes/);
});

test("admin route accepts bearer and rejects unauthenticated access", async () => {
    const app = await guardedFixture("a".repeat(64));
    assert.equal((await app.inject({ method: "GET", url: "/api/server/accounts" })).statusCode, 401);
    assert.equal((await app.inject({
        method: "GET", url: "/api/server/accounts",
        headers: { authorization: `Bearer ${"a".repeat(64)}` },
    })).statusCode, 200);
});

test("cookie mutation rejects a foreign origin", async () => {
    const cookie = await login(app);
    const response = await app.inject({
        method: "POST", url: "/api/server/resetTime",
        headers: { cookie, origin: "https://evil.invalid" },
    });
    assert.equal(response.statusCode, 403);
});

test("login is rate limited without revealing why authentication failed", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await badLogin(app, "198.51.100.10")).statusCode, 401);
    }
    assert.equal((await badLogin(app, "198.51.100.10")).statusCode, 429);
});
```

Also assert malformed/expired cookies return 401 instead of throwing, a successful login sets `HttpOnly`, `SameSite=Strict`, `Path=/` and bounded `Max-Age`, `Secure` follows explicit HTTPS configuration, and Cookie-authenticated writes reject missing as well as foreign `Origin`/`Referer`.

- [ ] **Step 2: Run the test and observe missing exports**

Run: `npx tsc`

Expected: FAIL on missing `admin-auth` module and exports.

- [ ] **Step 3: Implement HMAC sessions and constant-time verification**

```ts
export function createAdminSession(token: string, nowMs: number, ttlMs: number): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, exp: nowMs + ttlMs, n: randomBytes(16).toString("hex") }))
        .toString("base64url");
    const signature = createHmac("sha256", token).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

export function verifyAdminSession(value: string, token: string, nowMs: number): boolean {
    try {
        const [payload, signature, extra] = value.split(".");
        if (!payload || !signature || extra) return false;
        const expected = createHmac("sha256", token).update(payload).digest();
        const actual = Buffer.from(signature, "base64url");
        if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
        const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return decoded.v === 1 && Number.isSafeInteger(decoded.exp) && decoded.exp > nowMs;
    } catch {
        return false;
    }
}
```

`loadAdminAuthConfig` requires at least 32 UTF-8 bytes of token entropy, refuses tokenless loopback unless `CN_ADMIN_ALLOW_INSECURE_LOOPBACK=true`, and reads `CN_ADMIN_COOKIE_SECURE=true` only as an explicit HTTPS deployment setting. The guard parses only the named `wf_admin_session` Cookie, compares fixed-length SHA-256 digests with `timingSafeEqual` for Bearer tokens, checks same-origin `Origin` then `Referer` for Cookie-authenticated `POST`, `PATCH`, `PUT` and `DELETE`, and returns JSON `{ "error": "unauthorized" }` for API routes. Login uses a bounded in-memory per-IP window (5 failures per 10 minutes, expired buckets removed) and the same generic 401 body for missing/wrong tokens.

- [ ] **Step 4: Register auth before management routes**

Add the global guard before `indexWebPlugin`, `indexWebApiPlugin`, seeds and mod-admin registration. Register `/api/admin-auth` through `src/routes/web_api/index.ts`. Keep `/api/index.php/**` outside this guard. For authenticated legacy management GET routes with side effects, emit one structured deprecation warning containing route and method but no query/body/token; do not modify their handlers before M4.

- [ ] **Step 5: Update safe configuration examples**

```dotenv
CN_LISTEN_HOST="127.0.0.1"
# LAN binding requires a generated local secret:
# CN_ADMIN_TOKEN="generated-by-scripts/generate-admin-token.ps1"
CN_SUPPORTED_ASSET_BASES="1.4.0,1.4.102,1.4.133"
# CN_ADMIN_ALLOW_INSECURE_LOOPBACK="true"
# CN_ADMIN_COOKIE_SECURE="true" # only when the admin origin is HTTPS
```

Remove the obsolete claim that the default example exposes the server to LAN without changes.

- [ ] **Step 6: Run auth and route regression tests**

Run: `npx tsc && node --test out/tests/admin-auth.test.js out/tests/cn-patch-files.test.js out/tests/cn-character-release.test.js`

Expected: all tests PASS; unauthenticated management calls are 401, Bearer calls pass, game paths are not intercepted.

- [ ] **Step 7: Commit backend auth**

```bash
git add src/lib/admin-auth.ts src/routes/web_api/admin-auth.ts src/tests/admin-auth.test.ts src/cn-server.ts src/routes/web_api/index.ts .env.example
git diff --cached --check
git commit -m "fix(security): require admin authentication"
```

### Task 4: Add the Admin Login UI and Local Token Provisioning

**Files:**
- Create: `admin/src/pages/Login.tsx`
- Create: `scripts/generate-admin-token.ps1`
- Modify: `admin/src/api/client.ts`
- Modify: `admin/src/App.tsx`

**Interfaces:**
- Consumes: `POST /api/admin-auth/login`, `GET /api/admin-auth/session`, `POST /api/admin-auth/logout`.
- Produces: `apiSession(): Promise<{ authenticated: boolean }>` and Cookie-authenticated fetch calls.

- [ ] **Step 1: Write a compile-visible login gate before implementation**

Add `Login.tsx` with typed props and import it from `App.tsx`, but leave `apiSession` undefined. Run the build to create the red state.

Run: `npm --prefix admin run build`

Expected: FAIL with `Module has no exported member 'apiSession'`.

- [ ] **Step 2: Implement Cookie-aware API calls and 401 propagation**

```ts
function request(url: string, init: RequestInit = {}) {
    return fetch(url, { ...init, credentials: "same-origin" });
}

export const apiSession = () => apiGet<{ authenticated: boolean }>("/api/admin-auth/session");
export const apiLogin = (token: string) => apiPost<{ ok: true }>("/api/admin-auth/login", { token });
export const apiLogout = () => apiPost<{ ok: true }>("/api/admin-auth/logout");
```

All existing helpers call `request`. `App.tsx` displays a loading state, then `Login` when unauthenticated, and refetches session after login/logout. The token exists only in component state and is cleared immediately after a successful login.

- [ ] **Step 3: Implement the secret generator without printing the token**

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
# Append CN_ADMIN_TOKEN only if the key is absent, then restrict ACL.
$sha = [Security.Cryptography.SHA256]::Create()
$digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
$fingerprint = (-join ($digest | ForEach-Object { $_.ToString('x2') })).Substring(0, 12)
$rng.Dispose()
$sha.Dispose()
Write-Host "Configured .env; fingerprint=$fingerprint"
```

The script builds the complete new `.env` content in memory, writes a same-directory temporary file, applies a protected ACL containing only the current Windows identity and `NT AUTHORITY\SYSTEM` with FullControl, then atomically replaces `.env`. It exits nonzero if `.env` already contains `CN_ADMIN_TOKEN`, unless `-Rotate` is supplied; any write/ACL failure leaves the original `.env` unchanged and removes only its owned temporary file. `-WhatIf` performs no write. Tests inspect captured output and the resulting ACL, and assert the token itself never appears in stdout/stderr.

- [ ] **Step 4: Build the admin app and dry-run token generation**

Run: `npm --prefix admin run build`

Expected: PASS and `web/dist` is generated but remains ignored.

Run: `powershell -NoProfile -File scripts/generate-admin-token.ps1 -WhatIf`

Expected: exit 0, prints only target path and fingerprint label, and `git status --short .env` remains empty because `.env` is ignored and unchanged.

- [ ] **Step 5: Commit UI and provisioning**

```bash
git add admin/src/pages/Login.tsx admin/src/api/client.ts admin/src/App.tsx scripts/generate-admin-token.ps1
git diff --cached --check
git commit -m "feat(admin): add authenticated login flow"
```

### Task 5: Make Save Replacement Transactional

**Files:**
- Create: `src/data/validation/merged-player.ts`
- Create: `src/tests/player-replace-transaction.test.ts`
- Modify: `src/data/index.ts:8-12`
- Modify: `src/data/domains/player.ts:452-500,1107-1125`
- Modify: `src/routes/web_api/player.ts:148-188`

**Interfaces:**
- Produces: `assertMergedPlayerData(value: unknown, expectedPlayerId: number, expectedAccountId: number): asserts value is MergedPlayerData`
- Produces: `PlayerWriteHooks.beforePhase?(phase: PlayerInsertPhase): void`
- Produces: `replacePlayerDataSync(data, hooks?): ReplacePlayerResult`
- Consumes: `WF_DATABASE_DIR` only for isolated tests; production default stays `.database`.

- [ ] **Step 1: Write runtime validation and rollback tests against a temporary DB**

```ts
test("failure after delete restores the complete old save", async () => {
    const fixture = await playerFixture();
    const before = canonicalMerged(fixture.read());
    assert.throws(() => fixture.replace(fixture.changed, {
        beforePhase(phase) { if (phase === "player_children") throw new Error("injected"); },
    }), /injected/);
    assert.deepEqual(canonicalMerged(fixture.read()), before);
});

test("invalid top-level collection is rejected before delete", async () => {
    const fixture = await playerFixture();
    const invalid = { ...fixture.changed, characterList: [] };
    assert.throws(() => fixture.replace(invalid as never), /characterList/);
    assert.equal(fixture.read().player.name, fixture.original.player.name);
});
```

Add cases for a failure during character insert and immediately before the final optional rush-event phase.

- [ ] **Step 2: Run the tests against the current non-transactional implementation**

Run: `npx tsc && node --test out/tests/player-replace-transaction.test.js`

Expected: FAIL because `WF_DATABASE_DIR`, validation and hooks are not implemented; the old implementation cannot prove rollback.

- [ ] **Step 3: Add a test-only database root and strict top-level validation**

```ts
const configuredDataDir = process.env.WF_DATABASE_DIR;
const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : path.resolve(__dirname, "../../.database");
```

`assertMergedPlayerData` rejects non-object values, mismatched route/player/account IDs, missing required collections, arrays where records are required, records where arrays are required, duplicate numeric IDs, non-finite numbers and references to character/equipment/party records absent from the imported snapshot before calling any delete/insert function. Add one test for each validation family and prove the existing save remains unchanged.

- [ ] **Step 4: Wrap delete and every insert in one outer transaction**

```ts
export function replacePlayerDataSync(replaceWith: MergedPlayerData, hooks: PlayerWriteHooks = {}) {
    const account = getAccountFromPlayerIdSync(replaceWith.player.id);
    if (account === null) throw new Error("No account tied to player id.");
    assertMergedPlayerData(replaceWith, replaceWith.player.id, account.id);
    const replace = getDb().transaction(() => {
        hooks.beforePhase?.("delete");
        deletePlayerSync(replaceWith.player.id);
        hooks.beforePhase?.("player_children");
        insertMergedPlayerDataSync(account.id, replaceWith, hooks);
        const readback = getMergedPlayerDataSync(replaceWith.player.id);
        assertReadbackIdentityAndCounts(replaceWith, readback, account.id);
        hooks.beforePhase?.("complete");
        return { playerId: replaceWith.player.id, accountId: account.id };
    });
    return replace();
}
```

`insertMergedPlayerDataSync` calls named phases before logically grouped child inserts. Nested better-sqlite3 transactions remain savepoints inside the outer transaction. Identity and collection-count readback occurs before the outer callback returns, so a mismatch throws while rollback is still possible.

- [ ] **Step 5: Validate before date revival and read back after commit**

In the import route, resolve the target account, validate the parsed plain JSON against the route player/account first, revive dates second, and replace third. After commit, call `getMergedPlayerDataSync(playerId)` once more as a diagnostic assertion before returning success; the rollback-critical identity/count assertion already ran inside the transaction.

- [ ] **Step 6: Run transaction and full TypeScript tests**

Run: `npx tsc && node --test out/tests/player-replace-transaction.test.js out/tests/admin-auth.test.js out/tests/cn-patch-files.test.js out/tests/cn-character-release.test.js`

Expected: all tests PASS; all three injected failures leave the canonical old snapshot unchanged.

- [ ] **Step 7: Commit the transaction fix**

```bash
git add src/data/validation/merged-player.ts src/tests/player-replace-transaction.test.ts src/data/index.ts src/data/domains/player.ts src/routes/web_api/player.ts
git diff --cached --check
git commit -m "fix(data): replace saves in one transaction"
```

### Task 6: Build and Validate the CDN Release Graph

**Files:**
- Create: `src/lib/cn-asset-graph.ts`
- Create: `src/tests/cn-asset-graph.test.ts`
- Modify: `src/lib/cn-character-release.ts`
- Modify: `src/tests/cn-character-release.test.ts`

**Interfaces:**
- Produces: `ReleaseEdge { from, to, archives, sources }`
- Produces: `buildReleaseGraph(input: ReleaseGraphInput): ReleaseGraphSnapshot`
- Produces: `findReleasePath(snapshot, startVersion): ReleasePathResult`
- Consumes: legacy diff directories, injected asset-patch root, validated active character releases and `CN_SUPPORTED_ASSET_BASES`.

- [ ] **Step 1: Replace detached-tail expectations with graph expectations**

```ts
test("character chain may attach at a reachable earlier node", () => {
    const graph = graphFixture({
        legacy: [["1.4.102", "1.4.133"], ["1.4.138", "1.4.139"]],
        character: chain("1.4.133", "1.4.140"),
    });
    const path = findReleasePath(graph, "1.4.102");
    assert.equal(path.targetVersion, "1.4.140");
    assert.deepEqual(path.edges.map(edge => `${edge.from}->${edge.to}`), [
        "1.4.102->1.4.133", "1.4.133->1.4.134", "1.4.134->1.4.135",
        "1.4.135->1.4.136", "1.4.136->1.4.137", "1.4.137->1.4.138",
        "1.4.138->1.4.139", "1.4.139->1.4.140",
    ]);
});

test("archives on the same from-to edge are merged", () => {
    const edge = graph.edges.find(item => item.from === "1.4.138" && item.to === "1.4.139")!;
    assert.deepEqual(new Set(edge.archives.map(item => item.root)), new Set(["common", "medium", "android", "patch"]));
});
```

Add tests for cycles, backward edges, missing archive, corrupted character hash, isolated high version, shortest deterministic path and every declared supported base.

- [ ] **Step 2: Run the graph tests and confirm current tail logic fails**

Run: `npx tsc`

Expected: FAIL because `cn-asset-graph.ts` does not exist and the current active manifest API requires canonical tail equality.

- [ ] **Step 3: Decouple active manifest validation from graph attachment**

Change `readActiveCharacterReleases(cdnDir, canonicalBaseVersion)` to `readActiveCharacterReleases(cdnDir)`. It reads `manifest.base_version`, validates every release and archive, and returns the valid prefix plus an error. The graph builder decides whether the base is reachable.

- [ ] **Step 4: Implement edge identity and deterministic path search**

```ts
function edgeKey(from: string, to: string): string { return `${from}\u0000${to}`; }

export function findReleasePath(graph: ReleaseGraphSnapshot, startVersion: string): ReleasePathResult {
    const queue: Array<{ version: string; edges: ReleaseEdge[] }> = [{ version: startVersion, edges: [] }];
    const best = new Map<string, number>([[startVersion, 0]]);
    const reachable: Array<{ version: string; edges: ReleaseEdge[] }> = [];
    while (queue.length) {
        const current = queue.shift()!;
        reachable.push(current);
        for (const edge of graph.outgoing.get(current.version) ?? []) {
            const distance = current.edges.length + 1;
            if ((best.get(edge.to) ?? Number.MAX_SAFE_INTEGER) <= distance) continue;
            best.set(edge.to, distance);
            queue.push({ version: edge.to, edges: [...current.edges, edge] });
        }
    }
    return chooseHighestThenShortest(reachable);
}
```

Reject non-increasing versions while building. Sort outgoing edges by `to`, then source and archive location. Report issues without claiming an unreachable target.

- [ ] **Step 5: Run focused graph tests**

Run: `npx tsc && node --test out/tests/cn-asset-graph.test.js out/tests/cn-character-release.test.js`

Expected: PASS; `1.4.102` and `1.4.133` both reach the fixture tail, and detached/corrupt data is reported rather than silently promoted.

- [ ] **Step 6: Commit the pure graph layer**

```bash
git add src/lib/cn-asset-graph.ts src/tests/cn-asset-graph.test.ts src/lib/cn-character-release.ts src/tests/cn-character-release.test.ts
git diff --cached --check
git commit -m "fix(cdn): model releases as a validated graph"
```

### Task 7: Use One Graph Snapshot in Load, Get Path and Health

**Files:**
- Modify: `src/routes/cn/asset.ts`
- Modify: `src/routes/cn/load.ts`
- Modify: `src/lib/version.ts`
- Modify: `src/routes/api/modAdmin.ts`
- Test: `src/tests/cn-asset-graph.test.ts`
- Test: `src/tests/cn-character-release.test.ts`

**Interfaces:**
- Consumes: `getCnReleaseGraphSnapshot(): ReleaseGraphSnapshot`
- Produces: `computeAssetTarget(resVer, snapshot): { targetVersion, fullVersion, isFirstTime, path }`
- Produces: authenticated `GET /api/mod-admin/cdn-health`.

- [ ] **Step 1: Add a failing request-specific integration test**

```ts
test("load and get_path choose the same reachable target", async () => {
    const snapshot = fixtureSnapshot();
    assert.equal(computeAssetTarget("1.4.102", snapshot).targetVersion, "1.4.140");
    assert.deepEqual(buildDiffList("http://cdn", snapshot).map(group => group.version),
        ["1.4.133", "1.4.134", "1.4.135", "1.4.136", "1.4.137", "1.4.138", "1.4.139", "1.4.140"]);
});
```

The fixture supplies both CDN and asset-patch roots. Assert no lookup touches the repository's real `assets/asset-patch/active`.

- [ ] **Step 2: Run the test and observe real-root contamination or wrong target**

Run: `npx tsc && node --test out/tests/cn-character-release.test.js out/tests/cn-asset-graph.test.js`

Expected: FAIL until `asset.ts` and `version.ts` accept the same injected snapshot.

- [ ] **Step 3: Replace maximum-version detection with cached graph snapshots**

The cache stamp includes mtimes and sizes for all diff directories, `assets/asset-patch/manifest.json`, active patch directory and `character-releases/active.json`. Cache invalidation rebuilds one immutable snapshot. `computeAssetTarget` finds the path from `resVer` or `FULL_BASE`; when no forward path exists, target equals the current version and the health result records the break.

- [ ] **Step 4: Return only the selected path and expose health**

`asset.ts` maps `computeAssetTarget(resVer, snapshot).path.edges` to diff groups. `load.ts` uses the same function with its `resVer`. `/api/mod-admin/cdn-health` returns:

```ts
{
  ok: snapshot.issues.length === 0 && snapshot.supported.every(item => item.reachable),
  tailVersion: snapshot.tailVersion,
  supported: snapshot.supported,
  issues: snapshot.issues,
}
```

The health route is already covered by the admin guard.

- [ ] **Step 5: Run complete P0 verification**

Run: `npm run typecheck`

Expected: PASS.

Run: `npx tsc && node --test out/tests`

Expected: every Node test PASS, including isolated asset-patch fixtures.

Run: `npm --prefix admin run build`

Expected: PASS.

Run: `python -m unittest discover -s mod-tools/tests -p "test_*.py" -v`

Expected: all Python tests PASS except the already documented environment skip.

- [ ] **Step 6: Verify the live graph read-only before restart**

Run: `node --env-file=.env -e "const g=require('./out/lib/cn-asset-graph').getCnReleaseGraphSnapshot(); console.log(JSON.stringify({tail:g.tailVersion,supported:g.supported,issues:g.issues},null,2))"`

Expected: `1.4.102` and `1.4.133` are reachable, the current character tail is selected, and `issues` is empty. Do not restart the live service in this step.

- [ ] **Step 7: Commit integration**

```bash
git add src/routes/cn/asset.ts src/routes/cn/load.ts src/lib/version.ts src/routes/api/modAdmin.ts src/tests/cn-asset-graph.test.ts src/tests/cn-character-release.test.ts
git diff --cached --check
git commit -m "fix(cdn): serve only reachable release paths"
```

### Task 8: Deploy P0 Safely and Record Evidence

**Files:**
- Modify runtime only: ignored `.env`, ignored `$runDir/verification.json`
- Do not modify tracked source in this task.

**Interfaces:**
- Consumes: `scripts/generate-admin-token.ps1`, built `out/cn-server.js`, authenticated health endpoint.
- Produces: verified LAN service with protected management routes and continuous CDN path.

- [ ] **Step 1: Generate or rotate the local admin token without echoing it**

Run: `powershell -NoProfile -File scripts/generate-admin-token.ps1`

Expected: exit 0, shows only `.env` path and a 12-character fingerprint; no token appears in terminal or Git.

- [ ] **Step 2: Build before touching the running process**

Run: `npm run build`

Expected: PASS and `out/cn-server.js` mtime is newer than modified TypeScript sources.

- [ ] **Step 3: Stop only the verified existing project process and start the new build**

Read the listener PID and command line first. Stop it only if its command line resolves to `D:\WF\startpoint-cn\out\cn-server.js`; otherwise stop and report the foreign owner instead of killing it. Until the later engineering plan hardens `start-cn.bat`, launch this verification instance with an owned PID and redirected logs:

```powershell
$runDir = Get-ChildItem -LiteralPath 'work/remediation' -Directory |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not $runDir) { throw 'No remediation run directory exists' }
$stdout = Join-Path $runDir.FullName 'p0-server.stdout.log'
$stderr = Join-Path $runDir.FullName 'p0-server.stderr.log'
$node = (Get-Command node -ErrorAction Stop).Source
$server = Start-Process -FilePath $node `
    -ArgumentList '--env-file=.env', 'out/cn-server.js' `
    -WorkingDirectory (Resolve-Path '.').Path `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
```

Wait for the health endpoint with a bounded retry loop. Expected: the process remains alive, startup log reports binding/auth/CDN tail, and no missing-token error appears. Keep `$server.Id`; the smoke step must stop exactly that PID in `finally` and confirm the port is released.

- [ ] **Step 4: Run unauthenticated and authenticated smoke checks**

Derive the smoke host from the actual listener. Use `127.0.0.1` only for wildcard/loopback binds; otherwise use the configured LAN address:

```powershell
$listenHost = if ($env:CN_LISTEN_HOST) { $env:CN_LISTEN_HOST } else {
    $line = Get-Content -LiteralPath '.env' -Encoding utf8 | Where-Object { $_ -match '^CN_LISTEN_HOST=' } | Select-Object -Last 1
    if ($line) { ($line -split '=', 2)[1].Trim().Trim('"') } else { '127.0.0.1' }
}
$smokeHost = if ($listenHost -in @('0.0.0.0', '::', 'localhost', '127.0.0.1', '::1')) { '127.0.0.1' } else { $listenHost }
$baseUrl = "http://${smokeHost}:8001"
$unauthenticated = curl.exe -s -o NUL -w "%{http_code}" "$baseUrl/api/server/accounts"
```

Expected: `$unauthenticated` is `401`.

Run game path smoke: `curl.exe -s -o NUL -w "%{http_code}" -X POST "$baseUrl/api/index.php/asset/version_info"`

Expected: not `401`; route remains handled by the game API.

Use a short local helper that reads `CN_ADMIN_TOKEN` from `.env` without printing it to call `/api/mod-admin/cdn-health` with Bearer auth.

Expected: HTTP 200, `ok: true`, supported bases reachable and no issue.

- [ ] **Step 5: Append verification evidence and confirm the worktree boundary**

Record commands, exit codes and summarized JSON under `$runDir/verification.json`; redact Authorization and Cookie values. Stop exactly `$server.Id` in `finally`, wait for exit, and verify `Get-NetTCPConnection -LocalPort 8001 -State Listen` returns no verification process. Run `git status --short` and confirm only the original protected user files remain dirty.

---

## Final Acceptance Gate

- [ ] Encoded traversal, double encoding, symlink/junction escape and disallowed filename tests all return 404; legal active ZIP streams successfully.
- [ ] Every management namespace returns 401 without credentials and succeeds with a valid token/cookie; game protocol routes are not placed behind admin auth.
- [ ] Admin token never appears in terminal, baseline JSON, verification JSON or Git diff.
- [ ] Failure injection at every save-replacement stage leaves the original database byte-equivalent at the modeled table level; success commits all tables once.
- [ ] CDN graph merges legacy and character archives by `(from,to)`, chooses only request-reachable paths, and reports all configured supported bases reachable.
- [ ] Node integration tests use only injected temporary patch/database roots and no longer read real `assets/asset-patch/active`.
- [ ] TypeScript, Node and Python suites pass; the verification server is stopped and port 8001 is released.
- [ ] User WIP, `web/pages/`, `src/routes/web/`, `web/public/` and protected reverse-workspace assets are unchanged and unstaged.
