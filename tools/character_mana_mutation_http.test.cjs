"use strict"

require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
    sendManaMutationError,
} = require("../src/routes/api/character/mana-mutation-http")
const {
    ManaNodeMutationValidationError,
} = require("../src/lib/character-mana-mutation-types")

function replyStub() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code
            return this
        },
        send(body) {
            this.body = body
            return this
        },
    }
}

test("mutation request errors remain client errors", () => {
    const reply = replyStub()
    assert.equal(
        sendManaMutationError(
            reply,
            new ManaNodeMutationValidationError("PARENT_NOT_LEARNED", "parent is missing"),
        ),
        true,
    )
    assert.equal(reply.statusCode, 400)
    assert.equal(reply.body.error, "Bad Request")
})

test("mutation content errors are server errors", () => {
    const reply = replyStub()
    assert.equal(
        sendManaMutationError(
            reply,
            new ManaNodeMutationValidationError("CONTENT_INVALID", "malformed parent index"),
        ),
        true,
    )
    assert.equal(reply.statusCode, 500)
    assert.equal(reply.body.error, "Internal Server Error")
})

test("unknown errors are not swallowed by the mutation mapper", () => {
    const reply = replyStub()
    assert.equal(sendManaMutationError(reply, new Error("unexpected")), false)
    assert.equal(reply.statusCode, null)
})
