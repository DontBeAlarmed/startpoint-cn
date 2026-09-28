"use strict"

// Test-fixture authority guard (D27 C5): ordinary business tests must install
// content snapshots through the unified helpers (content-snapshot-fixture /
// install-bundled-gameplay-snapshot / install-bundled-shop-snapshot /
// mission-degree-session-fixture) instead of assigning
// productionContentSnapshotProvider.snapshot directly. Direct singleton
// access is reserved for tests that verify the provider, snapshot identity,
// release pinning or transport metadata itself, listed below by
// responsibility.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const projectRoot = path.resolve(__dirname, "..")

// Tests that verify the production snapshot provider/lifecycle itself.
const LOW_LEVEL_PROVIDER = new Set([
    "tools/content_snapshot_configuration.test.cjs",
    "tools/content_runtime_index_contract.test.cjs",
    "tools/cdn_catalog_provider.test.cjs",
    // Verifies pre-init provider semantics for a business module (null
    // snapshot: no read for non-Content-bound state, strict error otherwise).
    "tools/gacha_save_validation.test.cjs",
    // Pre-init fail-closed contract for the six config policy readers.
    "tools/config_content.test.cjs",
    // Pre-init fail-closed contract for the exchange/ex/election catalogs.
    "tools/exchange_content_boundary.test.cjs",
    // Null-snapshot lazy-import contract plus the pre-init fail-closed subtest
    // of the character/race adapters (provider boundary verification).
    "tools/character_content.test.cjs",
    // Final subtest pins the mission catalog runtime accessor: pre-init fails
    // closed and follows the installed runtime repository.
    "tools/mission_catalog.test.cjs",
    // Snapshot lifecycle through business endpoints: null -> strict error,
    // release swap -> different reads, damaged -> fail closed.
    "tools/content_runtime_endpoint_tables.test.cjs",
    // Snapshot release pinning for mission tables: modules imported before
    // install follow the installed release; broken releases never fall back.
    "tools/content_runtime_mission_tables.test.cjs",
    // Unified-helper lifecycle invariants: idempotent restore, after() returns
    // to the previous snapshot, exit-hook fallback on top-level failure.
    "tools/character_awake_settlement.test.cjs",
    "tools/character_awake_unlock.test.cjs",
])

// Perf admissions that wrap the installed snapshot repository in a counting
// delegate (Proxy-observed tables) to pin production Content read/parse
// counts. A tables-map fixture cannot express this dynamic delegation.
const MEASUREMENT_PROBE = new Set([
    "tools/perf/item_inventory_expiry_admission.test.cjs",
])

// Tests that assert snapshot/transport *metadata* (info fields, digests,
// admin status projections) and therefore build custom info() shapes.
const KEEP_METADATA = new Set([
    "tools/admin_multi_status.test.cjs",
    "tools/admin_server_status_runtime_config.test.cjs",
    "tools/cdn_asset_import.test.cjs",
])

const ALLOWED_DIRECT_ACCESS = new Set([
    ...LOW_LEVEL_PROVIDER,
    ...MEASUREMENT_PROBE,
    ...KEEP_METADATA,
])

function listTestFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const entryPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
            return entry.name === "node_modules" ? [] : listTestFiles(entryPath)
        }
        return entry.name.endsWith(".test.cjs") || entry.name.endsWith(".test.js")
            ? [entryPath]
            : []
    })
}

test("ordinary tests do not assign the production content snapshot singleton", () => {
    const scanRoots = [
        path.join(projectRoot, "tools"),
        path.join(projectRoot, "tests"),
    ]
    const violations = []
    for (const root of scanRoots) {
        for (const filePath of listTestFiles(root)) {
            const relative = path.relative(projectRoot, filePath).replaceAll(path.sep, "/")
            if (relative.startsWith("tools/helpers/")
                || relative === "tools/content_runtime_test_fixture_authority.test.cjs") continue
            const source = fs.readFileSync(filePath, "utf8")
            if (/productionContentSnapshotProvider/.test(source)
                && !ALLOWED_DIRECT_ACCESS.has(relative)) {
                violations.push(relative)
            }
        }
    }
    assert.deepEqual(
        violations.sort(),
        [],
        "direct productionContentSnapshotProvider access is reserved for the "
        + "responsibility allowlist above; business tests must install "
        + "snapshots via tools/helpers (unified frozen fixture helpers)",
    )
})

test("allowlist entries still exist and still reference the provider", () => {
    for (const relative of ALLOWED_DIRECT_ACCESS) {
        const absolute = path.join(projectRoot, relative)
        assert.ok(fs.existsSync(absolute), `stale allowlist entry: ${relative}`)
        const source = fs.readFileSync(absolute, "utf8")
        assert.match(
            source,
            /productionContentSnapshotProvider/,
            `allowlist entry no longer needs direct access: ${relative}`,
        )
    }
})
