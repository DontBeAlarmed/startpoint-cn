"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
    buildCharacterElectionCatalog,
    getCharacterElectionCatalog,
    isCharacterElectionOpenAt,
} = require("../src/lib/character-election")
const { createFrozenTestContentRepository } = require("./helpers/content-snapshot-fixture.cjs")

function repository(table = {
    1: {
        stringId: "chara_election_01",
        startTime: "2022-05-02 12:00:00",
        endTime: "2022-05-13 23:59:59",
        keywordIds: [1001, 1002],
    },
}) {
    return createFrozenTestContentRepository({ tables: { "character_election.json": table } })
}

test("Character Election Catalog caches descriptors and hides its keyword Set", () => {
    const source = repository()
    const catalog = getCharacterElectionCatalog(source)
    assert.strictEqual(getCharacterElectionCatalog(source), catalog)
    assert.notStrictEqual(getCharacterElectionCatalog(repository()), catalog)
    const descriptor = catalog.resolve(1)
    assert.equal(descriptor.stringId, "chara_election_01")
    assert.equal("keywordIdSet" in descriptor, false)
    assert.equal(catalog.acceptsKeyword(1, 1001), true)
    assert.equal(catalog.acceptsKeyword(1, 9999), false)
    assert.equal(isCharacterElectionOpenAt(
        descriptor,
        new Date("2022-05-02T12:00:00+08:00"),
    ), true)
})

test("Character Election Catalog rejects malformed rules", () => {
    for (const table of [
        { 1: { stringId: "x", startTime: "bad", endTime: "2022-01-01 00:00:00", keywordIds: [1] } },
        { 1: { stringId: "x", startTime: "2022-01-01 00:00:00", endTime: "2022-01-02 00:00:00", keywordIds: [] } },
        { 1: { stringId: "x", startTime: "2022-01-01 00:00:00", endTime: "2022-01-02 00:00:00", keywordIds: [1, 1] } },
    ]) assert.throws(() => buildCharacterElectionCatalog(repository(table)))
})
