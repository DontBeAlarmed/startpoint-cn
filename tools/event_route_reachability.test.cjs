require("ts-node/register/transpile-only")

const assert = require("node:assert/strict")
const Fastify = require("fastify")

const raidEventRoutes = require("../src/routes/api/raidEvent").default
const rushEventRoutes = require("../src/routes/api/rushEvent").default

async function main() {
    const fastify = Fastify()
    await fastify.register(rushEventRoutes, { prefix: "/rush" })
    await fastify.register(raidEventRoutes, { prefix: "/raid" })
    await fastify.ready()

    try {
        for (const url of [
            "/rush/ranking",
            "/rush/ranking/played_party",
            "/raid/ranking",
            "/raid/ranking/party",
            "/raid/ranking_reward",
            "/raid/select_folder",
            "/raid/reset",
        ]) {
            const response = await fastify.inject({ method: "POST", url, payload: {} })
            assert.equal(response.statusCode, 404, `${url} must stay outside the CN 1.8.1 route surface`)
        }
    } finally {
        await fastify.close()
    }
}

main().then(
    () => console.log("event route reachability tests passed"),
    error => {
        console.error(error)
        process.exitCode = 1
    },
)
