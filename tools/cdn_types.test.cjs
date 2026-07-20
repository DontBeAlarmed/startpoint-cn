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
    CdnCatalogArchiveInput,
    CdnCatalog,
    DiffCatalogEdge,
    FullCatalogEdge,
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
const fullEdge: FullCatalogEdge = {
    fromVersion: null,
    toVersion: "1.4.0",
    platform: "android",
    assetSizeKind: "fulfill",
    archives: [archive],
}
const diffEdge: DiffCatalogEdge = {
    ...fullEdge,
    fromVersion: "1.4.0",
    toVersion: "1.4.1",
}
const edges: ReadonlyArray<CatalogEdge> = [fullEdge, diffEdge]
const diffs: ReadonlyNonEmptyArray<DiffCatalogEdge> = [diffEdge]
const catalogInput: CdnCatalogArchiveInput = {
    kind: "full",
    fromVersion: null,
    toVersion: "1.4.0",
    platform: "android",
    layer: "common",
    order: 1,
    relativePath: "archive-common-full/base.zip",
    compressedBytes: 100,
    sha256: "a".repeat(64),
}
const catalog: CdnCatalog = {
    schemaVersion: 1,
    fullBaseVersion: "1.4.0",
    targetVersion: "1.4.1",
    installedBytes: 1000,
    entityListsRelativePath: "EntityLists/android_medium.csv",
    edges,
}

const plans: ReadonlyArray<UpdatePlan> = [
    { kind: "up-to-date", full: null, diff: null, downloadBytes: 0 },
    { kind: "initial", full: fullEdge, diff: null, downloadBytes: 100 },
    { kind: "initial", full: fullEdge, diff: diffs, downloadBytes: 200 },
    { kind: "incremental", full: null, diff: diffs, downloadBytes: 100 },
]

// @ts-expect-error catalog arrays are immutable
catalog.edges.push(fullEdge)
// @ts-expect-error archive fields are immutable
archive.order = 1
// @ts-expect-error scan input fields are immutable
catalogInput.relativePath = "changed.zip"
// @ts-expect-error incremental plans require a non-empty diff
const emptyDiff: UpdatePlan = { kind: "incremental", full: null, diff: [], downloadBytes: 0 }
// @ts-expect-error initial plans also reject an empty diff
const emptyInitialDiff: UpdatePlan = { kind: "initial", full: fullEdge, diff: [], downloadBytes: 0 }
// @ts-expect-error up-to-date plans cannot include archives
const invalidCurrent: UpdatePlan = { kind: "up-to-date", full: fullEdge, diff: null, downloadBytes: 0 }
// @ts-expect-error a diff edge cannot be used as an initial full edge
const diffAsFull: UpdatePlan = { kind: "initial", full: diffEdge, diff: null, downloadBytes: 100 }
// @ts-expect-error a full edge cannot be used in an initial diff chain
const fullAsInitialDiff: UpdatePlan = { kind: "initial", full: fullEdge, diff: [fullEdge], downloadBytes: 100 }
// @ts-expect-error a full edge cannot be used in an incremental diff chain
const fullAsIncrementalDiff: UpdatePlan = { kind: "incremental", full: null, diff: [fullEdge], downloadBytes: 100 }
// @ts-expect-error full and diff edge contracts are not cross-assignable
const invalidFullEdge: FullCatalogEdge = diffEdge
// @ts-expect-error full and diff edge contracts are not cross-assignable
const invalidDiffEdge: DiffCatalogEdge = fullEdge

void plans
void catalogInput
void emptyDiff
void emptyInitialDiff
void invalidCurrent
void diffAsFull
void fullAsInitialDiff
void fullAsIncrementalDiff
void invalidFullEdge
void invalidDiffEdge
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
