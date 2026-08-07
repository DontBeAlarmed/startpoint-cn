/**
 * Comic / Manga API — get_list + image serving.
 * Comics are supplied by the runtime's optional external comic directory.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getSession } from "../../data/domains/session"
import { generateDataHeaders } from "../../utils";
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";

interface ComicRouteOptions {
    readonly comicDir?: string | null
    readonly httpDisplayHost?: string
    readonly httpPort?: number
}

export function buildComicBaseUrl(
    requestHost: string | undefined,
    httpDisplayHost = "127.0.0.1",
    httpPort = 8001,
): string {
    if (requestHost) return `http://${requestHost}`
    const host = httpDisplayHost.includes(":") && !httpDisplayHost.startsWith("[")
        ? `[${httpDisplayHost}]`
        : httpDisplayHost
    return `http://${host}:${httpPort}`
}

// Kind 1: 史黛拉的弹射世界讲座 (Stella's Classroom)
function parseKind1(filename: string): { episode: number, title: string } | null {
    const epMatch = filename.match(/第(\d+)课/)
    if (!epMatch) return null
    const episode = parseInt(epMatch[1])
    const titleMatch = filename.match(/今日课程：(.+?)？?\.jpg$/)
    const title = titleMatch ? titleMatch[1] : filename
    return { episode, title }
}

// Kind 0: 弹射小世界 (Flipper World)
// Filenames: "第N话 {title}.jpg"
function parseKind0(filename: string): { episode: number, title: string } | null {
    const match = filename.match(/^第(\d+)话\s+(.+)\.jpg$/)
    if (!match) return null
    return { episode: parseInt(match[1]), title: match[2] }
}

function getComicList(comicDir: string | null, kind: number): { episode: number, title: string, filename: string }[] {
    if (comicDir === null) return []
    const dir = path.join(comicDir, String(kind))
    let files: string[] = []
    try { files = readdirSync(dir) } catch { return [] }

    const parser = kind === 1 ? parseKind1 : parseKind0
    return files
        .filter(f => f.endsWith('.jpg'))
        .map(f => {
            const parsed = parser(f)
            return { episode: parsed?.episode || 0, title: parsed?.title || f, filename: f }
        })
        .sort((a, b) => b.episode - a.episode)  // descending, newest first for getLatestComicData
}

const routes = async (fastify: FastifyInstance, options: ComicRouteOptions) => {
    const comicDir = options.comicDir ?? null
    // Serve comic image by kind + episode (avoids filename encoding issues)
    fastify.get("/image", async (request: FastifyRequest, reply: FastifyReply) => {
        const { kind, episode, size } = request.query as any
        const k = parseInt(kind || "0")
        const ep = parseInt(episode || "0")
        if (!ep) return reply.status(400).send({ error: "Missing episode" })

        if (comicDir === null) return reply.status(404).send({ error: "Not found" })
        const dir = path.join(comicDir, String(k))
        let files: string[] = []
        try { files = readdirSync(dir) } catch { return reply.status(404).send({ error: "Not found" }) }

        const parser = k === 1 ? parseKind1 : parseKind0
        const match = files.find(f => {
            const p = parser(f)
            return p?.episode === ep
        })

        if (!match) return reply.status(404).send({ error: "Not found" })

        // Use subdirectory for thumbnails/main
        let filePath: string
        let contentType: string
        if (size === 's') {
            filePath = path.join(dir, "thumbnail_s", match)
            contentType = "image/jpeg"
        } else if (size === 'l') {
            filePath = path.join(dir, "thumbnail_l", match)
            contentType = "image/jpeg"
        } else {
            // main: try PNG first, fallback to JPG
            const pngPath = path.join(dir, "main", match.replace(/\.jpg$/, '.png'))
            const jpgPath = path.join(dir, "main", match)
            if (existsSync(pngPath)) {
                filePath = pngPath
                contentType = "image/png"
            } else {
                filePath = jpgPath
                contentType = "image/jpeg"
            }
        }

        if (!existsSync(filePath)) return reply.status(404).send({ error: "Not found" })

        reply.header("content-type", contentType)
        reply.header("cache-control", "public, max-age=86400")
        return reply.send(readFileSync(filePath))
    })

    // Comic list (paginated, 9 per page)
    fastify.post("/get_list", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as any
        const viewerId = body.viewer_id
        if (!viewerId || isNaN(viewerId)) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid request body."
        })

        const session = await getSession(viewerId.toString())
        if (!session) return reply.status(400).send({
            error: "Bad Request",
            message: "Invalid viewer id."
        })

        const kind = body.kind || 0
        const comics = getComicList(comicDir, kind)
        const pageIndex = body.page_index ?? 0
        const perPage = 9
        const start = pageIndex * perPage
        const items = comics.slice(start, start + perPage)

        const base = buildComicBaseUrl(
            request.headers.host,
            options.httpDisplayHost,
            options.httpPort,
        )

        reply.header("content-type", "application/x-msgpack")
        return reply.status(200).send({
            data_headers: generateDataHeaders({ viewer_id: viewerId }),
            data: {
                comic_list: items.map(c => ({
                    episode: c.episode,
                    title: c.title,
                    media_image: {
                        main: `${base}/api/index.php/comic/image?kind=${kind}&episode=${c.episode}`,
                        thumbnail_l: `${base}/api/index.php/comic/image?kind=${kind}&episode=${c.episode}&size=l`,
                        thumbnail_s: `${base}/api/index.php/comic/image?kind=${kind}&episode=${c.episode}&size=s`,
                    }
                })),
                current_page_index: pageIndex,
                total_count: comics.length,
            }
        })
    })
}

export default routes
