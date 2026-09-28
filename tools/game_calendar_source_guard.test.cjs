"use strict"

// Source guard for the game calendar migration. Three scanned surfaces:
//
// 1. src/content/converters — no file may keep private UTC+8 offset arithmetic
//    or its own canonical master-timestamp regex. Calendar conversion must go
//    through GameCalendarPolicy (src/time/game-calendar.ts) via the converter
//    context.
// 2. The Task 5 runtime business-calendar files (src/lib/**, src/routes/**) —
//    the same forbidden families, plus offset literals appended to offset-less
//    master data (including underscore-digit variants) and host-local Date
//    getters used in calendar projection. Task 6 added its UTC+9/stamina
//    corrections to RUNTIME_TARGET_FILES and banned the load.ts toDateString
//    day-crossing comparison in RUNTIME_FILE_EXTRA_PATTERNS.
// 3. The full production tree (Task 7): every .ts file under src/ is scanned
//    recursively. Only the policy module src/time/game-calendar.ts is exempt
//    from the fixed-offset implementation families and the private master
//    timestamp regex family — it is their canonical implementation — and it
//    still faces the tree-wide projection bans (appended offsets, host-local
//    getters, toDateString). The allowlist is deliberately empty: a site that
//    trips the guard must migrate to GameCalendarPolicy, not be exempted.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const SRC_ROOT = path.join(__dirname, "..", "src")
const CONVERTERS_DIR = path.join(SRC_ROOT, "content", "converters")

// Fixed-offset arithmetic families (verbatim forbidden families from the
// game calendar plan). These intentionally do NOT match `new Date(epochMs)`,
// duration constants like `24 * 60 * 60 * 1000`, or timezone-aware ISO
// handling such as `Date.parse("2024-08-01T12:00:00+08:00")`.
const OFFSET_ARITHMETIC_PATTERNS = [
    { name: "UTC+8 offset arithmetic", pattern: /\b8\s*\*\s*60\s*\*\s*60/ },
    { name: "UTC+9 offset arithmetic", pattern: /\b9\s*\*\s*60\s*\*\s*60/ },
    { name: "literal hour-offset subtraction", pattern: /hour\s*-\s*[89]/ },
    {
        name: "Date.UTC with shifted hour fields",
        pattern: /Date\.UTC\([^\n]*(?:hour\s*-\s*[89]|8\s*\*\s*60)/,
    },
    { name: "underscore-digit UTC+8 offset arithmetic", pattern: /\b8\s*\*\s*3600_000/ },
    { name: "underscore-digit UTC+9 offset arithmetic", pattern: /\b9\s*\*\s*3600_000/ },
    {
        name: "named hour-offset constant pinned to 8 or 9",
        pattern: /\b[A-Z_0-9]*OFFSET_HOURS\s*=\s*[89]\b/,
    },
]

// Converter-local canonical timestamp regex definitions, e.g.
// /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/ — converters must
// validate through the policy parser instead of private regexes.
const FORBIDDEN_PATTERNS = [
    ...OFFSET_ARITHMETIC_PATTERNS,
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

// Task 5 runtime business-calendar files, plus the Task 6 UTC+9/stamina/load
// corrections (gacha-catalog/period, gacha-owner/player-period,
// character-growth-content, player-history-catalog, stamina-campaign; load.ts
// gains a per-file toDateString ban in RUNTIME_FILE_EXTRA_PATTERNS).
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
    // Task 6 — confirmed UTC+9 paths and the stamina host-timezone defect.
    "lib/gacha-catalog/period.ts",
    "lib/gacha-owner/player-period.ts",
    "lib/character-growth-content.ts",
    "lib/player-history-catalog.ts",
    "lib/stamina-campaign.ts",
])

// Per-file additional forbidden patterns. load.ts must never reintroduce the
// legacy host-local `toDateString()` day-crossing comparison on lastLoginTime:
// dailyResetPlayerDataSync already updates it in both crossed-day and
// same-day paths.
const RUNTIME_FILE_EXTRA_PATTERNS = Object.freeze({
    "routes/cn/load.ts": Object.freeze([
        {
            name: "host-local toDateString day-crossing comparison",
            pattern: /\.toDateString\(\)/,
        },
    ]),
})

function runtimePatternsFor(relativePath) {
    return [
        ...RUNTIME_PATTERNS,
        ...(RUNTIME_FILE_EXTRA_PATTERNS[relativePath] ?? []),
    ]
}

// Full production-tree families (Task 7). The appended-offset family only
// rejects appending to a template substitution or a concatenated string;
// a literal timezone-aware ISO value inside one string (news-time.ts style)
// stays legal. The master-regex family matches only the offset-less,
// space-separated `YYYY-MM-DD HH:mm:ss` form, so UTC database serialization
// (`...T...Z`) and timezone-aware validators never trip it.
const PRODUCTION_TREE_FIXED_OFFSET_PATTERNS = OFFSET_ARITHMETIC_PATTERNS

const PRODUCTION_TREE_WIDE_PATTERNS = [
    {
        name: "fixed offset appended to offset-less master data",
        pattern: /\}\+0[89]:00|\+\s*["'`]\s*\+0[89]:00/,
    },
    {
        name: "host-local Date getters in calendar projection",
        pattern: /\bget(?:FullYear|Month|Date|Hours|Minutes|Seconds|Day)\(\)/,
    },
    {
        name: "host-local toDateString day-crossing comparison",
        pattern: /\.toDateString\(\)/,
    },
]

const PRODUCTION_TREE_MASTER_REGEX_PATTERN = {
    name: "private canonical master timestamp regex",
    pattern: /\\d\{4\}[^\n]*\) \(/,
}

const CALENDAR_POLICY_FILE = "time/game-calendar.ts"

// Deliberately empty. If the full-tree scan trips on a site, migrate the site
// to GameCalendarPolicy (or tighten the pattern only if the site is genuinely
// calendar-independent); never add allowlist entries.
const PRODUCTION_TREE_ALLOWLIST = Object.freeze([])

function patternsForProductionFile(relativePath) {
    if (PRODUCTION_TREE_ALLOWLIST.includes(relativePath)) return []
    if (relativePath === CALENDAR_POLICY_FILE) return [...PRODUCTION_TREE_WIDE_PATTERNS]
    return [
        ...PRODUCTION_TREE_WIDE_PATTERNS,
        ...PRODUCTION_TREE_FIXED_OFFSET_PATTERNS,
        PRODUCTION_TREE_MASTER_REGEX_PATTERN,
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

function listProductionSourceFiles(dir = SRC_ROOT) {
    const files = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (
        a.name.localeCompare(b.name)
    ))) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...listProductionSourceFiles(entryPath))
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

function findProductionTreeViolations() {
    const violations = []
    for (const filePath of listProductionSourceFiles()) {
        const relativePath = path.relative(SRC_ROOT, filePath)
        violations.push(...findViolations(
            relativePath,
            fs.readFileSync(filePath, "utf8"),
            patternsForProductionFile(relativePath),
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

test("guard rejects load.ts toDateString comparisons and scans the Task 6 files", () => {
    // news-time.ts parses explicit timezone-aware ISO values only; it is
    // exempt from the runtime calendar guard by design.
    assert.equal(RUNTIME_TARGET_FILES.includes("lib/news-time.ts"), false)

    // Task 6 deleted the load.ts legacy toDateString day-crossing branch;
    // the per-file pattern must now reject any reintroduction, and the load.ts
    // source must prove its absence.
    const loadExtraPatterns = RUNTIME_FILE_EXTRA_PATTERNS["routes/cn/load.ts"] ?? []
    assert.equal(loadExtraPatterns.length, 1)
    const deletedBranchSample =
        "if (now.toDateString() !== player.lastLoginTime.toDateString()) {"
    assert.ok(
        findViolations(
            "routes/cn/load.ts",
            deletedBranchSample,
            runtimePatternsFor("routes/cn/load.ts"),
        ).some(violation => violation.includes("toDateString")),
        "the deleted toDateString branch must now be rejected by the guard",
    )
    const loadSource = fs
        .readFileSync(path.join(SRC_ROOT, "routes", "cn", "load.ts"), "utf8")
    assert.doesNotMatch(
        loadSource,
        /\.toDateString\(\)/,
        "load.ts must not contain the legacy toDateString day-crossing branch",
    )
    for (const required of [
        "lib/gacha-catalog/period.ts",
        "lib/gacha-owner/player-period.ts",
        "lib/character-growth-content.ts",
        "lib/player-history-catalog.ts",
        "lib/stamina-campaign.ts",
    ]) {
        assert.ok(
            RUNTIME_TARGET_FILES.includes(required),
            `Task 6 file must stay guarded: ${required}`,
        )
    }
})

test("guard enumerates every production .ts file under src recursively", () => {
    const files = listProductionSourceFiles()
    assert.ok(
        files.length > RUNTIME_TARGET_FILES.length,
        "full-tree enumeration must exceed the explicit runtime list",
    )
    for (const required of [
        path.join(SRC_ROOT, "time", "game-calendar.ts"),
        path.join(SRC_ROOT, "time", "game-calendar-provider.ts"),
        path.join(SRC_ROOT, "routes", "cn", "load.ts"),
        path.join(SRC_ROOT, "content", "converters", "context.ts"),
        path.join(SRC_ROOT, "lib", "news-time.ts"),
        path.join(SRC_ROOT, "multi", "management", "service.ts"),
    ]) {
        assert.ok(
            files.includes(required),
            `full-tree scan must include ${required}`,
        )
    }
})

test("full production tree contains no hardcoded calendar implementation", () => {
    assert.equal(
        PRODUCTION_TREE_ALLOWLIST.length,
        0,
        "the production-tree allowlist must stay empty; migrate sites to GameCalendarPolicy instead",
    )
    const violations = findProductionTreeViolations()
    assert.deepEqual(
        violations,
        [],
        `Production sources must route calendar math through GameCalendarPolicy `
            + `(src/time/game-calendar.ts); only the policy module may implement `
            + `the fixed offset and the canonical master format:\n`
            + violations.join("\n"),
    )
})

test("full-tree guard flags every audited hardcoded calendar form", () => {
    const samples = [
        ["const CN_OFFSET_MS = 8 * 60 * 60 * 1000", "UTC+8 offset arithmetic"],
        ["const shiftMs = 9*60*60*1000", "UTC+9 offset arithmetic"],
        ["const shift = nowMs + 8 * 3600_000", "underscore-digit UTC+8 offset arithmetic"],
        ["const shift = nowMs + 9 * 3600_000", "underscore-digit UTC+9 offset arithmetic"],
        ["if (startHour > 0) useHour(hour - 9)", "literal hour-offset subtraction"],
        ["const utc = Date.UTC(year, month, day, 8 * 60, minute)", "Date.UTC with shifted hour fields"],
        ["JST_OFFSET_HOURS = 9", "named hour-offset constant pinned to 8 or 9"],
        ['Date.parse(`${value.replace(" ", "T")}+08:00`)', "fixed offset appended to offset-less master data"],
        ['const appended = rawValue + "+09:00"', "fixed offset appended to offset-less master data"],
        ["const label = `${dt.getFullYear()}-${dt.getMonth() + 1}`", "host-local Date getters in calendar projection"],
        ["if (now.toDateString() !== login.toDateString()) throw new Error()", "host-local toDateString day-crossing comparison"],
        ['const match = /^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$/.exec(value)', "private canonical master timestamp regex"],
    ]
    for (const [line, expected] of samples) {
        const violations = findViolations(
            "lib/sample.ts",
            `const padding = 1 // unrelated\n${line}`,
            patternsForProductionFile("lib/sample.ts"),
        )
        assert.ok(
            violations.some(violation => violation.includes(expected)),
            `full-tree guard must flag ${expected}: ${line} -> ${JSON.stringify(violations)}`,
        )
    }
})

test("full-tree guard keeps UTC serialization, tz-aware ISO, durations, and the policy module legal", () => {
    // The policy module is the canonical implementation of the fixed offset
    // and the master format, but tree-wide bans still face it.
    const policyPatterns = patternsForProductionFile("time/game-calendar.ts")
    assert.deepEqual(findViolations(
        "time/game-calendar.ts",
        'const MASTER_TIMESTAMP = /^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$/',
        policyPatterns,
    ), [])
    assert.deepEqual(findViolations(
        "time/game-calendar.ts",
        "const wallMs = epochMs + offsetMinutes * MS_PER_MINUTE",
        policyPatterns,
    ), [])
    assert.equal(
        findViolations(
            "time/game-calendar.ts",
            "return value.toDateString()",
            policyPatterns,
        ).length,
        1,
        "tree-wide projection bans still apply to the policy module",
    )

    // UTC database/protocol serialization stays legal outside the policy.
    assert.deepEqual(findViolations(
        "multi/management/service.ts",
        'const ISO_TIMESTAMP_PATTERN = /^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d{1,3})?Z$/',
        patternsForProductionFile("multi/management/service.ts"),
    ), [])

    // news-time.ts explicit timezone-aware ISO handling stays legal.
    assert.deepEqual(findViolations(
        "lib/news-time.ts",
        'const TIMEZONE_AWARE_TIMESTAMP = /^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?(Z|[+-]\\d{2}:\\d{2})$/',
        patternsForProductionFile("lib/news-time.ts"),
    ), [])

    const allowed = [
        "const wall = new Date(epochMs)",
        "const DAY_MS = 24 * 60 * 60 * 1000",
        "const shifted = new Date(nowMs + calendar.utcOffsetMinutes * 60_000 - entry.resetTimeMs)",
        'const at = Date.parse("2024-08-01T12:00:00+08:00")',
        "const offsetMs = calendar.utcOffsetMinutes * 60_000",
        "if (epochMs % 1000 !== 0) throw new RangeError()",
    ]
    for (const line of allowed) {
        assert.deepEqual(
            findViolations("lib/sample.ts", line, patternsForProductionFile("lib/sample.ts")),
            [],
            `must not reject legitimate code: ${line}`,
        )
    }
})
