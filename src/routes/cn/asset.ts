import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { readdirSync, statSync, existsSync } from "fs";
import path from "path";

const CN_PORT = process.env.CN_LISTEN_PORT || "8001";
const CDN_BASE = process.env.CDN_BASE_URL;

/** Get CDN base URL from request Host header, fall back to CDN_BASE_URL env or default. */
function getCdnBase(request: FastifyRequest): string {
    if (CDN_BASE) return CDN_BASE;
    const host = request.headers.host || `localhost:${CN_PORT}`;
    return `http://${host}/patch/cn`;
}

/** Detect CDN path-list dir name: `EntityLists` (cn_cdn) or `entities` (cn_cdn_new). */
function entityListsDirName(): string {
    if (existsSync(path.join(cdnDir, "EntityLists"))) return "EntityLists";
    if (existsSync(path.join(cdnDir, "entities"))) return "entities";
    return "EntityLists";
}

function getVersionInfo(baseUrl: string) {
    const el = entityListsDirName();
    return {
        base_url: `${baseUrl}/${el}/`,
        files_list: `${baseUrl}/${el}/10939-android_medium.csv`,
        total_size: TOTAL_SIZE,
        delayed_assets_size: 0
    };
}

function buildArchiveList(baseUrl: string, cdnDir: string, subdir: string): { location: string; size: number; sha256: string }[] {
    const dir = path.join(cdnDir, subdir);
    try {
        return readdirSync(dir)
            .filter(f => f.endsWith(".zip"))
            .map(f => {
                const stats = statSync(path.join(dir, f));
                return {
                    location: `${baseUrl}/${subdir}/${f}`,
                    size: stats.size,
                    sha256: ""
                };
            });
    } catch (e) {
        console.error(`[CDN] buildArchiveList failed for ${subdir}:`, (e as Error).message);
        return [];
    }
}

function parseVersion(v: string): number[] {
    return v.split(".").map(Number);
}

function compareVersion(a: string, b: string): number {
    const av = parseVersion(a), bv = parseVersion(b);
    for (let i = 0; i < 3; i++) {
        if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return 0;
}

function buildDiffList(baseUrl: string, cdnDir: string): { original_version: string; version: string; archive: { location: string; size: number; sha256: string }[] }[] {
    const groups = new Map<string, { original_version: string; archive: { location: string; size: number; sha256: string }[] }>();
    for (const subdir of ["archive-common-diff", "archive-medium-diff", "archive-android-diff"]) {
        const dir = path.join(cdnDir, subdir);
        try {
            for (const f of readdirSync(dir).filter(f => f.endsWith(".zip"))) {
                const match = f.match(/pinball-(\d+\.\d+\.\d+)-(\d+\.\d+\.\d+)-\d+-/);
                if (match) {
                    const from = match[1];
                    const to = match[2];
                    const stats = statSync(path.join(dir, f));
                    if (!groups.has(to)) groups.set(to, { original_version: from, archive: [] });
                    groups.get(to)!.archive.push({ location: `${baseUrl}/${subdir}/${f}`, size: stats.size, sha256: "" });
                }
            }
        } catch (e) {
            console.error(`[CDN] buildDiffList failed for ${subdir}:`, (e as Error).message);
        }
    }
    return [...groups.entries()]
        .sort(([a], [b]) => compareVersion(a, b))
        .map(([version, data]) => ({ original_version: data.original_version, version, archive: data.archive }));
}

const envCdnDir = process.env.CDN_DIR || ".cdn";
const cdnDir = path.isAbsolute(envCdnDir) ? path.join(envCdnDir, "cn") : path.join(__dirname, "..", "..", "..", envCdnDir, "cn");

// 启动时扫描一次，动态计算总大小
const TOTAL_SIZE = (() => {
    let total = 0;
    for (const subdir of ["archive-common-full","archive-medium-full","archive-android-full","archive-common-diff","archive-medium-diff","archive-android-diff"]) {
        try {
            for (const f of readdirSync(path.join(cdnDir, subdir)).filter(f => f.endsWith(".zip")))
                total += statSync(path.join(cdnDir, subdir, f)).size;
        } catch (e) {
            console.error(`[CDN] TOTAL_SIZE failed for ${subdir}:`, (e as Error).message);
        }
    }
    return total;
})();

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/version_info", async (request: FastifyRequest, reply: FastifyReply) => {
        const baseUrl = getCdnBase(request);
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: getVersionInfo(baseUrl)
        });
    });

    fastify.post("/get_path", async (request: FastifyRequest, reply: FastifyReply) => {
        const baseUrl = getCdnBase(request);
        const resVer = request.headers['res_ver'] as string | undefined;
        const fullArchives = [
            ...buildArchiveList(baseUrl, cdnDir, "archive-common-full"),
            ...buildArchiveList(baseUrl, cdnDir, "archive-medium-full"),
            ...buildArchiveList(baseUrl, cdnDir, "archive-android-full"),
        ];
        const diffArchives = buildDiffList(baseUrl, cdnDir);
        const highestDiff = diffArchives.length > 0
            ? diffArchives[diffArchives.length - 1].version
            : "1.4.0";
        const targetVer = resVer ?? highestDiff;

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders({ asset_update: true }),
            data: {
                info: {
                    client_asset_version: resVer ?? "",
                    target_asset_version: targetVer,
                    eventual_target_asset_version: targetVer,
                    is_initial: true,
                    latest_maj_first_version: "1.4.0"
                },
                full: {
                    version: "1.4.0",
                    archive: fullArchives
                },
                diff: diffArchives,
                asset_version_hash: ""
            }
        });
    });
};

export default routes;

export const CDN_TOTAL_SIZE = TOTAL_SIZE;
export const ENTITY_LISTS_DIR = entityListsDirName();
