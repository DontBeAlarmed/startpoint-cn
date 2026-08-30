require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const previousDataDirectory = process.env.DATA_DIR
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "server-news-storage-"))
process.env.DATA_DIR = path.join(dataDirectory, "data")

const { initializeDatabase } = require("../src/data")
const {
    NewsNotFoundError,
    NewsRevisionConflictError,
    createNewsSync,
    deleteNewsSync,
    getAdminNewsSync,
    getVisibleNewsSync,
    listAdminNewsSync,
    listVisibleNewsSync,
    setNewsEnabledSync,
    updateNewsSync,
    validateNewsDraft,
} = require("../src/data/domains/news")
const { validateNewsRichText } = require("../src/lib/news-rich-text")

const draft = {
    category: 2,
    title: "Maintenance",
    publishedAtReal: "2026-08-14T09:00:00.000Z",
    bodyRichText: "<p>Storage is ready.</p>",
    label: 4,
    thumbnail: 7,
    enabled: true,
}

const gameTime = require("../src/runtime/time/game-time")
const timeService = require("../src/utils")

initializeDatabase()

test.after(() => {
    require("../src/data").closeDatabase()
    fs.rmSync(dataDirectory, { recursive: true, force: true })
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
})

function clearNews() {
    require("../src/data/db").getDb().prepare("DELETE FROM server_news").run()
}

test("creates, reads, updates, enables, and deletes admin news", () => {
    clearNews()
    const created = createNewsSync(draft)
    assert.equal(created.category, 2)
    assert.equal(created.publishedAtReal, "2026-08-14T09:00:00.000Z")
    assert.equal(created.revision, 1)
    assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    assert.equal(created.createdAt, created.updatedAt)

    const updated = updateNewsSync(created.id, created.revision, {
        ...draft,
        title: "Maintenance finished",
        bodyRichText: "<p>Done.</p>",
    })
    assert.equal(updated.title, "Maintenance finished")
    assert.equal(updated.revision, 2)

    assert.throws(
        () => updateNewsSync(created.id, 1, draft),
        NewsRevisionConflictError,
    )
    assert.equal(getAdminNewsSync(created.id)?.revision, 2)

    const disabled = setNewsEnabledSync(created.id, updated.revision, false)
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.revision, 3)

    deleteNewsSync(created.id, disabled.revision)
    assert.equal(getAdminNewsSync(created.id), null)
    assert.throws(() => deleteNewsSync(created.id, disabled.revision), NewsNotFoundError)
})

test("lists visible news by category, publication time, and stable descending order", () => {
    clearNews()
    const now = "2026-08-14T12:00:00.000Z"
    createNewsSync({ ...draft, title: "old", publishedAtReal: "2026-08-14T10:00:00Z" })
    createNewsSync({ ...draft, title: "newer", publishedAtReal: "2026-08-14T11:30:00Z" })
    createNewsSync({ ...draft, title: "future", publishedAtReal: "2026-08-14T12:00:00.001Z" })
    createNewsSync({ ...draft, title: "disabled", enabled: false })
    createNewsSync({ ...draft, category: 3, title: "other category" })

    const firstPage = listVisibleNewsSync({ category: 2, nowIso: now, page: 1, pageSize: 20 })
    assert.deepEqual(firstPage.rows.map(row => row.title), ["newer", "old"])
    assert.equal(firstPage.totalCount, 2)
    assert.equal(getVisibleNewsSync(firstPage.rows[0].id, now)?.title, "newer")
    assert.equal(getVisibleNewsSync(firstPage.rows[0].id, "2026-08-14T11:29:59Z"), null)

    const secondPage = listVisibleNewsSync({ category: 2, nowIso: now, page: 2, pageSize: 1 })
    assert.deepEqual(secondPage.rows.map(row => row.title), ["old"])
    assert.equal(secondPage.totalCount, 2)
})

test("lists disabled and future news for administration", () => {
    clearNews()
    createNewsSync({ ...draft, title: "future admin", publishedAtReal: "2027-01-01T00:00:00Z" })
    createNewsSync({ ...draft, title: "disabled admin", enabled: false })
    const admin = listAdminNewsSync(1, 20)
    assert.deepEqual(admin.rows.map(row => row.title), ["future admin", "disabled admin"])
    assert.equal(admin.totalCount, 2)
})

test("normalizes timezone-aware publication times to real UTC ISO", () => {
    const normalized = validateNewsDraft({
        ...draft,
        publishedAtReal: "2026-08-14 18:00:00+08:00",
    })
    assert.equal(normalized.publishedAtReal, "2026-08-14T10:00:00.000Z")
    assert.equal(validateNewsDraft(draft).publishedAtReal, "2026-08-14T09:00:00.000Z")
    assert.throws(() => validateNewsDraft({ ...draft, publishedAtReal: "2026-08-14T09:00:00" }), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, publishedAtReal: "not-a-date" }), TypeError)
    assert.throws(
        () => validateNewsDraft({
            ...draft,
            publishedAtReal: "2026-02-30T00:00:00Z",
        }),
        TypeError,
    )
    assert.throws(
        () => listVisibleNewsSync({
            category: 2,
            nowIso: "2026-02-30T00:00:00Z",
            page: 1,
            pageSize: 20,
        }),
        TypeError,
    )
})

test("audit writes use the real clock abstraction and ignore virtual offset", () => {
    clearNews()
    const originalGetRealNow = gameTime.getRealNow
    const originalTimeOffset = timeService.getTimeOffset()
    const clockValues = [
        new Date("2026-08-14T12:00:00.000Z"),
        new Date("2026-08-14T12:01:00.000Z"),
        new Date("2026-08-14T12:02:00.000Z"),
    ]
    let clockIndex = 0
    gameTime.getRealNow = () => clockValues[clockIndex++]
    timeService.setServerTimeOffset(987654321)

    try {
        const created = createNewsSync(draft)
        assert.equal(created.createdAt, "2026-08-14T12:00:00.000Z")
        assert.equal(created.updatedAt, "2026-08-14T12:00:00.000Z")

        const updated = updateNewsSync(created.id, created.revision, {
            ...draft,
            title: "Real clock update",
        })
        assert.equal(updated.updatedAt, "2026-08-14T12:01:00.000Z")

        const enabled = setNewsEnabledSync(created.id, updated.revision, false)
        assert.equal(enabled.updatedAt, "2026-08-14T12:02:00.000Z")
    } finally {
        gameTime.getRealNow = originalGetRealNow
        timeService.setServerTimeOffset(originalTimeOffset)
    }
})

test("validates required fields, enum ranges, and UTF-16 lengths", () => {
    assert.throws(() => validateNewsDraft(null), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, category: 4 }), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, label: 0 }), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, thumbnail: 14 }), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, title: "" }), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, title: "x".repeat(129) }), TypeError)
    assert.throws(() => validateNewsDraft({ ...draft, bodyRichText: "" }), TypeError)
})

test("allows only whitelisted, balanced RichText without attributes or links", () => {
    assert.equal(validateNewsRichText("<p>Line<br>Second</p>"), "<p>Line<br>Second</p>")
    assert.equal(validateNewsRichText("<ul><li>One</li><li>Two</li></ul>"), "<ul><li>One</li><li>Two</li></ul>")
    assert.equal(validateNewsRichText("<table><tr><th>A</th><td>B</td></tr></table>"), "<table><tr><th>A</th><td>B</td></tr></table>")

    const rejected = [
        "<P>uppercase</P>",
        "<p class=\"x\">attribute</p>",
        "<p><script>alert(1)</script></p>",
        "<!-- comment --><p>text</p>",
        "<!doctype html><p>text</p>",
        "<p>unclosed",
        "</p>orphan",
        "<p>a < b</p>",
        "<p>http://example.invalid</p>",
        "<p>https://example.invalid</p>",
        "<p>www.example.invalid</p>",
        "<p>scene/example</p>",
        "<p>dialog/example</p>",
        "<p>::associate_token::</p>",
    ]
    for (const source of rejected) {
        assert.throws(() => validateNewsRichText(source), TypeError, source)
    }
})
