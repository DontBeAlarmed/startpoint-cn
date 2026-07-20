import { createReadStream } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { FastifyInstance, FastifyRequest } from "fastify"
import { resolveContentPaths, type ContentPaths } from "../../content/paths"
import type { ContentSnapshot } from "../../content/runtime/content-snapshot"
import { getContentSnapshot } from "../../content/runtime/content-snapshot"

export interface CnCdnFilesRouteOptions {
    readonly getSnapshot?: () => ContentSnapshot
    readonly paths?: Pick<ContentPaths, "cdnRoot">
}

function requestRelativePath(request: FastifyRequest): string | null {
    const rawUrl = request.raw.url?.split("?", 1)[0] ?? ""
    const prefix = "/patch/cn/"
    if (!rawUrl.startsWith(prefix)) return null
    const rawRelativePath = rawUrl.slice(prefix.length)
    if (/%(?:2e|2f|5c)/i.test(rawRelativePath)) return null

    let relativePath: string
    try {
        relativePath = decodeURIComponent(rawRelativePath)
    } catch {
        return null
    }
    if (!relativePath
        || relativePath.includes("\\")
        || relativePath.startsWith("/")
        || relativePath.includes("//")
        || relativePath.includes("%")) {
        return null
    }
    const segments = relativePath.split("/")
    if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
        return null
    }
    return relativePath
}

function isDescendant(root: string, candidate: string): boolean {
    const relativePath = path.relative(root, candidate)
    return relativePath !== ""
        && !path.isAbsolute(relativePath)
        && relativePath !== ".."
        && !relativePath.startsWith(`..${path.sep}`)
}

function contentType(relativePath: string): string {
    const extension = path.posix.extname(relativePath).toLowerCase()
    if (extension === ".zip") return "application/zip"
    if (extension === ".csv") return "text/csv; charset=utf-8"
    return "application/octet-stream"
}

const routes = async (fastify: FastifyInstance, options: CnCdnFilesRouteOptions) => {
    const snapshot = (options.getSnapshot ?? getContentSnapshot)()
    const paths = options.paths ?? resolveContentPaths({
        projectRoot: path.resolve(__dirname, "../../.."),
    })
    const allowedZipPaths = new Set(
        snapshot.cdn.edges.flatMap(edge => edge.archives.map(archive => archive.relativePath)),
    )

    fastify.get("/patch/cn/recovery/empty.csv", async (_request, reply) => {
        return reply.status(200).type("text/csv; charset=utf-8").send("")
    })

    fastify.get("/patch/cn/*", async (request, reply) => {
        const relativePath = requestRelativePath(request)
        if (relativePath === null) return reply.status(404).send("Not Found")
        if (path.posix.extname(relativePath).toLowerCase() === ".zip"
            && !allowedZipPaths.has(relativePath)) {
            return reply.status(404).send("Not Found")
        }

        const candidate = path.resolve(paths.cdnRoot, ...relativePath.split("/"))
        if (!isDescendant(path.resolve(paths.cdnRoot), candidate)) {
            return reply.status(404).send("Not Found")
        }

        try {
            const [physicalRoot, physicalCandidate, fileStat] = await Promise.all([
                realpath(paths.cdnRoot),
                realpath(candidate),
                stat(candidate),
            ])
            if (!fileStat.isFile() || !isDescendant(physicalRoot, physicalCandidate)) {
                return reply.status(404).send("Not Found")
            }
            return reply.status(200).type(contentType(relativePath)).send(createReadStream(physicalCandidate))
        } catch {
            return reply.status(404).send("Not Found")
        }
    })
}

export default routes
