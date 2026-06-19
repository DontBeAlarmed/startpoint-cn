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

function countMovieSeeds(movieId: string): number {
    const f = `gacha_movie_seeds_${movieId}.json`;
    try {
        const data = JSON.parse(readFileSync(join(ASSETS_DIR, f), "utf-8"));
        let total = 0;
        for (const key of Object.keys(data)) { const t = data[key]; for (const mt of Object.keys(t)) total += (t[mt] as number[]).length; }
        return total;
    } catch (_) { return 0; }
}

interface ModeBody { mode: PoolMode; selectedMovieId?: string; }
interface TagBody { seed: number; tag: SeedTag; movieId: string; }

const routes = async (fastify: FastifyInstance) => {
    fastify.get("/stats", async (request: FastifyRequest, reply: FastifyReply) => {
        const mid = (request.query as any).movieId || seedValidator.getSelectedMovieId();
        const s = seedValidator.stats(mid);
        const totalSeeds = countAllSeeds();
        const movieTotal = mid ? countMovieSeeds(mid) : 0;
        const known = s.confirm_total + s.play_total + (s.verified_total || 0);
        const perMovieKnown = (s.confirm || 0) + (s.mov_play || 0) + (s.verified || 0);
        reply.status(200).send({
            unknown: mid ? Math.max(0, movieTotal - perMovieKnown) : totalSeeds - known,
            movie_total: movieTotal,
            confirm: s.confirm, confirm_total: s.confirm_total,
            play_r3: s.play_r3, play_r4: s.play_r4, play_r5: s.play_r5, play_total: s.play_total,
            mov_play: s.mov_play,
            verified: s.verified || 0, verified_total: s.verified_total || 0,
            pending: s.pending || 0, pending_total: s.pending_total || 0,
            test_seeds: s.test_seeds,
            mode: s.mode,
            selectedMovieId: s.selectedMovieId, movieIds: s.movieIds,
            total: totalSeeds,
            tested: known, coverage: totalSeeds > 0 ? Math.round(known / totalSeeds * 100) : 0,
        });
    });

    fastify.get("/list", async (request: FastifyRequest, reply: FastifyReply) => {
        const mid = (request.query as any).movieId || seedValidator.getSelectedMovieId() || 'fes';
        reply.status(200).send({ play: seedValidator.getPlayList(mid), movieId: mid });
    });

    fastify.post("/mode", async (request: FastifyRequest, reply: FastifyReply) => {
        const { mode, selectedMovieId } = request.body as ModeBody;
        if (mode && ['natural','play','test'].includes(mode)) seedValidator.setMode(mode);
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
        const rarity = Number((request.query as any).rarity);
        const mid = seedValidator.getSelectedMovieId() || 'fes';
        if (![3,4,5].includes(rarity)) return reply.status(400).send({ error: "Invalid" });
        reply.status(200).send({ ok: seedValidator.clearTestSeed(rarity) });
    });
};

export default routes;
