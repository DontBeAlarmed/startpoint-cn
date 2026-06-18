import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import seedValidator, { PoolMode, SeedTag } from "../../lib/seed-validator";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "..", "assets");

function countAllSeeds(): number {
    let total = 0;
    try {
        const files = readdirSync(ASSETS_DIR).filter(f => f.startsWith("gacha_movie_seeds_") && f.endsWith(".json"));
        for (const f of files) {
            try {
                const data = JSON.parse(readFileSync(join(ASSETS_DIR, f), "utf-8"));
                for (const key of Object.keys(data)) { const t = data[key]; for (const mt of Object.keys(t)) total += (t[mt] as number[]).length; }
            } catch (_) {}
        }
    } catch (_) {}
    return total > 0 ? total : 19941;
}

interface ModeBody { mode: PoolMode; selectedMovieId?: string; }
interface TagBody { seed: number; tag: SeedTag; movieId: string; }

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/stats", async (request: FastifyRequest, reply: FastifyReply) => {
        const mid = (request.query as any).movieId || seedValidator.getSelectedMovieId();
        const s = seedValidator.stats(mid);
        const totalSeeds = countAllSeeds();
        const known = s.confirmed_total + s.purified_total;
        reply.status(200).send({
            unknown: totalSeeds - known, confirmed: s.confirmed, confirmed_total: s.confirmed_total,
            purified_r3: s.purified_r3, purified_r4: s.purified_r4, purified_r5: s.purified_r5, purified_total: s.purified_total,
            mov_r3: s.mov_r3, mov_r4: s.mov_r4, mov_r5: s.mov_r5, mov_total: s.mov_total,
            test_seeds: s.test_seeds,
            mode: s.mode,
            selectedMovieId: s.selectedMovieId, movieIds: s.movieIds,
            total: totalSeeds,
            tested: known, coverage: totalSeeds > 0 ? Math.round(known / totalSeeds * 100) : 0,
        });
    });

    fastify.get("/list", async (request: FastifyRequest, reply: FastifyReply) => {
        const mid = (request.query as any).movieId || seedValidator.getSelectedMovieId() || 'fes';
        reply.status(200).send({ purified: seedValidator.getPurifiedList(mid), movieId: mid });
    });

    fastify.post("/mode", async (request: FastifyRequest, reply: FastifyReply) => {
        const { mode, selectedMovieId } = request.body as ModeBody;
        if (mode && ['unknown', 'purified'].includes(mode)) seedValidator.setMode(mode);
        if (selectedMovieId) seedValidator.setSelectedMovieId(selectedMovieId);
        reply.status(200).send({ mode: seedValidator.getMode(), selectedMovieId: seedValidator.getSelectedMovieId() });
    });

    fastify.post("/tag", async (request: FastifyRequest, reply: FastifyReply) => {
        const { seed, tag, movieId } = request.body as TagBody;
        if (typeof seed !== "number" || !['未测试','热血躲避球','普通躲避球','冷血躲避球'].includes(tag))
            return reply.status(400).send({ error: "Invalid" });
        const mid = movieId || seedValidator.getSelectedMovieId() || 'fes';
        reply.status(200).send({ seed, tag, ok: seedValidator.setTag(mid, seed, tag) });
    });

    fastify.post("/test-seed", async (request: FastifyRequest, reply: FastifyReply) => {
        const { seed, rarity } = request.body as any;
        const mid = seedValidator.getSelectedMovieId() || 'fes';
        if (typeof seed !== "number" || ![3,4,5].includes(rarity)) return reply.status(400).send({ error: "Invalid" });
        reply.status(200).send({ ok: seedValidator.setTestSeed(mid, rarity, seed) });
    });

    fastify.delete("/test-seed", async (request: FastifyRequest, reply: FastifyReply) => {
        const { rarity } = request.body as any;
        const mid = seedValidator.getSelectedMovieId() || 'fes';
        if (![3,4,5].includes(rarity)) return reply.status(400).send({ error: "Invalid" });
        reply.status(200).send({ ok: seedValidator.clearTestSeed(mid, rarity) });
    });
};

export default routes;
