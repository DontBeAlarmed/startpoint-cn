const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")
const typesModule = path.join(projectRoot, "src/content/cdn/types").replaceAll("\\", "/")
const tscPath = path.join(projectRoot, "node_modules/typescript/bin/tsc")

test("keeps catalog data readonly and update plans structurally valid", t => {
    const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-types-"))
    const fixturePath = path.join(fixtureDirectory, "contracts.ts")
    t.after(() => fs.rmSync(fixtureDirectory, { force: true, recursive: true }))

    fs.writeFileSync(fixturePath, `
import type {
    CatalogArchive,
    CatalogEdge,
    CdnCatalog,
    ReadonlyNonEmptyArray,
    UpdatePlan,
} from ${JSON.stringify(typesModule)}

const archive: CatalogArchive = {
    relativePath: "archive-common-full/base.zip",
    compressedBytes: 100,
    sha256: "digest",
    layer: "common",
    order: 0,
}
const edge: CatalogEdge = {
    fromVersion: null,
    toVersion: "1.4.0",
    platform: "android",
    assetSizeKind: "fulfill",
    archives: [archive],
}
const edges: ReadonlyNonEmptyArray<CatalogEdge> = [edge]
const catalog: CdnCatalog = { schemaVersion: 1, edges }

const plans: ReadonlyArray<UpdatePlan> = [
    { kind: "up-to-date", full: null, diff: null, downloadBytes: 0 },
    { kind: "initial", full: edge, diff: null, downloadBytes: 100 },
    { kind: "initial", full: edge, diff: edges, downloadBytes: 200 },
    { kind: "incremental", full: null, diff: edges, downloadBytes: 100 },
]

// @ts-expect-error catalog arrays are immutable
catalog.edges.push(edge)
// @ts-expect-error archive fields are immutable
archive.order = 1
// @ts-expect-error incremental plans require a non-empty diff
const emptyDiff: UpdatePlan = { kind: "incremental", full: null, diff: [], downloadBytes: 0 }
// @ts-expect-error initial plans also reject an empty diff
const emptyInitialDiff: UpdatePlan = { kind: "initial", full: edge, diff: [], downloadBytes: 0 }
// @ts-expect-error up-to-date plans cannot include archives
const invalidCurrent: UpdatePlan = { kind: "up-to-date", full: edge, diff: null, downloadBytes: 0 }

void plans
void emptyDiff
void emptyInitialDiff
void invalidCurrent
`, "utf8")

    const result = spawnSync(process.execPath, [
        tscPath,
        "--strict",
        "--noEmit",
        "--skipLibCheck",
        "--module", "commonjs",
        "--moduleResolution", "node",
        "--target", "es2016",
        fixturePath,
    ], { cwd: projectRoot, encoding: "utf8" })

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})
