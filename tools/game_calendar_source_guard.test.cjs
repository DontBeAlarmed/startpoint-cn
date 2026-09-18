"use strict"

// Source guard for the game calendar migration: no file under
// src/content/converters may keep private UTC+8 offset arithmetic or its own
// canonical master-timestamp regex. Calendar conversion must go through
// GameCalendarPolicy (src/time/game-calendar.ts) via the converter context.

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const CONVERTERS_DIR = path.join(__dirname, "..", "src", "content", "converters")

// Private fixed-offset arithmetic (verbatim forbidden families from the
// game calendar plan). These intentionally do NOT match `new Date(epochMs)`,
// duration constants like `24 * 60 * 60 * 1000`, or timezone-aware ISO
// handling such as `Date.parse("2024-08-01T12:00:00+08:00")`.
const FORBIDDEN_PATTERNS = [
    { name: "UTC+8 offset arithmetic", pattern: /8\s*\*\s*60\s*\*\s*60/ },
    { name: "UTC+9 offset arithmetic", pattern: /9\s*\*\s*60\s*\*\s*60/ },
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

function findViolations(relativePath, content) {
    const violations = []
    for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
        for (const { name, pattern } of FORBIDDEN_PATTERNS) {
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
