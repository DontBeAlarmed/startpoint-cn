require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const { resolveEventCurrencyId } = require("../src/lib/event-currency")

assert.equal(resolveEventCurrencyId(40236, new Date("2020-08-14T00:00:00Z")), 40236)
assert.equal(resolveEventCurrencyId(40236, new Date("2022-09-20T00:00:00Z")), 999800)
assert.equal(resolveEventCurrencyId(40236, new Date("2023-04-20T00:00:00Z")), 70002)
assert.equal(resolveEventCurrencyId(40236, new Date("2021-01-01T00:00:00Z")), 40236)
assert.equal(resolveEventCurrencyId(10001, new Date("2022-09-20T00:00:00Z")), 10001)

console.log("event currency tests passed")
