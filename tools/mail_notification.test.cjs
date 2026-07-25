const assert = require("node:assert/strict")
require("ts-node/register/transpile-only")

const mailModulePath = require.resolve("../src/data/domains/mail")
require.cache[mailModulePath] = {
    id: mailModulePath,
    filename: mailModulePath,
    loaded: true,
    exports: {
        getPlayerMailCountSync: (playerId, unreceivedOnly) => (
            unreceivedOnly && playerId === 7 ? 2 : 0
        ),
    },
}

const { getMailArrivedSync } = require("../src/lib/mail-notification")
assert.equal(getMailArrivedSync(7), true)
assert.equal(getMailArrivedSync(8), false)
console.log("mail notification tests passed")
