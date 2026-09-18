"use strict"

// Source guard for the game calendar migration. Two scanned surfaces:
//
// 1. src/content/converters — no file may keep private UTC+8 offset arithmetic
//    or its own canonical master-timestamp regex. Calendar conversion must go
//    through GameCalendarPolicy (src/time/game-calendar.ts) via the converter
//    context.
// 2. The Task 5 runtime business-calendar files (src/lib/**, src/routes/**) —
//    the same forbidden families, plus offset literals appended to offset-less
//    master data (including underscore-digit variants) and host-local Date
//    getters used in calendar projection. Task 6 appends its own files to
//    RUNTIME_TARGET_FILES / RUNTIME_FILE_EXTRA_PATTERNS when it lands.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const SRC_ROOT = path.join(__dirname, "..", "src")
const CONVERTERS_DIR = path.join(SRC_ROOT, "content", "converters")

// Private fixed-offset arithmetic (verbatim forbidden families from the
// game calendar plan). These intentionally do NOT match `new Date(epochMs)`,
// duration constants like `24 * 60 * 60 * 1000`, or timezone-aware ISO
// handling such as `Date.parse("2024-08-01T12:00:00+08:00")`.
const FORBIDDEN_PATTERNS = [
    { name: "UTC+8 offset arithmetic", pattern: /\b8\s*\*\s*60\s*\*\s*60/ },
    { name: "UTC+9 offset arithmetic", pattern: /\b9\s*\*\s*60\s*\*\s*60/ },
    { name: "literal hour-offset subtraction", pattern: /hour\s*-\s*[89]/ },
    {
        name: "Date.UTC with shifted hour fields",
        pattern: /Date\.UTC\([^\n]*(?:hour\s*-\s*[89]|8\s*\*\s*60)/,
    },
    // Converter-local canonical timestamp regex definitions, e.g.
    // /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/ — converters must
    // validate through the policy parser instead of private regexes.
    {
        name: "private canonical timestamp regex",
        pattern: /\\d\{4\}[^\n]*\\d\{2\}[^\n]*\\d\{2\}/,
    },
]

// Extra forbidden families for the Task 5 runtime files. `\b8` keeps
// `24 * 60 * 60` durations and `86400_000` legal while still matching
// `8 * 3600_000` and `8*60*60*1000` offset literals.
const RUNTIME_EXTRA_PATTERNS = [
    { name: "underscore-digit UTC+8 offset arithmetic", pattern: /\b8\s*\*\s*3600_000/ },
    { name: "underscore-digit UTC+9 offset arithmetic", pattern: /\b9\s*\*\s*3600_000/ },
    {
        name: "fixed offset appended to offset-less master data",
        pattern: /\+0[89]:00/,
    },
    {
        name: "host-local Date getters in calendar projection",
        pattern: /\bget(?:FullYear|Month|Date|Hours|Minutes|Seconds|Day)\(\)/,
    },
]

const RUNTIME_PATTERNS = [...FORBIDDEN_PATTERNS, ...RUNTIME_EXTRA_PATTERNS]

// Task 5 runtime business-calendar files, relative to src/. Task 6 appends
// its files (gacha-catalog/period, gacha-owner/player-period,
// character-growth-content, player-history-catalog, stamina-campaign, and a
// load.ts pattern for the toDateString branch) to these structures.
const RUNTIME_TARGET_FILES = Object.freeze([
    // Task 5 — runtime business calendar migration.
    "lib/time-utils.ts",
    "lib/shop/period.ts",
    "lib/box-gacha-content.ts",
    "lib/box-gacha-reset.ts",
    "lib/bond-token-exchange/catalog.ts",
    "lib/character-election.ts",
    "lib/mission/event-entry-facts.ts",
    "lib/mission/mission-catalog.ts",
    "lib/mission/active-plan-builder.ts",
    "lib/inventory/item-inventory-policy.ts",
    "lib/reward-campaign.ts",
    "lib/news-catalog.ts",
    "lib/news-visibility.ts",
    "lib/pass-card.ts",
    "lib/admin-clairvoyance.ts",
    "routes/cn/load.ts",
])

// Per-file additional forbidden patterns. load.ts stays empty for now: its
// legacy `toDateString()` day-crossing branch (kept, not rejected, until
// Task 6 deletes it) uses no host-local Date getters and no offset literals.
const RUNTIME_FILE_EXTRA_PATTERNS = Object.freeze({})

function runtimePatternsFor(relativePath) {
    return [
        ...RUNTIME_PATTERNS,
        ...(RUNTIME_FILE_EXTRA_PATTERNS[relativePath] ?? []),
    ]
}

function listConverterSourceFiles(dir = CONVERTERS_DIR) {
    const files = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (
        a.name.localeCompare(b.name)
    ))) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...listConverterSourceFiles(entryPath))
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
            files.push(entryPath)
        }
    }
    return files
}

function findViolations(relativePath, content, patterns = FORBIDDEN_PATTERNS) {
    const violations = []
    for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
        for (const { name, pattern } of patterns) {
            if (pattern.test(line)) {
                violations.push(
                    `${relativePath}:${lineIndex + 1}: ${name} (${line.trim()})`,
                )
            }
        }
    }
    return violations
}

function findTreeViolations() {
    const violations = []
    for (const filePath of listConverterSourceFiles()) {
        const relativePath = path.relative(path.dirname(CONVERTERS_DIR), filePath)
        violations.push(...findViolations(relativePath, fs.readFileSync(filePath, "utf8")))
    }
    return violations
}

function findRuntimeViolations() {
    const violations = []
    for (const relativePath of RUNTIME_TARGET_FILES) {
        const filePath = path.join(SRC_ROOT, relativePath)
        if (!fs.existsSync(filePath)) {
            violations.push(`${relativePath}: listed runtime file is missing`)
            continue
        }
        violations.push(...findViolations(
            relativePath,
            fs.readFileSync(filePath, "utf8"),
            runtimePatternsFor(relativePath),
        ))
    }
    return violations
}

test("converters delegate calendar parsing to the game calendar policy", () => {
    const violations = findTreeViolations()
    assert.deepEqual(
        violations,
        [],
        `Converter-local calendar arithmetic is forbidden; migrate to `
            + `ContentConverterContext.gameCalendar (src/time/game-calendar.ts):\n`
            + violations.join("\n"),
    )
})

test("guard scans every .ts file under src/content/converters recursively", () => {
    const files = listConverterSourceFiles()
    assert.ok(files.length > 0, "converter sources must exist")
    for (const required of [
        path.join(CONVERTERS_DIR, "shop", "parser.ts"),
        path.join(CONVERTERS_DIR, "context.ts"),
    ]) {
        assert.ok(files.includes(required), `guard must include ${required}`)
    }
})

test("guard flags each forbidden calendar pattern with path and line", () => {
    const samples = [
        ["const OFFSET_MS = 8 * 60 * 60 * 1000", "UTC+8 offset arithmetic"],
        ["const OFFSET_MS = 9*60*60*1000", "UTC+9 offset arithmetic"],
        ["if (startHour > 0) useHour(hour - 8)", "literal hour-offset subtraction"],
        ["const utc = Date.UTC(year, month, day, 8 * 60, minute, second)", "Date.UTC with shifted hour fields"],
        ["const match = /^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$/.exec(value)", "private canonical timestamp regex"],
    ]
    for (const [line, expected] of samples) {
        const violations = findViolations("sample.ts", `const x = 1 // padding\n${line}`)
        assert.equal(violations.length, 1, `must flag exactly one violation: ${expected}`)
        assert.match(violations[0], /^sample\.ts:2: /, "violation must carry path and line")
    }
})

test("guard allows epoch construction, durations, and timezone-aware ISO handling", () => {
    const allowed = [
        "const wall = new Date(epochMs)",
        "const DAY_MS = 24 * 60 * 60 * 1000",
        "const WEEK_MS = 7 * 24 * 60 * 60 * 1000",
        'const at = Date.parse("2024-08-01T12:00:00+08:00")',
        "const offsetMs = calendar.utcOffsetMinutes * 60_000",
    ]
    for (const line of allowed) {
        assert.deepEqual(
            findViolations("sample.ts", line),
            [],
            `must not reject legitimate code: ${line}`,
        )
    }
})

test("guard scans the Task 5 runtime business calendar files", () => {
    assert.ok(RUNTIME_TARGET_FILES.length > 0, "runtime target list must not be empty")
    const violations = findRuntimeViolations()
    assert.deepEqual(
        violations,
        [],
        `Runtime business calendar files must route every master parse/format `
            + `and bucket calculation through GameCalendarPolicy `
            + `(src/time/game-calendar.ts):\n`
            + violations.join("\n"),
    )
})

test("guard flags runtime offset literals, appended offsets, and local Date getters", () => {
    const samples = [
        ["const shift = nowMs + 8 * 3600_000", "underscore-digit UTC+8 offset arithmetic"],
        ["const shift = nowMs + 9 * 3600_000", "underscore-digit UTC+9 offset arithmetic"],
        ["return new Date(nowMs + 8 * 60 * 60 * 1000 - reset)", "UTC+8 offset arithmetic"],
        ['Date.parse(`${value.replace(" ", "T")}+08:00`)', "fixed offset appended to offset-less master data"],
        ["const label = `${dt.getFullYear()}-${dt.getMonth() + 1}`", "host-local Date getters in calendar projection"],
    ]
    for (const [line, expected] of samples) {
        const violations = findViolations(
            "lib/sample.ts",
            line,
            runtimePatternsFor("lib/sample.ts"),
        )
        assert.ok(
            violations.some(violation => violation.includes(expected)),
            `must flag ${expected}: ${line} -> ${JSON.stringify(violations)}`,
        )
    }
})

test("runtime guard allows epoch construction, durations, policy offsets, and tz-aware ISO parsing", () => {
    const allowed = [
        "const wall = new Date(epochMs)",
        "const shifted = new Date(nowMs + calendar.utcOffsetMinutes * 60_000 - entry.resetTimeMs)",
        "const DAY_MS = 86_400_000",
        "if (epochMs % 1000 !== 0) throw new RangeError()",
        'const publishedAtMs = parseTimezoneAwareCalendarTimestamp(value) // news-time.ts stays explicit-ISO',
        'const at = Date.parse(value) // absolute database timestamp',
    ]
    for (const line of allowed) {
        assert.deepEqual(
            findViolations("lib/sample.ts", line, runtimePatternsFor("lib/sample.ts")),
            [],
            `must not reject legitimate runtime code: ${line}`,
        )
    }
})

test("guard exempts news-time.ts and keeps load.ts toDateString branch unflagged for now", () => {
    // news-time.ts parses explicit timezone-aware ISO values only; it is
    // exempt from the runtime calendar guard by design.
    assert.equal(RUNTIME_TARGET_FILES.includes("lib/news-time.ts"), false)

    // The load.ts legacy toDateString day-crossing comparison survives until
    // Task 6 deletes it; the current load.ts pattern set must not reject it.
    assert.equal((RUNTIME_FILE_EXTRA_PATTERNS["routes/cn/load.ts"] ?? []).length, 0)
    const toDateStringSample = fs
        .readFileSync(path.join(SRC_ROOT, "routes", "cn", "load.ts"), "utf8")
        .split(/\r?\n/)
        .filter(line => line.includes("toDateString()"))
    assert.ok(toDateStringSample.length > 0, "load.ts must still contain the legacy toDateString branch")
    for (const line of toDateStringSample) {
        assert.deepEqual(
            findViolations("routes/cn/load.ts", line, runtimePatternsFor("routes/cn/load.ts")),
            [],
            `Task 6 will delete it; the guard must not reject it yet: ${line.trim()}`,
        )
    }
})
