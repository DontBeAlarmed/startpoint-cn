import fastifyStatic from "@fastify/static"
import type { FastifyInstance } from "fastify"
import { lstatSync, readFileSync } from "fs"
import path from "path"

export interface RequiredAdminBuild {
    readonly distDir: string
    readonly indexPath: string
    readonly indexHtml: Buffer
}

const ADMIN_ENTRY_REFERENCE_PATTERN = /\b(?:src|href)\s*=\s*(["'])(\/admin\/[^"'?#]+)(?:[?#][^"']*)?\1/gi

function requireRegularAdminFile(filePath: string, label: string): void {
    let status
    try {
        status = lstatSync(filePath)
    } catch {
        throw new Error(`Required admin build is unavailable: ${label} is missing`)
    }
    if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error(`Required admin build is unavailable: ${label} must be a regular file`)
    }
}

function requireAdminEntryAssets(distDir: string, indexHtml: Buffer): void {
    const references = new Set<string>()
    for (const match of indexHtml.toString("utf8").matchAll(ADMIN_ENTRY_REFERENCE_PATTERN)) {
        const encodedPath = match[2].slice("/admin/".length)
        let relativePath: string
        try {
            relativePath = decodeURIComponent(encodedPath)
        } catch {
            throw new Error(`Required admin build is unavailable: invalid admin entry asset ${match[2]}`)
        }
        if (relativePath === ""
            || relativePath.includes("\\")
            || path.posix.isAbsolute(relativePath)
            || path.posix.normalize(relativePath) !== relativePath
            || relativePath.split("/").includes("..")) {
            throw new Error(`Required admin build is unavailable: invalid admin entry asset ${match[2]}`)
        }
        references.add(relativePath)
    }
    if (references.size === 0) {
        throw new Error("Required admin build is unavailable: index.html has no local admin entry assets")
    }
    for (const relativePath of references) {
        requireRegularAdminFile(path.join(distDir, ...relativePath.split("/")), `web/dist/${relativePath}`)
    }
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
    let distStatus
    try {
        distStatus = lstatSync(distDir)
    } catch {
        throw new Error(
            "Required admin build is unavailable: web/dist must be a directory; run npm run build:server",
        )
    }
    if (distStatus.isSymbolicLink() || !distStatus.isDirectory()) {
        throw new Error("Required admin build is unavailable: web/dist must be a directory; run npm run build:server")
    }
    requireRegularAdminFile(indexPath, "web/dist/index.html")
    const indexHtml = readFileSync(indexPath)
    requireAdminEntryAssets(distDir, indexHtml)
    return { distDir, indexPath, indexHtml }
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
