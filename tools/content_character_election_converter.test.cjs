const assert = require("node:assert/strict")
const test = require("node:test")

require("ts-node/register/transpile-only")

const {
    convertCharacterElections,
} = require("../src/content/converters/character-election")
const {
    getValidatedCharacterElectionRule,
} = require("../src/lib/character-election")

function csvRow(overrides = {}) {
    const fields = Array(37).fill("")
    fields[0] = "1"
    fields[27] = "(None)"
    for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
    return fields.join(",")
}

function encyclopediaRow({
    multipliedId,
    secret = "false",
    kind = "0",
    characterId = "1",
}) {
    const fields = Array(40).fill("")
    fields[0] = multipliedId
    fields[1] = `keyword_${multipliedId}`
    fields[2] = secret
    fields[3] = "2022-01-01 00:00:00"
    fields[4] = kind
    fields[5] = characterId
    fields[21] = "(None)"
    fields[22] = "(None)"
    fields[23] = "(None)"
    fields[27] = "(None)"
    fields[31] = "(None)"
    fields[32] = "(None)"
    fields[33] = "(None)"
    fields[34] = "(None)"
    fields[36] = "(None)"
    return fields.join(",")
}

function fixture() {
    return {
        electionRows: [{
            key: "1",
            text: "chara_election_01,dynamic/election,2022-05-02 12:00:00,2022-05-13 23:59:59",
        }],
        excludeRows: [{ key: "1", text: "1000006\n1000007" }],
        characterRows: [
            { key: "1", text: csvRow() },
            { key: "2", text: csvRow({ 0: "2", 27: "1" }) },
            { key: "3", text: csvRow({ 0: "3", 27: "3" }) },
            { key: "4", text: csvRow({ 0: "4" }) },
            { key: "5", text: csvRow({ 0: "5" }) },
            { key: "6", text: csvRow({ 0: "6" }) },
            { key: "7", text: csvRow({ 0: "7" }) },
        ],
        encyclopediaRows: [
            { key: "1000001", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000101" }) }] },
            { key: "1000002", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000201", characterId: "2" }) }] },
            { key: "1000003", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000301", characterId: "3" }) }] },
            { key: "1000004", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000401", secret: "true", characterId: "4" }) }] },
            { key: "1000005", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000501", kind: "1", characterId: "5" }) }] },
            { key: "1000006", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000601", characterId: "6" }) }] },
            { key: "1000007", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "100000701", characterId: "7" }) }] },
            { key: "2000001", rows: [{ key: "1", text: encyclopediaRow({ multipliedId: "200000101", kind: "2", characterId: "" }) }] },
        ],
    }
}

test("character election converter reproduces the CN client candidate filter", () => {
    const result = convertCharacterElections(fixture())
    assert.deepEqual(result, {
        "character_election.json": {
            "1": {
                stringId: "chara_election_01",
                startTime: "2022-05-02 12:00:00",
                endTime: "2022-05-13 23:59:59",
                keywordIds: [1000001, 1000003, 2000001],
            },
        },
    })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result["character_election.json"]["1"].keywordIds), true)
})

test("character election converter rejects malformed authoritative sources", () => {
    const invalidDate = fixture()
    invalidDate.electionRows[0] = {
        ...invalidDate.electionRows[0],
        text: "chara_election_01,dynamic/election,2022-02-31 12:00:00,2022-05-13 23:59:59",
    }
    assert.throws(
        () => convertCharacterElections(invalidDate),
        /invalid character election content: election\[1\] startTime/,
    )

    const missingCharacter = fixture()
    missingCharacter.characterRows = missingCharacter.characterRows.filter(row => row.key !== "7")
    assert.throws(
        () => convertCharacterElections(missingCharacter),
        /missing character 7/,
    )

    const duplicateMainRow = fixture()
    duplicateMainRow.encyclopediaRows[0] = {
        ...duplicateMainRow.encyclopediaRows[0],
        rows: [
            ...duplicateMainRow.encyclopediaRows[0].rows,
            { key: "1", text: encyclopediaRow({ multipliedId: "100000102" }) },
        ],
    }
    assert.throws(
        () => convertCharacterElections(duplicateMainRow),
        /must have exactly one main row/,
    )

    for (const year of ["1969", "2201"]) {
        const invalidYear = fixture()
        invalidYear.electionRows[0] = {
            ...invalidYear.electionRows[0],
            text: `chara_election_01,dynamic/election,${year}-05-02 12:00:00,2022-05-13 23:59:59`,
        }
        assert.throws(
            () => convertCharacterElections(invalidYear),
            /invalid character election content: election\[1\] startTime/,
        )
    }
})

test("character election runtime rejects years outside the CN master parser range", () => {
    const table = {
        "1": {
            stringId: "chara_election_01",
            startTime: "2022-05-02 12:00:00",
            endTime: "2022-05-13 23:59:59",
            keywordIds: [1000001],
        },
    }
    assert.notEqual(getValidatedCharacterElectionRule(table, 1), null)
    for (const year of ["1969", "2201"]) {
        assert.equal(getValidatedCharacterElectionRule({
            "1": { ...table["1"], startTime: `${year}-05-02 12:00:00` },
        }, 1), null)
    }
})
