import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { reloadModAssets } from "../../lib/assets";
import { getCnReleaseGraphSnapshot } from "../../lib/cn-asset-graph";
import { getServerTime } from "../../utils";

/**
 * Mod-admin routes (registered under /api/mod-admin).
 *
 * Used by the local mod-tools GUI to push changes to the running server:
 * shop definitions / character metadata are edited directly on disk, then
 * reload_assets makes the server re-read them without a restart.
 */
const routes = async (fastify: FastifyInstance) => {
    fastify.get("/ping", async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.status(200).send({
            ok: true,
            server_time: getServerTime(),
        });
    });

    fastify.get("/cdn-health", async (_request: FastifyRequest, reply: FastifyReply) => {
        const snapshot = getCnReleaseGraphSnapshot();
        const ok = snapshot.issues.length === 0
            && snapshot.supported.every(item => item.reachable);
        reply.status(ok ? 200 : 503).send({
            ok,
            tailVersion: snapshot.tailVersion,
            supported: snapshot.supported,
            issues: snapshot.issues,
        });
    });

    fastify.post("/reload_assets", async (_request: FastifyRequest, reply: FastifyReply) => {
        try {
            const reloaded = reloadModAssets();
            console.log(`[MOD-ADMIN] reload_assets: ${reloaded.length} files re-read from disk`);
            reply.status(200).send({
                ok: true,
                reloaded: reloaded,
            });
        } catch (error) {
            console.error("[MOD-ADMIN] reload_assets failed:", error);
            reply.status(500).send({
                ok: false,
                error: String(error),
            });
        }
    });
};

export default routes;
