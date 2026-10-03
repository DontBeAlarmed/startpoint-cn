import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"

import { characterAvatarPath, characterFullShotPath, hashedAssetPath } from "../../content/cdn/asset-path-hash"
import {
    getMediumArchiveIndex,
    normalizePngZlibStream,
    toBrowserPng,
} from "../../content/cdn/medium-archive-index"
import {
    getContentSnapshot,
    type ReadonlyContentRepository,
} from "../../content/runtime/content-snapshot"
import { resolveCnCdnRoot } from "../../content/paths"
import { resolveRuntimeDataPaths } from "../../runtime/data-paths"

export interface ContentRoutesOptions {
    /** Resolved `<CDN_DIR>/cn` root; null disables archive lookups. */
    readonly getCdnRoot?: () => string | null
    readonly getRepository?: () => ReadonlyContentRepository
    /** 资产物化目录(<DATA_DIR>/asset-provider);首次取出的立绘落盘,之后静态直出。 */
    readonly assetProviderDir?: string
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

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// 物化缓存修复清扫: 修复管线(toBrowserPng 签名补丁 / normalizePngZlibStream)加入
// 之前落盘的坏文件会被静态直出快路径永久服务(实测凉风 141027 小写 "png" 签名,
// 浏览器拒解码)。启动时校验签名 + IDAT 可解码, 不合格文件删除, 下次请求按现行
// 管线重新物化。一次性 O(缓存大小) 成本, 之后每轮启动为纯校验。
function purgeBrokenMaterializedAvatars(dir: string): number {
    let entries: string[]
    try {
        entries = fs.readdirSync(dir)
    } catch {
        return 0
    }
    let purged = 0
    for (const entry of entries) {
        if (!entry.endsWith(".png")) continue
        const filePath = path.join(dir, entry)
        try {
            const fd = fs.openSync(filePath, "r")
            const head = Buffer.alloc(8)
            fs.readSync(fd, head, 0, 8, 0)
            fs.closeSync(fd)
            if (!head.equals(PNG_SIGNATURE)) throw new Error("bad signature")
            const data = fs.readFileSync(filePath)
            let pos = 8
            let idat = Buffer.alloc(0)
            while (pos + 12 <= data.length) {
                const len = data.readUInt32BE(pos)
                const type = data.toString("latin1", pos + 4, pos + 8)
                if (type === "IDAT") idat = Buffer.concat([idat, data.subarray(pos + 8, pos + 8 + len)])
                pos += 12 + len
            }
            zlib.inflateSync(idat)
        } catch {
            try {
                fs.rmSync(filePath, { force: true })
                purged += 1
            } catch { /* 删除失败不阻塞启动, 坏文件仍会被下次清扫捕获 */ }
        }
    }
    return purged
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

    // 注册期清扫一次物化缓存(坏文件删除, 请求时重物化); 目录缺失等异常静默跳过
    try {
        const purged = purgeBrokenMaterializedAvatars(
            path.join(
                options.assetProviderDir ?? resolveRuntimeDataPaths().assetProviderDir,
                "character-avatar",
            ),
        )
        if (purged > 0) fastify.log.info({ purged }, "purged broken materialized character avatars")
    } catch { /* 清扫不阻塞路由注册 */ }

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
        if (stringId === null || !/^[A-Za-z0-9_]+$/.test(stringId)) {
            return reply.status(404).send({ error: "character not found" })
        }

        const cdnRoot = getCdnRoot()
        if (cdnRoot === null) {
            return reply.status(404).send({ error: "avatar unavailable" })
        }

        // 物化缓存: 首次从归档取出后落盘 <DATA_DIR>/asset-provider/character-avatar,
        // 之后静态直出零解压 (维护者 2026-09-30 定稿的管线物化轻量形态)。
        const cachePath = path.join(
            options.assetProviderDir
                ?? resolveRuntimeDataPaths().assetProviderDir,
            "character-avatar",
            `${stringId}_${evolve}.png`,
        )
        if (fs.existsSync(cachePath)) {
            reply.header("cache-control", "public, max-age=86400")
            return reply.type("image/png").send(fs.createReadStream(cachePath))
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
        // IDAT 重压缩归一化: 部分归档 PNG 的 zlib 流被浏览器拒绝(实测 alk), 见 normalizePngZlibStream
        const browserPng = normalizePngZlibStream(toBrowserPng(payload))
        try {
            // temp + rename 原子落盘: 避免半写文件被永久缓存 (复审A [低])
            fs.mkdirSync(path.dirname(cachePath), { recursive: true })
            const tempPath = `${cachePath}.${process.pid}.tmp`
            fs.writeFileSync(tempPath, browserPng)
            fs.renameSync(tempPath, cachePath)
        } catch {
            // 落盘失败不阻塞响应(下次请求重试物化)
        }
        reply.header("cache-control", "public, max-age=86400")
        return reply.type("image/png").send(browserPng)

    })
}

export default routes;
