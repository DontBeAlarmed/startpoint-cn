import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import {
    GachaSeedCatalog,
    getDefaultGachaSeedCatalog,
} from "../../lib/gacha-seed-catalog"
import {
    GachaSeedQuarantine,
    getDefaultGachaSeedQuarantine,
} from "../../lib/gacha-seed-quarantine"

export interface SeedRoutesOptions {
    catalog?: Pick<GachaSeedCatalog, "status">
    quarantine?: Pick<GachaSeedQuarantine, "stats" | "samples">
}

const QUARANTINE_SAMPLE_LIMIT = 20

const routes = async (fastify: FastifyInstance, options: SeedRoutesOptions) => {
    const catalog = options.catalog ?? getDefaultGachaSeedCatalog()
    const quarantine = options.quarantine ?? getDefaultGachaSeedQuarantine()

    fastify.get("/status", async (_request: FastifyRequest, reply: FastifyReply) => {
        const quarantineStats = quarantine.stats()
        reply.status(200).send({
            catalog: catalog.status(),
            quarantine: {
                ...quarantineStats,
                samples: quarantine.samples(QUARANTINE_SAMPLE_LIMIT),
            },
        })
    })
}

export default routes
