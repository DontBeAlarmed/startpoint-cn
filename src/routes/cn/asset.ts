import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateDataHeaders } from "../../utils";
import { readdirSync, statSync } from "fs";
import path from "path";

const CN_HOST = process.env.CN_LISTEN_HOST || "localhost";
const CN_PORT = process.env.CN_LISTEN_PORT || "8001";
const HOST = CN_HOST === "0.0.0.0" ? "localhost" : CN_HOST;
const CDN_BASE = process.env.CDN_BASE_URL || `http://${HOST}:${CN_PORT}/patch/cn`;

function getVersionInfo() {
    return {
        base_url: `${CDN_BASE}/EntityLists/`,
        files_list: `${CDN_BASE}/EntityLists/10939-android_medium.csv`,
        total_size: 10500000000,
        delayed_assets_size: 7000000000
    };
}

function buildArchiveList(cdnDir: string, subdir: string): { location: string; size: number; sha256: string }[] {
    const dir = path.join(cdnDir, subdir);
    try {
        return readdirSync(dir)
            .filter(f => f.endsWith(".zip"))
            .map(f => {
                const stats = statSync(path.join(dir, f));
                return {
                    location: `${CDN_BASE}/${subdir}/${f}`,
                    size: stats.size,
                    sha256: ""
                };
            });
    } catch {
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

function buildDiffList(cdnDir: string): { original_version: string; version: string; archive: { location: string; size: number; sha256: string }[] }[] {
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
                    groups.get(to)!.archive.push({ location: `${CDN_BASE}/${subdir}/${f}`, size: stats.size, sha256: "" });
                }
            }
        } catch {}
    }
    return [...groups.entries()]
        .sort(([a], [b]) => compareVersion(a, b))
        .map(([version, data]) => ({ original_version: data.original_version, version, archive: data.archive }));
}

const envCdnDir = process.env.CDN_DIR || ".cdn";
const cdnDir = path.isAbsolute(envCdnDir) ? path.join(envCdnDir, "cn") : path.join(__dirname, "..", "..", "..", envCdnDir, "cn");

const routes = async (fastify: FastifyInstance) => {
    fastify.post("/version_info", async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: getVersionInfo()
        });
    });

    fastify.post("/get_path", async (_request: FastifyRequest, reply: FastifyReply) => {
        const fullArchives = [
            ...buildArchiveList(cdnDir, "archive-common-full"),
            ...buildArchiveList(cdnDir, "archive-medium-full"),
            ...buildArchiveList(cdnDir, "archive-android-full"),
        ];
        const diffArchives = buildDiffList(cdnDir);
        const highestDiffVer = diffArchives.length > 0
            ? diffArchives[diffArchives.length - 1].version
            : "1.4.0";

        reply.header("content-type", "application/x-msgpack");
        reply.status(200).send({
            data_headers: generateDataHeaders(),
            data: {
                info: {
                    client_asset_version: null,
                    target_asset_version: highestDiffVer,
                    eventual_target_asset_version: highestDiffVer,
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
