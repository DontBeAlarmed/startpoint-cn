const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "../..")
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
const adminPackageJson = JSON.parse(fs.readFileSync(path.join(root, "admin/package.json"), "utf8"))
const cnTsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.cn.json"), "utf8"))
const { scripts } = packageJson

const tsc = "node --max-old-space-size=4096 node_modules/typescript/bin/tsc"

test("requires the Node version that provides process.loadEnvFile", () => {
    assert.equal(packageJson.engines.node, ">=20.12.0")
    assert.equal(packageLock.packages[""].engines.node, packageJson.engines.node)
})

test("runs typecheck through Node with the project memory limit", () => {
    assert.equal(scripts.typecheck, `${tsc} --noEmit`)
    assert.equal(packageJson.devDependencies.typescript, "5.4.5")
    assert.equal(packageLock.packages["node_modules/typescript"].version, "5.4.5")
})

test("keeps CN server and legacy builds separate", () => {
    assert.equal(scripts.build, "npm run build:server")
    assert.equal(
        scripts["build:server"],
        "node tools/test-workflow/build-cn.cjs",
    )
    assert.equal(scripts["build:legacy"], `${tsc} -p tsconfig.json`)
    assert.doesNotMatch(scripts["build:server"], /css/)
    assert.equal(scripts.dev, "npm run build:server && node --env-file=.env out/server.js")
})

test("builds and verifies deterministic thin server bundles", () => {
    assert.equal(
        scripts["build:bundle"],
        "npm run build:server && node tools/server-bundle/build.cjs",
    )
    assert.equal(
        scripts["verify:bundle"],
        "node tools/server-bundle/verify.cjs",
    )
    assert.equal(
        scripts["pack:bundle"],
        "npm run build:bundle && npm run verify:bundle && node tools/server-bundle/pack.cjs",
    )
    assert.equal(
        scripts["verify:runtime-pack"],
        "node tools/runtime-pack/verify.cjs",
    )
})

test("includes runtime-loaded CN modules as explicit compilation roots", () => {
    assert.equal(cnTsconfig.compilerOptions.incremental, true)
    assert.equal(cnTsconfig.compilerOptions.tsBuildInfoFile, "./out/.tsbuildinfo-cn")
    assert.deepEqual(cnTsconfig.files, [
        "src/cn-server.ts",
        "src/server.ts",
        "src/content/sync/entry.ts",
        "src/content/startup/bootstrap.ts",
        "src/multi/tcp/lobby.ts",
    ])
})

test("builds before the supported CN startup bootstrap", () => {
    assert.equal(scripts["start:cn"], "node tools/start_cn.cjs")
    assert.equal(
        scripts["dev:cn"],
        "npm run build:server && node tools/start_cn.cjs",
    )
})

test("installs and builds admin through the root workspace lock", () => {
    assert.deepEqual(packageJson.workspaces, ["admin"])
    assert.equal(packageLock.packages[""].workspaces[0], "admin")
    assert.equal(packageLock.packages.admin.name, adminPackageJson.name)
    assert.equal(packageLock.packages.admin.version, adminPackageJson.version)
    assert.equal(fs.existsSync(path.join(root, "admin/package-lock.json")), false)
    assert.equal(scripts["install:admin"], undefined)
    assert.equal(scripts["build:admin"], "npm run build --workspace=starpoint-admin")
    assert.doesNotMatch(scripts["build:admin"], /\b(?:install|ci)\b/)
})

test("runs legacy CDN tools only after compilation completes", () => {
    assert.equal(
        scripts.cdn,
        "npm run build:legacy && node --env-file=.env out/validate_cdn.js",
    )
    assert.equal(
        scripts.unzip,
        "npm run build:legacy && node --env-file=.env out/unzip_cdn.js",
    )
    assert.doesNotMatch(scripts.cdn, /(?:^|\s)&(?:\s|$)/)
    assert.doesNotMatch(scripts.unzip, /(?:^|\s)&(?:\s|$)/)
})

test("defines the full verification pipeline", () => {
    assert.equal(
        scripts["docs:check"],
        "node tools/docs_check.cjs",
    )
    assert.equal(
        scripts["verify:full"],
        "npm run typecheck && npm run docs:check && npm run test:full && npm run hygiene && npm run build:server",
    )
})

test("exposes the workflow benchmark command", () => {
    assert.equal(
        scripts["benchmark:workflow"],
        "node tools/test-workflow/benchmark.cjs",
    )
    assert.equal(
        scripts["benchmark:tcp"],
        "node tools/perf/tcp_baseline.cjs",
    )
    assert.equal(
        scripts["benchmark:hub"],
        "node tools/perf/hub_baseline.cjs",
    )
    assert.equal(
        scripts["benchmark:mission-settlement"],
        "node tools/perf/mission_settlement_baseline.cjs",
    )
    assert.equal(
        scripts["benchmark:mission-engine-focused"],
        "node tools/perf/mission_engine_focused_baseline.cjs",
    )
})

test("exposes the offline faithful gacha seed catalog workflow", () => {
    assert.equal(
        scripts["gacha:seeds:extract-config"],
        "node tools/gacha-faithful/amf3_decode.cjs",
    )
    assert.equal(
        scripts["gacha:seeds:build"],
        "node tools/gacha-faithful/build_catalog.cjs",
    )
    assert.equal(
        scripts["gacha:seeds:verify"],
        "node tools/gacha-faithful/verify_catalog.cjs",
    )
    assert.equal(
        scripts["gacha:seeds:audit"],
        "node tools/gacha-faithful/audit_catalog.cjs",
    )
})

test("runs content sync through the TypeScript entry without a prebuild", () => {
    assert.equal(
        scripts["content:sync"],
        "node tools/content_sync.cjs",
    )
    assert.doesNotMatch(scripts["content:sync"], /build/)
    assert.doesNotMatch(scripts["content:sync"], /--env-file/)
})

test("runs content asset audit explicitly without adding it to startup", () => {
    assert.equal(
        scripts["content:audit"],
        "node tools/content_asset_audit.cjs",
    )
    assert.doesNotMatch(scripts["content:audit"], /build|start:cn/)
    assert.doesNotMatch(scripts["start:cn"], /content:audit/)
})

test("exposes the reproducible strict event battle rule generator", () => {
    assert.equal(
        scripts["content:mission-event-rules"],
        "node scripts/gen_mission_event_battle_rules.js",
    )
})

test("exposes the official Active Mission table generator", () => {
    assert.equal(
        scripts["content:active-mission"],
        "node scripts/gen_active_mission_data.js",
    )
})

test("exposes the explicit real-CDN content smoke without adding it to normal tests", () => {
    assert.equal(
        scripts["content:smoke"],
        "node tools/content_sync_smoke.cjs",
    )
    assert.doesNotMatch(scripts["content:smoke"], /--cdn-root|--content-root/)
})
