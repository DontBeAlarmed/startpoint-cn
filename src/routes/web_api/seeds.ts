import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import defaultSeedValidator, {
    PoolMode,
    SeedInputError,
    SeedTag,
    SeedValidator,
} from "../../lib/seed-validator";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { validateMovieId } from "../../runtime/seed-state-schema";

const ASSETS_DIR = join(__dirname, "..", "..", "..", "assets");

function countAllSeeds(assetsDir: string): number {
    let total = 0;
    try {
        const files = readdirSync(assetsDir).filter(f => f.startsWith("gacha_movie_seeds_") && f.endsWith(".json"));
        for (const f of files) {
            try {
                const data = JSON.parse(readFileSync(join(assetsDir, f), "utf-8"));
                for (const key of Object.keys(data)) { const t = data[key]; for (const mt of Object.keys(t)) total += (t[mt] as number[]).length; }
            } catch (_) {}
        }
    } catch (_) {}
    return total > 0 ? total : 19941;
}

function countMovieSeeds(movieId: string, assetsDir: string): number {
    const f = `gacha_movie_seeds_${movieId}.json`;
    try {
        const data = JSON.parse(readFileSync(join(assetsDir, f), "utf-8"));
        let total = 0;
        for (const key of Object.keys(data)) { const t = data[key]; for (const mt of Object.keys(t)) total += (t[mt] as number[]).length; }
        return total;
    } catch (_) { return 0; }
}

interface ModeBody { mode: PoolMode; selectedMovieId?: unknown; }
interface TagBody { seed: number; tag: SeedTag; movieId?: unknown; }
export interface SeedRoutesOptions {
    assetsDir?: string;
    seedValidator?: SeedValidator;
}

function requireBodyRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SeedInputError("Invalid seed API request body");
    }
    return value as Record<string, unknown>;
}

const routes = async (fastify: FastifyInstance, options: SeedRoutesOptions) => {
    const assetsDir = options.assetsDir ?? ASSETS_DIR;
    const seedValidator = options.seedValidator ?? defaultSeedValidator;
    fastify.get("/stats", async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as Record<string, unknown>;
        let mid: string;
        try {
            mid = Object.prototype.hasOwnProperty.call(query, "movieId")
                ? validateMovieId(query.movieId)
                : seedValidator.getSelectedMovieId();
        } catch (error) {
            if (error instanceof SeedInputError) {
                return reply.status(400).send({ error: error.message });
            }
            throw error;
        }
        const s = seedValidator.stats(mid);
        const totalSeeds = countAllSeeds(assetsDir);
        const movieTotal = mid ? countMovieSeeds(mid, assetsDir) : 0;
        const known = s.confirm_total + s.play_total + (s.verified_total || 0);
        const perMovieKnown = (s.confirm || 0) + (s.mov_play || 0) + (s.verified || 0);
        reply.status(200).send({
            movieId: mid,
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
        reply.status(200).send({
            play: seedValidator.getPlayList(mid),
            verified: seedValidator.getVerifiedList(mid),
            movieId: mid
        });
    });

    fastify.post("/mode", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const body = requireBodyRecord(request.body) as unknown as ModeBody;
            const hasSelectedMovieId = Object.prototype.hasOwnProperty.call(body, "selectedMovieId");
            const selectedMovieId = hasSelectedMovieId
                ? validateMovieId(body.selectedMovieId)
                : undefined;
            seedValidator.setModeAndSelectedMovieId(body.mode, selectedMovieId);
        } catch (error) {
            if (error instanceof SeedInputError) {
                return reply.status(400).send({ error: error.message });
            }
            throw error;
        }
        reply.status(200).send({ mode: seedValidator.getMode(), selectedMovieId: seedValidator.getSelectedMovieId() });
    });

    fastify.post("/tag", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const body = requireBodyRecord(request.body) as unknown as TagBody;
            const { seed, tag, movieId } = body;
            if (typeof seed !== "number" || !['未测试','热血躲避球','普通躲避球','冷血躲避球'].includes(tag)) {
                throw new SeedInputError("Invalid seed tag request");
            }
            const mid = Object.prototype.hasOwnProperty.call(body, "movieId")
                ? movieId
                : seedValidator.getSelectedMovieId() || 'fes';
            reply.status(200).send({ seed, tag, ok: seedValidator.setTag(mid as string, seed, tag) });
        } catch (error) {
            if (error instanceof SeedInputError) {
                return reply.status(400).send({ error: error.message });
            }
            throw error;
        }
    });

    fastify.post("/test-seed", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const { seed, rarity } = requireBodyRecord(request.body);
            if (typeof seed !== "number" || typeof rarity !== "number" || ![3,4,5].includes(rarity)) {
                throw new SeedInputError("Invalid test seed request");
            }
            const mid = seedValidator.getSelectedMovieId() || 'fes';
            reply.status(200).send({ ok: seedValidator.setTestSeed(mid, rarity as 3 | 4 | 5, seed) });
        } catch (error) {
            if (error instanceof SeedInputError) {
                return reply.status(400).send({ error: error.message });
            }
            throw error;
        }
    });

    fastify.delete("/test-seed", async (request: FastifyRequest, reply: FastifyReply) => {
        const query = request.query as Record<string, unknown>;
        const rawRarity = query.rarity;
        if (typeof rawRarity !== "string" || !/^[345]$/.test(rawRarity)) {
            return reply.status(400).send({ error: "Invalid test seed rarity" });
        }
        const rarity = Number(rawRarity);
        reply.status(200).send({ ok: seedValidator.clearTestSeed(rarity) });
    });
};

export default routes;
