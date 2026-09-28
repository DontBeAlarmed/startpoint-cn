"use strict"

const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const { getEncyclopediaContent } = require("../src/lib/encyclopedia-content")
const {
    createFrozenTestContentRepository,
} = require("./helpers/content-snapshot-fixture.cjs")

function repository(table) {
    return createFrozenTestContentRepository({ tables: { "encyclopedia.json": table } })
}

test("Encyclopedia adapter caches a frozen projection by repository identity", () => {
    const firstRepository = repository({ "100000101": { read: true } })
    const secondRepository = repository({ "100000102": { read: true } })
    const first = getEncyclopediaContent(firstRepository)
    assert.strictEqual(getEncyclopediaContent(firstRepository), first)
    assert.notStrictEqual(getEncyclopediaContent(secondRepository), first)
    assert.equal(Object.isFrozen(first["100000101"]), true)
})

test("Encyclopedia adapter rejects malformed roots, ids and wire rows", () => {
    assert.throws(() => getEncyclopediaContent(repository([])), /root must be an object/i)
    assert.throws(
        () => getEncyclopediaContent(repository({ "01": { read: true } })),
        /malformed entry 01/i,
    )
    assert.throws(
        () => getEncyclopediaContent(repository({ "100000101": { read: false } })),
        /malformed entry 100000101/i,
    )
})
