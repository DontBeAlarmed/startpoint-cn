const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "../..")
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"))
const cnTsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.cn.json"), "utf8"))
const { scripts } = packageJson

const tsc = "node --max-old-space-size=4096 node_modules/typescript/bin/tsc"

test("requires the Node version that provides process.loadEnvFile", () => {
    assert.equal(packageJson.engines.node, ">=20.12.0")
    assert.equal(packageLock.packages[""].engines.node, packageJson.engines.node)
})

test("runs typecheck through Node with the project memory limit", () => {
    assert.equal(scripts.typecheck, `${tsc} --noEmit`)
})

test("keeps CN server and legacy builds separate", () => {
    assert.equal(
        scripts["build:server"],
        "node tools/test-workflow/build-cn.cjs",
    )
    assert.equal(scripts["build:legacy"], `${tsc} -p tsconfig.json`)
    assert.doesNotMatch(scripts["build:server"], /admin|css/)
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
})

test("includes runtime-loaded CN modules as explicit compilation roots", () => {
    assert.equal(cnTsconfig.compilerOptions.incremental, true)
    assert.equal(cnTsconfig.compilerOptions.tsBuildInfoFile, "./out/.tsbuildinfo-cn")
    assert.deepEqual(cnTsconfig.files, [
        "src/cn-server.ts",
        "src/server.ts",
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

test("separates reproducible admin installation from its build", () => {
    assert.equal(scripts["install:admin"], "npm --prefix admin ci")
    assert.equal(scripts["build:admin"], "npm --prefix admin run build")
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
        scripts["verify:full"],
        "npm run typecheck && npm run test:full && npm run hygiene && npm run build:server",
    )
})

test("exposes the workflow benchmark command", () => {
    assert.equal(
        scripts["benchmark:workflow"],
        "node tools/test-workflow/benchmark.cjs",
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

test("exposes the explicit real-CDN content smoke without adding it to normal tests", () => {
    assert.equal(
        scripts["content:smoke"],
        "node tools/content_sync_smoke.cjs",
    )
    assert.doesNotMatch(scripts["content:smoke"], /--cdn-root|--content-root/)
})
