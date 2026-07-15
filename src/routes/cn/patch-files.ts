import { FastifyPluginAsync } from "fastify";

import { openSafeLeaf, openSafeRelativeFile } from "../../lib/safe-root-file";


const ACTIVE_PATCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;
const PREFIX_PATTERN = /^[0-9a-f]{2}$/;
// The production store splits a 40-hex SHA-1 into a 2-hex directory and
// the remaining 38-hex leaf.
const STORE_HASH_PATTERN = /^[0-9a-f]{38}$/;


export interface PatchFileRouteOptions {
    productionRoot: string;
    activeRoot: string;
    onMiss?: (kind: "PATCH-MISS" | "ASSET-PATCH-MISS", detail: string) => void;
}


function auditValue(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 240);
}


export const patchFileRoutes: FastifyPluginAsync<PatchFileRouteOptions> = async (
    fastify,
    options,
) => {
    fastify.get<{ Params: { prefix: string; hash: string } }>(
        "/patch/cn/dummy/download/production/upload/:prefix/:hash",
        async (request, reply) => {
            const { prefix, hash } = request.params;
            if (!PREFIX_PATTERN.test(prefix) || !STORE_HASH_PATTERN.test(hash)) {
                options.onMiss?.("PATCH-MISS", `${auditValue(prefix)}/${auditValue(hash)}`);
                return reply.status(404).type("text/plain").send("Not Found");
            }
            const handle = await openSafeRelativeFile(options.productionRoot, [
                { value: prefix, pattern: PREFIX_PATTERN },
                { value: hash, pattern: STORE_HASH_PATTERN },
            ]);
            if (handle === null) {
                options.onMiss?.("PATCH-MISS", `${prefix}/${hash}`);
                return reply.status(404).type("text/plain").send("Not Found");
            }
            return reply
                .type("application/octet-stream")
                .send(handle.createReadStream({ autoClose: true }));
        },
    );

    fastify.get<{ Params: { file: string } }>(
        "/patch/cn/asset-patch/active/:file",
        async (request, reply) => {
            const { file } = request.params;
            const handle = await openSafeLeaf(options.activeRoot, file, ACTIVE_PATCH_PATTERN);
            if (handle === null) {
                options.onMiss?.("ASSET-PATCH-MISS", auditValue(file));
                return reply.status(404).type("text/plain").send("Not Found");
            }
            return reply
                .type("application/zip")
                .send(handle.createReadStream({ autoClose: true }));
        },
    );
};
