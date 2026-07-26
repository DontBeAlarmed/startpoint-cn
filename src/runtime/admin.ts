import fastifyStatic from "@fastify/static"
import type { FastifyInstance } from "fastify"
import { lstatSync, readFileSync } from "fs"
import path from "path"

export interface RequiredAdminBuild {
    readonly distDir: string
    readonly indexPath: string
    readonly indexHtml: Buffer
}

function acceptsHtml(accept: string | undefined): boolean {
    if (accept === undefined || accept.trim() === "") return true

    let selectedSpecificity = -1
    let selectedQuality = 0
    for (const mediaRange of accept.split(",")) {
        const [mediaType, ...parameters] = mediaRange.split(";").map(part => part.trim().toLowerCase())
        const specificity = mediaType === "text/html" ? 2
            : mediaType === "text/*" ? 1
                : mediaType === "*/*" ? 0
                    : -1
        if (specificity <= selectedSpecificity) continue

        const qualityParameter = parameters.find(parameter => parameter.startsWith("q="))
        const quality = qualityParameter === undefined ? 1 : Number(qualityParameter.slice(2))
        selectedSpecificity = specificity
        selectedQuality = Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0
    }
    return selectedQuality > 0
}

export function requireAdminBuild(projectRoot: string): RequiredAdminBuild {
    const distDir = path.join(projectRoot, "web", "dist")
    const indexPath = path.join(distDir, "index.html")
    try {
        const distStatus = lstatSync(distDir)
        const indexStatus = lstatSync(indexPath)
        if (distStatus.isSymbolicLink() || !distStatus.isDirectory()
            || indexStatus.isSymbolicLink() || !indexStatus.isFile()) {
            throw new Error("invalid admin build")
        }
        return { distDir, indexPath, indexHtml: readFileSync(indexPath) }
    } catch {
        throw new Error(
            "Required admin build is unavailable: web/dist/index.html must be a regular file; run npm run build:server",
        )
    }
}

export function registerAdminUi(
    fastify: FastifyInstance,
    options: { readonly projectRoot: string },
): void {
    const admin = requireAdminBuild(options.projectRoot)

    fastify.register(fastifyStatic, {
        root: admin.distDir,
        prefix: "/admin/",
        decorateReply: false,
    })

    fastify.get("/", (_request, reply) => reply.redirect("/admin/"))
    fastify.get("/admin", (_request, reply) => reply.redirect("/admin/"))
    fastify.get("/player", (_request, reply) => reply.redirect("/admin/accounts"))
    fastify.get("/player/", (_request, reply) => reply.redirect("/admin/accounts"))
    fastify.get<{ Params: { playerId: string } }>("/player/:playerId", (request, reply) => (
        reply.redirect(`/admin/players/${encodeURIComponent(request.params.playerId)}`)
    ))
    fastify.get("/mail", (_request, reply) => reply.redirect("/admin/mail"))
    fastify.get("/seeds", (_request, reply) => reply.redirect("/admin/seeds"))

    fastify.setNotFoundHandler((request, reply) => {
        const pathname = request.url.split("?", 1)[0]
        const isAdminAsset = pathname.startsWith("/admin/assets/")
        const hasFileExtension = path.posix.extname(pathname) !== ""
        if (request.method === "GET"
            && pathname.startsWith("/admin/")
            && !isAdminAsset
            && !hasFileExtension
            && acceptsHtml(request.headers.accept)) {
            reply.type("text/html; charset=utf-8").send(admin.indexHtml)
            return
        }
        request.log.info({ method: request.method, url: request.url }, "unknown endpoint")
        reply.status(404).send({ error: "Not Found" })
    })
}
