"use strict"

require("./test-workflow/bootstrap.cjs").bootstrap()

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    parsePositiveSafeIntegerMasterValue,
} = require("../src/lib/mission/master-value")

test("positive master integers preserve exact signed-string boundary semantics", () => {
    assert.equal(parsePositiveSafeIntegerMasterValue("+0"), undefined)
    assert.equal(parsePositiveSafeIntegerMasterValue("-0"), undefined)
    assert.equal(parsePositiveSafeIntegerMasterValue(-0), undefined)
    assert.equal(parsePositiveSafeIntegerMasterValue("00042"), 42)
    assert.equal(parsePositiveSafeIntegerMasterValue("+42"), 42)
    assert.equal(
        parsePositiveSafeIntegerMasterValue(`+${Number.MAX_SAFE_INTEGER}`),
        Number.MAX_SAFE_INTEGER,
    )
})
