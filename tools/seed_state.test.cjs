"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

require("ts-node/register/transpile-only")

const projectRoot = path.resolve(__dirname, "..")
const { resolveRuntimeDataPaths } = require("../src/runtime/data-paths")
const { createSeedValidator } = require("../src/lib/seed-validator")
const { createSeedStateStore } = require("../src/runtime/seed-state-store")
const seedStateSchema = require("../src/runtime/seed-state-schema")

const BUNDLE_STATE_FILES = [
    "confirmed_seeds.json",
    "purified_seeds.json",
    "verified_seeds.json",
    "pool_config.json",
    "test_seeds.json",
]

const BASELINES = Object.freeze({
    "confirmed_seeds.json": {
        fes: { 101: 0, 102: 1 },
        fes_pend: { 103: null },
    },
    "purified_seeds.json": {
        fes: { 201: { r: 0, tag: "未测试", play: true } },
    },
    "verified_seeds.json": {
        fes: { 301: 2 },
    },
    "pool_config.json": { selectedMovieId: "fes" },
    "test_seeds.json": [null, null, 10_000_901],
})

function createSandbox(t, prefix = "seed-state-") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    return root
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function createFixture(t) {
    const root = createSandbox(t)
    const assetsDir = path.join(root, "bundle", "assets")
    fs.mkdirSync(assetsDir, { recursive: true })
    for (const [fileName, value] of Object.entries(BASELINES)) {
        writeJson(path.join(assetsDir, fileName), value)
    }
    writeJson(path.join(assetsDir, "gacha_movie_seeds_fes.json"), {
        3: { 0: [1001, 1002] },
    })
    writeJson(path.join(assetsDir, "pending_seeds.json"), { untouched: true })
    writeJson(path.join(assetsDir, "blocked_seeds.json"), { untouched: true })
    const dataPaths = resolveRuntimeDataPaths({ DATA_DIR: path.join(root, "data") })
    return { root, assetsDir, dataPaths }
}

function expectedBaselineSnapshot() {
    return {
        schemaVersion: 1,
        confirmed: { fes: { 101: 0, 102: 1 } },
        pending: { fes: { 103: null } },
        play: { fes: { 201: { r: 0, tag: "未测试", play: true } } },
        verified: { fes: { 301: 2 } },
        config: { selectedMovieId: "fes" },
        testSeeds: [null, null, 10_000_901],
    }
}

function stateFile(fixture) {
    return path.join(fixture.dataPaths.seedStateDir, "seed-state.json")
}

function temporaryFile(fixture, id) {
    return `${fixture.dataPaths.seedStateTemporaryFilePrefix}${id}.tmp`
}

function digest(file) {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

function baselineDigests(assetsDir) {
    return Object.fromEntries(BUNDLE_STATE_FILES.map(fileName => [
        fileName,
        digest(path.join(assetsDir, fileName)),
    ]))
}

function createValidator(fixture, options = {}) {
    return createSeedValidator({
        assetsDir: fixture.assetsDir,
        dataPaths: fixture.dataPaths,
        ...options,
    })
}

function createHostSymlink(t, target, linkPath, type = "file") {
    const hostType = process.platform === "win32" && type === "dir" ? "junction" : type
    try {
        fs.symlinkSync(target, linkPath, hostType)
        return true
    } catch (error) {
        if (
            process.platform === "win32"
            && ["EACCES", "EPERM", "ENOTSUP", "ENOSYS"].includes(error.code)
        ) {
            t.skip(`symbolic link creation is unavailable on this Windows host: ${error.code}`)
            return false
        }
        throw error
    }
}

function clone(value) {
    return value === null ? null : JSON.parse(JSON.stringify(value))
}

class MemorySeedStateStore {
    constructor(snapshot = null) {
        this.snapshot = clone(snapshot)
        this.writeCount = 0
        this.failOnWrite = null
    }

    read() {
        return this.snapshot === null
            ? null
            : seedStateSchema.validateSeedRuntimeSnapshot(clone(this.snapshot))
    }

    write(snapshot) {
        this.writeCount += 1
        if (this.writeCount === this.failOnWrite) throw new Error("simulated state write failure")
        this.snapshot = clone(snapshot)
    }
}

test("module import and validator construction do not create DATA_DIR", t => {
    const root = createSandbox(t, "seed-import-")
    const dataDir = path.join(root, "absent-data")
    const result = spawnSync(process.execPath, [
        "-e",
        "require('ts-node/register/transpile-only'); require('./src/lib/seed-validator')",
    ], {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, DATA_DIR: dataDir },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fs.existsSync(dataDir), false)

    const fixture = createFixture(t)
    createValidator(fixture)
    assert.equal(fs.existsSync(fixture.dataPaths.dataDir), false)
})

test("first mutation writes one complete authoritative snapshot from all baselines", t => {
    const fixture = createFixture(t)
    const before = baselineDigests(fixture.assetsDir)
    const validator = createValidator(fixture)

    validator.setSelectedMovieId("normal")

    const expected = expectedBaselineSnapshot()
    expected.config.selectedMovieId = "normal"
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile(fixture), "utf8")), expected)
    assert.deepEqual(fs.readdirSync(fixture.dataPaths.seedStateDir), ["seed-state.json"])
    assert.deepEqual(baselineDigests(fixture.assetsDir), before)
})

test("existing snapshot is the only source and never falls back to individual baselines", t => {
    const fixture = createFixture(t)
    const snapshot = expectedBaselineSnapshot()
    snapshot.confirmed = { fes: { 102: 1 } }
    snapshot.pending = {}
    snapshot.play = {}
    snapshot.verified = {}
    snapshot.config.selectedMovieId = "normal"
    snapshot.testSeeds = [null, null, null]
    writeJson(stateFile(fixture), snapshot)
    for (const fileName of BUNDLE_STATE_FILES) {
        fs.writeFileSync(path.join(fixture.assetsDir, fileName), "{broken-baseline")
    }

    const validator = createValidator(fixture)
    const stats = validator.stats("fes")

    assert.equal(stats.confirm, 1)
    assert.equal(stats.pending, 0)
    assert.equal(stats.play_total, 0)
    assert.equal(stats.verified_total, 0)
    assert.equal(validator.getSelectedMovieId(), "normal")
    assert.deepEqual(stats.test_seeds, [null, null, null])
})

test("authoritative snapshot is fully validated exactly once during startup", t => {
    const fixture = createFixture(t)
    writeJson(stateFile(fixture), expectedBaselineSnapshot())
    let validationCount = 0
    const store = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        validateSnapshot(value) {
            validationCount += 1
            return seedStateSchema.validateSeedRuntimeSnapshot(value)
        },
    })

    createValidator(fixture, { seedStateStore: store })

    assert.equal(validationCount, 1)
})

test("authoritative snapshot accepts and reads back rarity_5_guarantee", t => {
    const fixture = createFixture(t)
    const snapshot = expectedBaselineSnapshot()
    snapshot.confirmed.rarity_5_guarantee = { 10072436: 2 }
    snapshot.config.selectedMovieId = "rarity_5_guarantee"
    writeJson(stateFile(fixture), snapshot)

    const validator = createValidator(fixture)

    assert.equal(validator.getSelectedMovieId(), "rarity_5_guarantee")
    assert.equal(validator.stats("rarity_5_guarantee").confirm, 1)
})

test("moveToVerified removes confirmed and play entries in one committed snapshot", t => {
    const fixture = createFixture(t)
    const snapshot = expectedBaselineSnapshot()
    snapshot.confirmed.fes[401] = 1
    writeJson(stateFile(fixture), snapshot)
    const backingStore = createSeedStateStore({ dataPaths: fixture.dataPaths })
    const countingStore = {
        read: () => backingStore.read(),
        write(value) {
            countingStore.writeCount += 1
            backingStore.write(value)
        },
        writeCount: 0,
    }
    const validator = createValidator(fixture, { seedStateStore: countingStore })

    validator.moveToVerified("fes", 401, 1)

    const persisted = JSON.parse(fs.readFileSync(stateFile(fixture), "utf8"))
    assert.equal(countingStore.writeCount, 1)
    assert.equal(Object.hasOwn(persisted.confirmed.fes, "401"), false)
    assert.equal(Object.hasOwn(persisted.play.fes, "401"), false)
    assert.equal(persisted.verified.fes[401], 1)
    assert.deepEqual(createValidator(fixture).getVerifiedList("fes").find(x => x.seed === 401), {
        seed: 401,
        rarity: 4,
    })
})

test("PLAY=1 confirmation commits one snapshot with only verified state", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })
    validator.markSent("fes", 401, 4)
    validator.recordPlay("fes", 401, true)

    assert.equal(validator.confirmPlayedAndVerify("fes", 401, 1), true)

    assert.equal(store.writeCount, 1)
    assert.equal(store.snapshot.verified.fes[401], 1)
    for (const tier of ["confirmed", "pending", "play"]) {
        assert.equal(Object.hasOwn(store.snapshot[tier].fes, "401"), false, tier)
    }
    assert.equal(validator.getSentR("fes", 401), undefined)
})

test("failed PLAY=1 confirmation rolls back memory and persisted state", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    store.failOnWrite = 1
    const validator = createValidator(fixture, { seedStateStore: store })
    validator.markSent("fes", 401, 4)
    validator.recordPlay("fes", 401, true)
    const before = validator.stats("fes")

    assert.throws(
        () => validator.confirmPlayedAndVerify("fes", 401, 1),
        /simulated state write failure/,
    )

    assert.deepEqual(validator.stats("fes"), before)
    assert.equal(validator.getSentR("fes", 401), 1)
    assert.equal(store.snapshot, null)
})

test("CN beacon handlers only quarantine recently sent C3032 seeds", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src/cn-server.ts"), "utf8")
    const c3032Start = source.indexOf("function parseC3032Beacon")
    const postDebugStart = source.indexOf('fastify.post("/debug"', c3032Start)
    const c3032Handler = source.slice(c3032Start, postDebugStart)

    assert.match(c3032Handler, /gachaSeedQuarantine\.quarantineIfRecentlySent\(/)
    assert.doesNotMatch(source, /function parsePlayBeacon|seedValidator\./)
})

test("verified remains authoritative within one movie after lower-priority mutations and restart", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })

    assert.equal(validator.moveToVerified("fes", 401, 1), true)
    assert.equal(store.writeCount, 1)
    const movieIdsAfterVerified = validator.getMovieIds()
    assert.equal(validator.confirm("fes", 401, 1), false)
    assert.equal(validator.addPending("fes", 401, null), false)
    assert.equal(validator.addPlay("fes", 401, 1, false), false)
    assert.equal(validator.addPlay("fes", 401, 1, true), false)
    assert.equal(store.writeCount, 1)
    assert.deepEqual(validator.getMovieIds(), movieIdsAfterVerified)

    const persisted = store.snapshot
    assert.equal(persisted.verified.fes[401], 1)
    for (const tier of ["confirmed", "pending", "play"]) {
        assert.equal(Object.hasOwn(persisted[tier].fes, "401"), false, tier)
    }

    const restarted = createValidator(fixture, { seedStateStore: store })
    assert.deepEqual(restarted.getVerifiedList("fes").find(entry => entry.seed === 401), {
        seed: 401,
        rarity: 4,
    })
    assert.equal(restarted.stats("fes").confirm, 2)
    assert.equal(restarted.stats("fes_guarantee").confirm, 0)
})

test("baseline import preserves seed 10072436 in different movies", t => {
    const fixture = createFixture(t)
    const confirmed = clone(BASELINES["confirmed_seeds.json"])
    const verified = clone(BASELINES["verified_seeds.json"])
    confirmed.normal = { 10072436: 2 }
    verified.normal_guarantee = { 10072436: 1 }
    writeJson(path.join(fixture.assetsDir, "confirmed_seeds.json"), confirmed)
    writeJson(path.join(fixture.assetsDir, "verified_seeds.json"), verified)
    const store = new MemorySeedStateStore()

    const validator = createValidator(fixture, { seedStateStore: store })

    assert.equal(validator.stats("normal").confirm, 1)
    assert.deepEqual(validator.getVerifiedList("normal_guarantee"), [{
        seed: 10072436,
        rarity: 4,
    }])
    assert.equal(validator.setSelectedMovieId("normal"), true)
    assert.equal(store.snapshot.confirmed.normal[10072436], 2)
    assert.equal(store.snapshot.verified.normal_guarantee[10072436], 1)
})

test("verified seed in a base movie does not block the same seed in guarantee test mode", t => {
    const fixture = createFixture(t)
    const snapshot = expectedBaselineSnapshot()
    snapshot.verified.normal = { 123: 0 }
    const validator = createValidator(fixture, {
        seedStateStore: new MemorySeedStateStore(snapshot),
    })
    validator.setMode("test")

    assert.equal(validator.getSeed("normal_guarantee", 3, [123], 999), 123)
})

test("markSent tracks guarantee and base movies independently", t => {
    const fixture = createFixture(t)
    const snapshot = expectedBaselineSnapshot()
    snapshot.confirmed.normal = { 123: 0 }
    const validator = createValidator(fixture, {
        seedStateStore: new MemorySeedStateStore(snapshot),
    })

    validator.markSent("normal_guarantee", 123, 3)

    assert.equal(validator.getSentR("normal_guarantee", 123), 0)
    assert.equal(validator.getSentR("normal", 123), undefined)
})

test("authoritative snapshot rejects non-canonical duplicates within one movie", t => {
    const fixture = createFixture(t)
    const snapshot = expectedBaselineSnapshot()
    snapshot.confirmed.fes[301] = 2
    writeJson(stateFile(fixture), snapshot)

    assert.throws(
        () => createValidator(fixture),
        /invalid seed state snapshot.*non-canonical.*verified.*confirmed/i,
    )
})

test("small mutations share unchanged pools and normalize a written snapshot once", t => {
    const fixture = createFixture(t)
    let validationCount = 0
    const clonedMovieIds = []
    const backingStore = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        validateSnapshot(value) {
            validationCount += 1
            return seedStateSchema.validateSeedRuntimeSnapshot(value)
        },
    })
    const validator = createValidator(fixture, {
        seedStateStore: backingStore,
        onPoolClone(movieId) {
            clonedMovieIds.push(movieId)
        },
    })
    validator.confirm("normal", 105, 0)
    validationCount = 0
    clonedMovieIds.length = 0

    validator.setSelectedMovieId("normal")

    assert.deepEqual(clonedMovieIds, [])
    assert.equal(validationCount, 1)

    validator.confirm("fes", 104, 0)
    assert.deepEqual(clonedMovieIds, ["fes"])
})

test("each persistent mutation performs exactly one complete snapshot write", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })
    const operations = [
        () => validator.confirm("fes", 104, 0),
        () => validator.addPlay("fes", 105, 1, true),
        () => validator.addPending("fes", 107, null),
        () => validator.moveToVerified("fes", 106, 2),
        () => validator.setSelectedMovieId("normal"),
        () => validator.setTestSeed("normal", 3, 10_000_902),
        () => validator.clearTestSeed(3),
        () => validator.setTag("fes", 201, "普通躲避球"),
    ]

    for (const operation of operations) {
        const before = store.writeCount
        operation()
        assert.equal(store.writeCount, before + 1)
        assert.equal(store.snapshot.schemaVersion, 1)
        for (const key of ["confirmed", "pending", "play", "verified", "config", "testSeeds"]) {
            assert.equal(Object.hasOwn(store.snapshot, key), true, key)
        }
    }
    assert.equal(store.snapshot.pending.fes[107], null)
})

test("no-op mutations return false and never call a failing store", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    store.failOnWrite = 1
    const validator = createValidator(fixture, { seedStateStore: store })

    assert.equal(validator.moveToVerified("fes", 301, 2), false)
    assert.equal(validator.confirm("fes", 101, 0), false)
    assert.equal(validator.confirm("fes", 301, 2), false)
    assert.equal(validator.addPending("fes", 301, null), false)
    assert.equal(validator.addPlay("fes", 301, 2, false), false)
    assert.equal(validator.setSelectedMovieId("fes"), false)
    assert.equal(validator.setTestSeed("fes", 5, 10_000_901), false)
    assert.equal(validator.setTag("fes", 201, "未测试"), false)
    assert.equal(store.writeCount, 0)
})

test("mutators reject invalid movie ids and seed values without writing", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })
    const invalidMovies = [
        " fes",
        "fes ",
        "__proto__",
        "prototype",
        "constructor",
        "FES",
        "fes/guarantee",
        "unknown",
        "x".repeat(65),
        123,
        null,
    ]
    for (const movieId of invalidMovies) {
        assert.throws(
            () => validator.setSelectedMovieId(movieId),
            /invalid seed movie id/i,
            String(movieId),
        )
    }
    for (const seed of [-1, NaN, Infinity, 1.5, 0x80000000, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => validator.confirm("fes", seed, 0), /invalid seed value/i)
    }
    for (const seed of [null, NaN, Infinity, 1.5, 9_999_999, 10_400_000, 0x80000000]) {
        assert.throws(() => validator.setTestSeed("fes", 3, seed), /invalid test seed/i)
    }
    assert.equal(store.writeCount, 0)
    assert.deepEqual(validator.getMovieIds(), [...seedStateSchema.SEED_MOVIE_IDS])
})

test("unknown movie getters are empty and never create pools or snapshot keys", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })
    const beforeMovieIds = validator.getMovieIds()

    const unknownStats = validator.stats("unknown")
    assert.equal(unknownStats.confirm, 0)
    assert.equal(unknownStats.mov_play, 0)
    assert.equal(unknownStats.verified, 0)
    assert.equal(unknownStats.pending, 0)
    assert.deepEqual(validator.getPlayList("unknown"), [])
    assert.deepEqual(validator.getVerifiedList("unknown"), [])
    assert.deepEqual(validator.getPlayForRarity("unknown", 3), [])
    assert.equal(validator.getSentR("unknown", 123), undefined)
    assert.deepEqual(validator.getMovieIds(), beforeMovieIds)

    assert.equal(validator.setSelectedMovieId("normal"), true)
    for (const tier of ["confirmed", "pending", "play", "verified"]) {
        assert.equal(Object.hasOwn(store.snapshot[tier], "unknown"), false, tier)
    }
})

test("stats returns a copy of test seeds", t => {
    const fixture = createFixture(t)
    const validator = createValidator(fixture, {
        seedStateStore: new MemorySeedStateStore(),
    })
    const stats = validator.stats("fes")

    stats.test_seeds[0] = 10_000_123

    assert.deepEqual(validator.stats("fes").test_seeds, [null, null, 10_000_901])
})

test("flushAll batches every persistent pool change into one snapshot write", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })
    validator.markSent("fes", 501, 4)
    validator.recordPlay("fes", 501, true)
    validator.markSent("normal", 502, 3)
    validator.recordPlay("normal", 502, false)

    validator.flushAll()

    assert.equal(store.writeCount, 1)
    assert.equal(store.snapshot.verified.fes[501], 1)
    assert.equal(store.snapshot.confirmed.normal[502], 0)
})

test("failed first write leaves current instance and restart at the baseline", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    store.failOnWrite = 1
    const validator = createValidator(fixture, { seedStateStore: store })
    validator.setMode("play")
    const before = validator.stats("fes")

    assert.throws(
        () => validator.setModeAndSelectedMovieId("test", "normal"),
        /simulated state write failure/,
    )

    assert.deepEqual(validator.stats("fes"), before)
    assert.equal(validator.getMode(), "play")
    assert.equal(validator.getSelectedMovieId(), "fes")
    assert.equal(store.snapshot, null)
    const restarted = createValidator(fixture, { seedStateStore: store })
    const { mode: beforeMode, ...beforePersistentStats } = before
    const { mode: restartedMode, ...restartedPersistentStats } = restarted.stats("fes")
    assert.equal(beforeMode, "play")
    assert.equal(restartedMode, "natural")
    assert.deepEqual(restartedPersistentStats, beforePersistentStats)
    assert.equal(restarted.getSelectedMovieId(), "fes")
})

test("failed second write rolls back memory and preserves the restart snapshot", t => {
    const fixture = createFixture(t)
    const store = new MemorySeedStateStore()
    const validator = createValidator(fixture, { seedStateStore: store })
    validator.setSelectedMovieId("normal")
    const before = validator.stats("fes")
    const persistedBefore = clone(store.snapshot)
    store.failOnWrite = 2

    assert.throws(() => validator.confirm("fes", 104, 0), /simulated state write failure/)

    assert.deepEqual(validator.stats("fes"), before)
    assert.deepEqual(store.snapshot, persistedBefore)
    const restarted = createValidator(fixture, { seedStateStore: store })
    assert.deepEqual(restarted.stats("fes"), before)
    assert.equal(restarted.getSelectedMovieId(), "normal")
})

test("corrupt or structurally invalid authoritative snapshot fails without baseline fallback", t => {
    const fixture = createFixture(t)
    fs.mkdirSync(fixture.dataPaths.seedStateDir, { recursive: true })
    fs.writeFileSync(stateFile(fixture), "{broken-state")
    assert.throws(() => createValidator(fixture), /invalid seed state JSON/i)
    assert.equal(fs.readFileSync(stateFile(fixture), "utf8"), "{broken-state")

    writeJson(stateFile(fixture), { schemaVersion: 1 })
    assert.throws(() => createValidator(fixture), /invalid seed state snapshot/i)

    const invalidTypedSnapshot = expectedBaselineSnapshot()
    invalidTypedSnapshot.play.fes[201].r = "bad"
    writeJson(stateFile(fixture), invalidTypedSnapshot)
    assert.throws(
        () => createValidator(fixture),
        /invalid seed state snapshot.*play seed 201\.r/i,
    )

    const invalidSeedKeySnapshot = expectedBaselineSnapshot()
    invalidSeedKeySnapshot.verified.fes["not-a-seed"] = 1
    writeJson(stateFile(fixture), invalidSeedKeySnapshot)
    assert.throws(
        () => createValidator(fixture),
        /invalid seed state snapshot.*not-a-seed must be a canonical seed key/i,
    )

    for (const invalidTestSeed of [1.5, 9_999_999, 10_400_000]) {
        const invalidTestSeedSnapshot = expectedBaselineSnapshot()
        invalidTestSeedSnapshot.testSeeds[0] = invalidTestSeed
        writeJson(stateFile(fixture), invalidTestSeedSnapshot)
        assert.throws(
            () => createValidator(fixture),
            /invalid seed state snapshot.*invalid test seed/i,
        )
    }
})

test("store rejects prototype movie keys before creating DATA_DIR", t => {
    const fixture = createFixture(t)
    const invalidTestSeedSnapshot = expectedBaselineSnapshot()
    invalidTestSeedSnapshot.testSeeds[0] = NaN
    const store = createSeedStateStore({ dataPaths: fixture.dataPaths })
    assert.throws(() => store.write(invalidTestSeedSnapshot), /invalid test seed/i)
    assert.equal(fs.existsSync(fixture.dataPaths.dataDir), false)

    const snapshot = expectedBaselineSnapshot()
    snapshot.confirmed = JSON.parse('{"__proto__":{"101":0}}')

    assert.throws(() => store.write(snapshot), /invalid seed movie id.*__proto__/i)
    assert.equal(fs.existsSync(fixture.dataPaths.dataDir), false)
})

test("schema rejects non-canonical and colliding seed keys", t => {
    const fixture = createFixture(t)
    const store = createSeedStateStore({ dataPaths: fixture.dataPaths })
    for (const key of ["01", "+1", "1.0"]) {
        const snapshot = expectedBaselineSnapshot()
        snapshot.confirmed = { fes: { [key]: 0 } }
        assert.throws(() => store.write(snapshot), /canonical seed key/i, key)
    }

    const collision = expectedBaselineSnapshot()
    collision.confirmed = { fes: { 1: 0, "01": 1 } }
    assert.throws(() => store.write(collision), /canonical seed key/i)
    assert.equal(fs.existsSync(fixture.dataPaths.dataDir), false)
})

test("unique temporary file is fsynced then renamed", t => {
    const fixture = createFixture(t)
    const temporary = temporaryFile(fixture, "fsync-test")
    const events = []
    const tracingFileSystem = {
        ...fs,
        fsyncSync(fd) {
            events.push(["fsync", fd])
            fs.fsyncSync(fd)
        },
        renameSync(from, to) {
            events.push(["rename", from, to])
            fs.renameSync(from, to)
        },
    }
    const store = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        fileSystem: tracingFileSystem,
        temporaryFileId: () => "fsync-test",
    })

    store.write(expectedBaselineSnapshot())

    assert.equal(events.length, 2)
    assert.equal(events[0][0], "fsync")
    assert.deepEqual(events[1], ["rename", temporary, stateFile(fixture)])
    assert.equal(fs.existsSync(temporary), false)
})

test("each snapshot write uses a unique temp and preserves another writer temp", t => {
    const fixture = createFixture(t)
    fs.mkdirSync(fixture.dataPaths.seedStateDir, { recursive: true })
    const prefix = path.join(fixture.dataPaths.seedStateDir, ".seed-state.json.")
    const otherWriterTemp = `${prefix}writer-b.tmp`
    fs.writeFileSync(otherWriterTemp, "writer-b")
    const ids = ["writer-a-1", "writer-a-2"]
    const opened = []
    const renamed = []
    const tracingFileSystem = {
        ...fs,
        openSync(file, flags) {
            if (flags === "wx") opened.push(file)
            return fs.openSync(file, flags)
        },
        renameSync(from, to) {
            renamed.push([from, to])
            fs.renameSync(from, to)
        },
    }
    const store = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        fileSystem: tracingFileSystem,
        temporaryFileId: () => ids.shift(),
    })

    store.write(expectedBaselineSnapshot())
    const second = expectedBaselineSnapshot()
    second.config.selectedMovieId = "normal"
    store.write(second)

    const expectedTemps = [
        `${prefix}writer-a-1.tmp`,
        `${prefix}writer-a-2.tmp`,
    ]
    assert.deepEqual(opened, expectedTemps)
    assert.deepEqual(renamed, expectedTemps.map(temp => [temp, stateFile(fixture)]))
    assert.equal(fs.readFileSync(otherWriterTemp, "utf8"), "writer-b")
})

test("temp collision never deletes a file not created by this write", t => {
    const fixture = createFixture(t)
    fs.mkdirSync(fixture.dataPaths.seedStateDir, { recursive: true })
    const collision = path.join(fixture.dataPaths.seedStateDir, ".seed-state.json.collision.tmp")
    fs.writeFileSync(collision, "other-writer")
    const store = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        temporaryFileId: () => "collision",
    })

    assert.throws(() => store.write(expectedBaselineSnapshot()), /EEXIST|file exists/i)
    assert.equal(fs.readFileSync(collision, "utf8"), "other-writer")
    assert.equal(fs.existsSync(stateFile(fixture)), false)
})

test("rename failure preserves disk and validator memory on the second write", t => {
    const fixture = createFixture(t)
    const first = createValidator(fixture)
    first.setSelectedMovieId("normal")
    const beforeBytes = fs.readFileSync(stateFile(fixture))
    const failingFileSystem = {
        ...fs,
        renameSync() {
            throw new Error("simulated rename failure")
        },
    }
    const failingStore = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        fileSystem: failingFileSystem,
        temporaryFileId: () => "rename-failure",
    })
    const validator = createValidator(fixture, { seedStateStore: failingStore })
    const beforeStats = validator.stats("fes")

    assert.throws(() => validator.confirm("fes", 104, 0), /simulated rename failure/)

    assert.deepEqual(validator.stats("fes"), beforeStats)
    assert.deepEqual(fs.readFileSync(stateFile(fixture)), beforeBytes)
    assert.equal(fs.existsSync(temporaryFile(fixture, "rename-failure")), false)
    assert.deepEqual(createValidator(fixture).stats("fes"), beforeStats)
})

test("target, temp, and directory symbolic links never escape the data volume", t => {
    const fixture = createFixture(t)
    const store = createSeedStateStore({
        dataPaths: fixture.dataPaths,
        temporaryFileId: () => "symlink-test",
    })
    const validator = createValidator(fixture, { seedStateStore: store })
    fs.mkdirSync(fixture.dataPaths.seedStateDir, { recursive: true })
    const outsideTarget = path.join(fixture.root, "outside-target.json")
    fs.writeFileSync(outsideTarget, "outside-target")
    if (!createHostSymlink(t, outsideTarget, stateFile(fixture))) return
    assert.throws(() => validator.setSelectedMovieId("normal"), /seed state target.*regular file/i)
    assert.equal(fs.readFileSync(outsideTarget, "utf8"), "outside-target")
    fs.unlinkSync(stateFile(fixture))

    const outsideTemp = path.join(fixture.root, "outside-temp.json")
    fs.writeFileSync(outsideTemp, "outside-temp")
    const symlinkTemp = temporaryFile(fixture, "symlink-test")
    if (!createHostSymlink(t, outsideTemp, symlinkTemp)) return
    assert.throws(() => validator.setSelectedMovieId("normal"), /EEXIST|file exists/i)
    assert.equal(fs.readFileSync(outsideTemp, "utf8"), "outside-temp")
    fs.unlinkSync(symlinkTemp)

    fs.rmdirSync(fixture.dataPaths.seedStateDir)
    const outsideDir = path.join(fixture.root, "outside-dir")
    fs.mkdirSync(outsideDir)
    if (!createHostSymlink(t, outsideDir, fixture.dataPaths.seedStateDir, "dir")) return
    assert.throws(() => createValidator(fixture), /seed state directory must not be a symbolic link/i)
})

for (const boundary of ["target", "temporary"]) {
    test(`${boundary} state path rejects a directory`, t => {
        const fixture = createFixture(t)
        const store = createSeedStateStore({
            dataPaths: fixture.dataPaths,
            temporaryFileId: () => "directory-test",
        })
        const validator = createValidator(fixture, { seedStateStore: store })
        fs.mkdirSync(fixture.dataPaths.seedStateDir, { recursive: true })
        const invalidPath = boundary === "target"
            ? stateFile(fixture)
            : temporaryFile(fixture, "directory-test")
        fs.mkdirSync(invalidPath)

        assert.throws(
            () => validator.setSelectedMovieId("normal"),
            boundary === "target"
                ? /seed state target.*regular file/i
                : /EEXIST|file exists/i,
        )
        assert.equal(fs.lstatSync(invalidPath).isDirectory(), true)
    })
}

for (const boundary of ["data", "state"]) {
    test(`readonly load rejects a symlink at the ${boundary} directory boundary`, t => {
        const fixture = createFixture(t)
        const outside = path.join(fixture.root, `outside-${boundary}`)
        const outsideSeedState = boundary === "data"
            ? path.join(outside, "state", "seeds")
            : path.join(outside, "seeds")
        writeJson(path.join(outsideSeedState, "seed-state.json"), expectedBaselineSnapshot())

        if (boundary === "data") {
            if (!createHostSymlink(t, outside, fixture.dataPaths.dataDir, "dir")) return
        } else {
            fs.mkdirSync(fixture.dataPaths.dataDir)
            if (!createHostSymlink(t, outside, fixture.dataPaths.stateDir, "dir")) return
        }

        assert.throws(
            () => createValidator(fixture),
            new RegExp(`${boundary === "data" ? "data volume root" : "data volume state directory"} must not be a symbolic link`, "i"),
        )
    })
}
