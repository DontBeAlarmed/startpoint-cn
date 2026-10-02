import path from "node:path"

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { characterAvatarPath, characterFullShotPath, hashedAssetPath } from "../../content/cdn/asset-path-hash"
import {
    getMediumArchiveIndex,
    toBrowserPng,
} from "../../content/cdn/medium-archive-index"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import { resolveCnCdnRoot } from "../../content/paths"

export interface ContentRoutesOptions {
    /** Resolved `<CDN_DIR>/cn` root; null disables archive lookups. */
    readonly getCdnRoot?: () => string | null
    readonly getRepository?: () => ReadonlyContentRepository
}

function defaultGetCdnRoot(): string | null {
    try {
        // 3 levels up from src/routes/web_api — and out/routes/web_api alike.
        const projectRoot = path.resolve(__dirname, "../../..")
        return resolveCnCdnRoot(process.env.CDN_DIR ?? ".cdn", projectRoot)
    } catch {
        return null
    }
}

function defaultGetRepository(): ReadonlyContentRepository {
    return getContentSnapshot().repository
}

/** Character table row 0 col 0 holds the asset string_id (e.g. "alk"). */
function readCharacterStringId(repository: ReadonlyContentRepository, characterId: string): string | null {
    let table: unknown
    try {
        table = repository.table<unknown>("cdndata/character.json")
    } catch {
        return null
    }
    if (table === null || typeof table !== "object" || Array.isArray(table)) return null
    const rows = (table as Record<string, unknown>)[characterId]
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) return null
    const stringId = rows[0][0]
    if (typeof stringId !== "string" || stringId.trim() === "") return null
    return stringId
}

function parseEvolveParameter(request: FastifyRequest): 0 | 1 | null {
    const raw = (request.query as Record<string, string | undefined> | null)?.evolve
    if (raw === undefined || raw === "") return 0
    if (raw === "0") return 0
    if (raw === "1") return 1
    return null
}

const routes = async (fastify: FastifyInstance, options: ContentRoutesOptions = {}) => {
    const getCdnRoot = options.getCdnRoot ?? defaultGetCdnRoot
    const getRepository = options.getRepository ?? defaultGetRepository

    fastify.get("/character_avatar/:id", async (request: FastifyRequest, reply: FastifyReply) => {
        const evolve = parseEvolveParameter(request)
        if (evolve === null) {
            return reply.status(400).send({ error: "evolve must be 0 or 1" })
        }

        const characterId = (request.params as { id: string }).id
        if (!/^\d{1,10}$/.test(characterId)) {
            return reply.status(404).send({ error: "character not found" })
        }

        const stringId = readCharacterStringId(getRepository(), characterId)
        if (stringId === null) {
            return reply.status(404).send({ error: "character not found" })
        }

        const cdnRoot = getCdnRoot()
        if (cdnRoot === null) {
            return reply.status(404).send({ error: "avatar unavailable" })
        }

        // Hash the logical path *with* its ".png" suffix, then shard: the
        // stored medium payload sits at production/medium_upload/<xx>/<hash>.
        // 首选 132×132 方形头像(~20KB); 部分角色缺失时回退 full_shot 立绘(大图由前端 object-fit 收成头像)
        const index = getMediumArchiveIndex(path.join(cdnRoot, "archive-medium-full"))
        const primary = characterAvatarPath(stringId, evolve)
        const fallback = characterFullShotPath(stringId, evolve)
        let payload = await index.read(`production/medium_upload/${hashedAssetPath(primary)}`)
        if (payload === null) {
            payload = await index.read(`production/medium_upload/${hashedAssetPath(fallback)}`)
        }
        if (payload === null) {
            return reply.status(404).send({ error: "avatar unavailable" })
        }

        // Content-addressed payload: immutable under the game's asset model.
        reply.header("cache-control", "public, max-age=86400")
        return reply.type("image/png").send(toBrowserPng(payload))
    })
}

export default routes;
