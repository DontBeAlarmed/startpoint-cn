const assert = require("node:assert/strict")
const { validateCharacterStackConversion } = require("../out/lib/character-stack")

assert.equal(validateCharacterStackConversion(2, 1, false), null)
assert.equal(validateCharacterStackConversion(2, 2, false), null)
assert.equal(validateCharacterStackConversion(2, 3, false), "Not enough stack.")
assert.equal(validateCharacterStackConversion(2, 1, true), "Protected character cannot be converted.")
assert.equal(validateCharacterStackConversion(2, 0, false), "Invalid conversion count.")
assert.equal(validateCharacterStackConversion(2, -1, false), "Invalid conversion count.")
assert.equal(validateCharacterStackConversion(2, 1.5, false), "Invalid conversion count.")

console.log("character stack tests passed")
