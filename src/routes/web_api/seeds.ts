import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import seedValidator, { PoolMode, TestPriority, SeedTag } from "../../lib/seed-validator";
import { readdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "..", "assets");

/** Count total seeds across all movie pool files */
function countAllSeeds(): number {
    let total = 0;
    try {
        const files = readdirSync(ASSETS_DIR).filter(f => f.startsWith("gacha_movie_seeds_") && f.endsWith(".json"));
        for (const f of files) {
            try {
                const data = JSON.parse(readFileSync(join(ASSETS_DIR, f), "utf-8"));
                for (const key of Object.keys(data)) {
                    const types = data[key];
                    for (const mt of Object.keys(types)) total += (types[mt] as number[]).length;
                }
            } catch (_) {}
        }
    } catch (_) {}
    // Fallback to default pool
    if (total === 0) {
        const def = join(ASSETS_DIR, "gacha_movie_seeds.json");
        if (existsSync(def)) {
            try {
                const data = JSON.parse(readFileSync(def, "utf-8"));
                for (const key of Object.keys(data)) {
                    const types = data[key];
                    for (const mt of Object.keys(types)) total += (types[mt] as number[]).length;
                }
            } catch (_) {}
        }
    }
    return total > 0 ? total : 19941; // fallback
}

interface ModeBody { mode: PoolMode; priority: TestPriority; }
interface TagBody { seed: number; tag: SeedTag; }
interface TestSeedBody { seed: number; rarity: 3 | 4 | 5; }
interface ClearTestSeedBody { rarity: 3 | 4 | 5; }

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/stats", async (_request: FastifyRequest, reply: FastifyReply) => {
        const s = seedValidator.stats();
        const totalSeeds = countAllSeeds();
        const known = s.verified + s.pending + s.purified_total;
        reply.status(200).send({
            unknown: totalSeeds - known, pending: s.pending, verified: s.verified,
            purified_r3: s.purified_r3, purified_r4: s.purified_r4, purified_r5: s.purified_r5,
            purified_total: s.purified_total,
            test_seeds: s.test_seeds,
            mode: s.mode, priority: s.priority,
            total: totalSeeds, safe: totalSeeds - s.blocked,
            accuracy: totalSeeds > 0 ? Math.round((totalSeeds - s.blocked) / totalSeeds * 100) : 0,
            tested: known, coverage: totalSeeds > 0 ? Math.round(known / totalSeeds * 100) : 0,
        });
    });

    fastify.get("/list", async (_request: FastifyRequest, reply: FastifyReply) => {
        const purified = seedValidator.getPurifiedList();
        reply.status(200).send({ purified });
    });

    fastify.post("/mode", async (request: FastifyRequest, reply: FastifyReply) => {
        const { mode, priority } = request.body as ModeBody;
        if (mode && ['unknown', 'purified'].includes(mode)) seedValidator.setMode(mode);
        if (priority && ['all', '3', '4', '5'].includes(priority)) seedValidator.setPriority(priority);
        reply.status(200).send({ mode: seedValidator.getMode(), priority: seedValidator.getPriority() });
    });

    fastify.post("/tag", async (request: FastifyRequest, reply: FastifyReply) => {
        const { seed, tag } = request.body as TagBody;
        if (typeof seed !== "number" || !['未测试','热血躲避球','普通躲避球','冷血躲避球'].includes(tag)) {
            return reply.status(400).send({ error: "Invalid seed or tag" });
        }
        const ok = seedValidator.setTag(seed, tag);
        reply.status(200).send({ seed, tag, ok });
    });

    fastify.post("/test-seed", async (request: FastifyRequest, reply: FastifyReply) => {
        const { seed, rarity } = request.body as TestSeedBody;
        if (typeof seed !== "number" || ![3,4,5].includes(rarity)) {
            return reply.status(400).send({ error: "Invalid seed or rarity" });
        }
        const ok = seedValidator.setTestSeed(rarity, seed);
        reply.status(200).send({ ok });
    });

    fastify.delete("/test-seed", async (request: FastifyRequest, reply: FastifyReply) => {
        const { rarity } = request.body as ClearTestSeedBody;
        if (![3,4,5].includes(rarity)) return reply.status(400).send({ error: "Invalid rarity" });
        const ok = seedValidator.clearTestSeed(rarity);
        reply.status(200).send({ ok });
    });
};

export default routes;
