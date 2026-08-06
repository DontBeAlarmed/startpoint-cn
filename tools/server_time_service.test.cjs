require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { getTimeOffset, setServerTimeOffset } = require("../src/utils")
const {
  ServerTimeStore,
  ServerTimeStoreError,
} = require("../src/runtime/server-time/store")
const {
  ServerTimeService,
  ServerTimeServiceError,
} = require("../src/runtime/server-time/service")

const NOW_MS = Date.parse("2026-08-06T03:00:00.000Z")
const TARGET_MS = Date.parse("2024-08-14T12:00:00.000Z")
const DEFAULT_DATE = "2024-08-14T12:00:00.000Z"

function makePaths() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-time-test-"))
  return {
    dataDir,
    filePath: path.join(dataDir, "server-time.json"),
    legacyFilePath: path.join(dataDir, "state", "active_account.json"),
  }
}

function makeStore(paths, options = {}) {
  fs.mkdirSync(path.dirname(paths.legacyFilePath), { recursive: true })
  return new ServerTimeStore({
    filePath: paths.filePath,
    legacyFilePath: paths.legacyFilePath,
    now: () => NOW_MS,
    ...options,
  })
}

function freshService(options = {}) {
  const paths = makePaths()
  const store = makeStore(paths, options.store)
  return { paths, store, service: new ServerTimeService({ store }) }
}

function assertCode(error, code) {
  assert.equal(error && error.code, code)
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

test("exports a fixed offset that remains stable when imported later", () => {
  const { service } = freshService()
  const exported = service.setAbsoluteTime(TARGET_MS, { nowMs: NOW_MS })

  assert.equal(exported.mode, "offset")
  assert.equal(exported.offsetMs, TARGET_MS - NOW_MS)
  assert.equal(exported.generatedAt, "2026-08-06T03:00:00.000Z")

  const delayed = service.importPackage(exported, {
    nowMs: NOW_MS + 10 * 86400000,
  })
  assert.equal(delayed.mode, "offset")
  assert.equal(delayed.offsetMs, exported.offsetMs)
  assert.equal(
    delayed.serverTimeMs,
    NOW_MS + 10 * 86400000 + exported.offsetMs,
  )
})

test("system mode persists and applies zero offset", () => {
  const { service } = freshService()
  const system = service.setSystemTime({ nowMs: NOW_MS })

  assert.deepEqual(system, {
    mode: "system",
    offsetMs: 0,
    generatedAt: "2026-08-06T03:00:00.000Z",
    serverTimeMs: NOW_MS,
  })
  assert.equal(getTimeOffset(), null)
})

test("store accepts only the exact three canonical fields", () => {
  const { paths, store } = freshService()
  store.write({
    mode: "offset",
    offsetMs: TARGET_MS - NOW_MS,
    generatedAt: "2026-08-06T03:00:00.000Z",
  })
  assert.deepEqual(store.read(), {
    mode: "offset",
    offsetMs: TARGET_MS - NOW_MS,
    generatedAt: "2026-08-06T03:00:00.000Z",
  })
  assert.equal(fs.statSync(paths.filePath).mode & 0o777, 0o600)

  for (const value of [
    {
      mode: "offset",
      offsetMs: 0,
      generatedAt: "2026-08-06T03:00:00.000Z",
      extra: true,
    },
    {
      mode: "invalid",
      offsetMs: 0,
      generatedAt: "2026-08-06T03:00:00.000Z",
    },
    {
      mode: "offset",
      offsetMs: Number.MAX_SAFE_INTEGER + 1,
      generatedAt: "2026-08-06T03:00:00.000Z",
    },
    {
      mode: "offset",
      offsetMs: 0,
      generatedAt: "not-an-iso-date",
    },
  ]) {
    assert.throws(() => store.write(value), error => {
      assertCode(error, "INVALID_SERVER_TIME_STATE")
      return true
    })
  }
})

test("rejects invalid imports without changing the current in-memory offset", () => {
  const { service } = freshService()
  service.setAbsoluteTime(TARGET_MS, { nowMs: NOW_MS })
  const previousOffset = getTimeOffset()

  for (const value of [
    {
      mode: "offset",
      offsetMs: 0,
      generatedAt: "2026-08-06T03:00:00.000Z",
      extra: true,
    },
    {
      mode: "invalid",
      offsetMs: 0,
      generatedAt: "2026-08-06T03:00:00.000Z",
    },
    {
      mode: "offset",
      offsetMs: Number.MAX_SAFE_INTEGER + 1,
      generatedAt: "2026-08-06T03:00:00.000Z",
    },
    {
      mode: "offset",
      offsetMs: 0,
      generatedAt: "2026-08-06T03:00:00.000Zx",
    },
  ]) {
    assert.throws(() => service.importPackage(value, { nowMs: NOW_MS }), error => {
      assertCode(error, "INVALID_SERVER_TIME_STATE")
      return true
    })
    assert.equal(getTimeOffset(), previousOffset)
  }
})

test("rejects missing, corrupt, directory, and symlink server-time files distinctly", () => {
  const { paths, store } = freshService()
  assert.equal(store.read(), null)

  fs.writeFileSync(paths.filePath, "{")
  assert.throws(() => store.read(), error => {
    assertCode(error, "INVALID_SERVER_TIME_STATE")
    return true
  })

  fs.unlinkSync(paths.filePath)
  fs.mkdirSync(paths.filePath)
  assert.throws(() => store.read(), error => {
    assertCode(error, "INVALID_SERVER_TIME_STATE")
    return true
  })

  fs.rmSync(paths.filePath, { recursive: true })
  const target = path.join(paths.dataDir, "real-server-time.json")
  fs.writeFileSync(target, JSON.stringify({
    mode: "system",
    offsetMs: 0,
    generatedAt: "2026-08-06T03:00:00.000Z",
  }))
  fs.symlinkSync(target, paths.filePath)
  assert.throws(() => store.read(), error => {
    assertCode(error, "INVALID_SERVER_TIME_STATE")
    return true
  })
})

test("a failed write leaves the in-memory server time unchanged", () => {
  const paths = makePaths()
  let failReplace = false
  const store = makeStore(paths, {
    replaceFile: (temporaryPath, filePath) => {
      if (failReplace) throw new Error("replace failed")
      fs.renameSync(temporaryPath, filePath)
    },
  })
  const service = new ServerTimeService({ store })
  setServerTimeOffset(null)

  service.setAbsoluteTime(TARGET_MS, { nowMs: NOW_MS })
  const previousOffset = getTimeOffset()
  failReplace = true
  assert.throws(
    () => service.importPackage({
      mode: "system",
      offsetMs: 0,
      generatedAt: "2026-08-06T03:00:00.000Z",
    }, { nowMs: NOW_MS }),
    /replace failed/,
  )
  assert.equal(getTimeOffset(), previousOffset)
})

test("migrates a finite legacy active account offset only when the new file is absent", () => {
  const { paths, store, service } = freshService()
  fs.writeFileSync(paths.legacyFilePath, JSON.stringify({ timeOffset: 12345 }))

  const restored = service.restore({ nowMs: NOW_MS })
  assert.equal(restored.mode, "offset")
  assert.equal(restored.offsetMs, 12345)
  assert.equal(store.read().offsetMs, 12345)

  fs.writeFileSync(paths.filePath, "{")
  assert.throws(() => service.restore({ nowMs: NOW_MS }), error => {
    assertCode(error, "INVALID_SERVER_TIME_STATE")
    return true
  })
})

test("migrates a finite fractional legacy active account offset", () => {
  const { paths, store, service } = freshService()
  fs.writeFileSync(paths.legacyFilePath, JSON.stringify({ timeOffset: 1.5 }))

  const restored = service.restore({ nowMs: NOW_MS })
  assert.equal(restored.offsetMs, 1.5)
  assert.equal(store.read().offsetMs, 1.5)
})

test("uses the project default date when no valid state exists", () => {
  const { paths, service } = freshService()
  const restored = service.restore({ nowMs: NOW_MS })

  assert.equal(restored.mode, "offset")
  assert.equal(restored.offsetMs, Date.parse(DEFAULT_DATE) - NOW_MS)
  assert.equal(restored.generatedAt, "2026-08-06T03:00:00.000Z")
})

test("rejects a corrupt new file with INVALID_SERVER_TIME_STATE", () => {
  const { paths, service } = freshService()
  fs.writeFileSync(paths.filePath, "not-json")

  assert.throws(() => service.restore({ nowMs: NOW_MS }), error => {
    assertCode(error, "INVALID_SERVER_TIME_STATE")
    assert.equal(error instanceof ServerTimeServiceError, true)
    return true
  })
})

test("does not treat an invalid legacy offset as a valid migration", () => {
  const { paths, service } = freshService()
  fs.writeFileSync(paths.legacyFilePath, JSON.stringify({ timeOffset: Infinity }))

  const restored = service.restore({ nowMs: NOW_MS })
  assert.equal(restored.offsetMs, Date.parse(DEFAULT_DATE) - NOW_MS)
})

async function main() {
  let passed = 0
  for (const current of tests) {
    try {
      await current.fn()
      passed += 1
      console.log(`ok - ${current.name}`)
    } catch (error) {
      console.error(`not ok - ${current.name}`)
      console.error(error)
      throw error
    }
  }
  console.log(`${passed}/${tests.length} tests passed`)
}

main().catch(() => process.exitCode = 1)
