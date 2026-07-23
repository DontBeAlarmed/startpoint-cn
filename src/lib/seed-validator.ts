/**
 * Seed Validator — 种子验证系统
 *
 * 池:
 *   confirmPool — play=0，rarity 正确
 *   playPool — play=1，rarity 正确
 *   verifiedPool — play=1 + rarity 已验证
 *   pendingPool — /crash 已知 r，待重测
 *
 * 选择优先级:
 *   natural: testSeed > playPool(10%/first) > verifiedPool > confirmPool > playFallback > pending > unknown
 *   play:    testSeed > playPool > playFallback > confirmPool > ...
 *   test:    testSeed > playPool > pendingPool > unknown
 */

import { readFileSync } from "fs";
import { join } from "path";
import { RuntimeDataPaths } from "../runtime/data-paths";
import {
    createSeedStateStore,
    SeedStateStore,
} from "../runtime/seed-state-store";
import {
    createSeedRecord,
    SeedInputError,
    SeedMovieId,
    SeedRuntimeSnapshot,
    SEED_MOVIE_IDS,
    SerializedSeedTag,
    validateMovieId,
    validateRarityIndex,
    validateRuntimeSeed,
    validateSeedRuntimeSnapshot,
    validateSeedTag,
    validateTestSeed,
} from "../runtime/seed-state-schema";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");
const CONFIRMED_FILE = "confirmed_seeds.json";
const PURIFIED_FILE = "purified_seeds.json";
const VERIFIED_FILE = "verified_seeds.json";
const CONFIG_FILE = "pool_config.json";
const TEST_SEEDS_FILE = "test_seeds.json";

export type PoolMode = 'natural' | 'play' | 'test';
export type SeedTag = SerializedSeedTag;
export { SeedInputError } from "../runtime/seed-state-schema";

interface PlayEntry { r: number; tag: SeedTag; play?: boolean }

interface MutationScope {
    movieIds?: readonly SeedMovieId[];
    testSeeds?: boolean;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

export interface SeedValidatorLogger {
    log(message: string): void;
    warn(message: string): void;
}

export interface SeedValidatorOptions {
    assetsDir?: string;
    dataPaths?: RuntimeDataPaths;
    logger?: SeedValidatorLogger;
    seedStateStore?: SeedStateStore;
    onPoolClone?: (movieId: SeedMovieId) => void;
}

class MoviePool {
    confirmPool: Map<number, number | null> = new Map();
    playPool: Map<number, PlayEntry> = new Map();
    verifiedPool: Map<number, number> = new Map();
    pendingPool: Map<number, number | null> = new Map();
    sentSeeds: Map<number, number | null> = new Map();
    sentPlayFlags: Map<number, boolean> = new Map();
}

// ============================================================================
// SeedValidator
// ============================================================================

export class SeedValidator {
    private pools: Map<SeedMovieId, MoviePool> = new Map();
    private testSeeds: (number | null)[] = [null, null, null];
    private mode: PoolMode = 'natural';
    private selectedMovieId: SeedMovieId = 'fes';
    private baselineLoadFailed = false;
    private readonly assetsDir: string;
    private readonly logger: SeedValidatorLogger;
    private readonly stateStore: SeedStateStore;
    private readonly onPoolClone?: (movieId: SeedMovieId) => void;

    constructor(options: SeedValidatorOptions = {}) {
        this.logger = options.logger ?? console;
        this.assetsDir = options.assetsDir ?? ASSETS_DIR;
        this.onPoolClone = options.onPoolClone;
        this.stateStore = options.seedStateStore ?? createSeedStateStore({
            dataPaths: options.dataPaths,
        });
        this.load();
    }

    private pool(value: unknown): MoviePool {
        const movieId = validateMovieId(value);
        if (!this.pools.has(movieId)) this.pools.set(movieId, new MoviePool());
        return this.pools.get(movieId)!;
    }

    private peekPool(movieId: string): MoviePool | undefined {
        return (SEED_MOVIE_IDS as readonly string[]).includes(movieId)
            ? this.pools.get(movieId as SeedMovieId)
            : undefined;
    }

    // ====== 持久化 ======

    private readBaseline(fileName: string): unknown | null {
        try {
            return JSON.parse(readFileSync(join(this.assetsDir, fileName), "utf8"));
        } catch (error) {
            this.baselineLoadFailed = true;
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `[SEED] Failed to load seed baseline "${fileName}"; snapshot writes are disabled: ${message}`,
            );
            return null;
        }
    }

    private loadConfirmed(value: unknown): void {
        if (value === null) return;
        try {
            for (const [mid, seeds] of Object.entries(requireRecord(value, "confirmed seed snapshot"))) {
                if (mid.endsWith("_play")) continue;
                if (mid.endsWith("_pend")) {
                    const movieId = mid.replace("_pend", "");
                    for (const [seed, rarity] of Object.entries(requireRecord(seeds, `${mid} pending pool`))) {
                        this.pool(movieId).pendingPool.set(Number(seed), rarity as number | null);
                    }
                    continue;
                }
                const pool = this.pool(mid);
                if (Array.isArray(seeds)) {
                    for (const seed of seeds) {
                        if (!pool.playPool.has(Number(seed))) pool.confirmPool.set(Number(seed), null);
                    }
                    continue;
                }
                for (const [seed, rarity] of Object.entries(requireRecord(seeds, `${mid} confirm pool`))) {
                    if (!pool.playPool.has(Number(seed))) {
                        pool.confirmPool.set(Number(seed), rarity as number | null);
                    }
                }
            }
        } catch (error) {
            this.rejectBaselineShape(CONFIRMED_FILE, error);
        }
    }

    private loadPlay(value: unknown): void {
        if (value === null) return;
        try {
            for (const [movieId, seeds] of Object.entries(requireRecord(value, "purified seed snapshot"))) {
                const pool = this.pool(movieId);
                for (const [seed, entry] of Object.entries(requireRecord(seeds, `${movieId} play pool`))) {
                    const playEntry = requireRecord(entry, `${movieId} play seed ${seed}`);
                    pool.confirmPool.delete(Number(seed));
                    pool.playPool.set(Number(seed), {
                        r: (playEntry.r as number | undefined) ?? 0,
                        tag: (playEntry.tag as SeedTag | undefined) || "未测试",
                        play: true,
                    });
                }
            }
        } catch (error) {
            this.rejectBaselineShape(PURIFIED_FILE, error);
        }
    }

    private loadTestSeeds(value: unknown): void {
        if (value === null) return;
        try {
            if (!Array.isArray(value)) throw new Error("test seed snapshot expected an array");
            this.testSeeds = [null, null, null];
            for (let index = 0; index < 3; index++) {
                if (typeof value[index] === "number") this.testSeeds[index] = value[index];
            }
        } catch (error) {
            this.rejectBaselineShape(TEST_SEEDS_FILE, error);
        }
    }

    private loadConfig(value: unknown): void {
        if (value === null) return;
        try {
            const config = requireRecord(value, "pool configuration snapshot");
            if (typeof config.selectedMovieId !== "string" || !config.selectedMovieId) {
                throw new Error("pool configuration selectedMovieId must be a non-empty string");
            }
            this.selectedMovieId = validateMovieId(config.selectedMovieId);
        } catch (error) {
            this.rejectBaselineShape(CONFIG_FILE, error);
        }
    }

    private loadVerified(value: unknown): void {
        if (value === null) return;
        try {
            for (const [movieId, seeds] of Object.entries(requireRecord(value, "verified seed snapshot"))) {
                const pool = this.pool(movieId);
                for (const [seed, rarity] of Object.entries(requireRecord(seeds, `${movieId} verified pool`))) {
                    pool.verifiedPool.set(Number(seed), rarity as number);
                }
            }
        } catch (error) {
            this.rejectBaselineShape(VERIFIED_FILE, error);
        }
    }

    private rejectBaselineShape(fileName: string, error: unknown): void {
        this.baselineLoadFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
            `[SEED] Invalid seed baseline "${fileName}"; snapshot writes are disabled: ${message}`,
        );
    }

    private canonicalizePool(pool: MoviePool): boolean {
        let changed = false;
        for (const seed of pool.verifiedPool.keys()) {
            changed = pool.playPool.delete(seed) || changed;
            changed = pool.confirmPool.delete(seed) || changed;
            changed = pool.pendingPool.delete(seed) || changed;
        }
        for (const seed of pool.playPool.keys()) {
            changed = pool.confirmPool.delete(seed) || changed;
            changed = pool.pendingPool.delete(seed) || changed;
        }
        for (const seed of pool.confirmPool.keys()) {
            changed = pool.pendingPool.delete(seed) || changed;
        }
        return changed;
    }

    private loadBaseline(): void {
        this.loadConfirmed(this.readBaseline(CONFIRMED_FILE));
        this.loadPlay(this.readBaseline(PURIFIED_FILE));
        this.loadTestSeeds(this.readBaseline(TEST_SEEDS_FILE));
        this.loadConfig(this.readBaseline(CONFIG_FILE));
        this.loadVerified(this.readBaseline(VERIFIED_FILE));
        for (const pool of this.pools.values()) this.canonicalizePool(pool);
        try {
            validateSeedRuntimeSnapshot(this.snapshot());
        } catch (error) {
            this.rejectBaselineShape("combined seed baseline", error);
        }
    }

    private applyRuntimeSnapshot(snapshot: SeedRuntimeSnapshot): void {
        this.pools = new Map();
        for (const [movieId, seeds] of Object.entries(snapshot.confirmed)) {
            for (const [seed, rarity] of Object.entries(seeds)) {
                this.pool(movieId).confirmPool.set(Number(seed), rarity);
            }
        }
        for (const [movieId, seeds] of Object.entries(snapshot.pending)) {
            for (const [seed, rarity] of Object.entries(seeds)) {
                this.pool(movieId).pendingPool.set(Number(seed), rarity);
            }
        }
        for (const [movieId, seeds] of Object.entries(snapshot.play)) {
            for (const [seed, entry] of Object.entries(seeds)) {
                this.pool(movieId).playPool.set(Number(seed), { ...entry });
            }
        }
        for (const [movieId, seeds] of Object.entries(snapshot.verified)) {
            for (const [seed, rarity] of Object.entries(seeds)) {
                this.pool(movieId).verifiedPool.set(Number(seed), rarity);
            }
        }
        this.selectedMovieId = snapshot.config.selectedMovieId;
        this.testSeeds = [...snapshot.testSeeds];
    }

    private load(): void {
        const snapshot = this.stateStore.read();
        if (snapshot === null) this.loadBaseline();
        else this.applyRuntimeSnapshot(snapshot);
        this.mode = 'natural';
        let pl = 0, cf = 0, vf = 0; for (const m of this.pools.values()) { pl += m.playPool.size; cf += m.confirmPool.size; vf += m.verifiedPool.size; }
        this.logger.log(`[SEED] Play:${pl} Confirm:${cf} Verified:${vf} Mode:${this.mode}`);
    }

    private snapshot(): SeedRuntimeSnapshot {
        const snapshot: SeedRuntimeSnapshot = {
            schemaVersion: 1,
            confirmed: createSeedRecord(),
            pending: createSeedRecord(),
            play: createSeedRecord(),
            verified: createSeedRecord(),
            config: { selectedMovieId: this.selectedMovieId },
            testSeeds: [...this.testSeeds],
        };
        for (const [movieId, pool] of this.pools) {
            snapshot.confirmed[movieId] = Object.fromEntries(pool.confirmPool);
            snapshot.pending[movieId] = Object.fromEntries(pool.pendingPool);
            snapshot.play[movieId] = Object.fromEntries(
                Array.from(pool.playPool, ([seed, entry]) => [String(seed), { ...entry }]),
            );
            snapshot.verified[movieId] = Object.fromEntries(pool.verifiedPool);
        }
        return snapshot;
    }

    private clonePool(source: MoviePool): MoviePool {
        const target = new MoviePool();
        target.confirmPool = new Map(source.confirmPool);
        target.playPool = new Map(
            Array.from(source.playPool, ([seed, entry]) => [seed, { ...entry }]),
        );
        target.verifiedPool = new Map(source.verifiedPool);
        target.pendingPool = new Map(source.pendingPool);
        target.sentSeeds = new Map(source.sentSeeds);
        target.sentPlayFlags = new Map(source.sentPlayFlags);
        return target;
    }

    private mutate<T>(
        scope: MutationScope,
        operation: () => { changed: boolean; result: T },
    ): { changed: boolean; result: T } {
        const previousPools = this.pools;
        const previousTestSeeds = this.testSeeds;
        const previousSelectedMovieId = this.selectedMovieId;
        const previousMode = this.mode;
        if (scope.movieIds && scope.movieIds.length > 0) {
            this.pools = new Map(this.pools);
            for (const movieId of new Set(scope.movieIds)) {
                const source = this.pools.get(movieId);
                if (source) {
                    this.pools.set(movieId, this.clonePool(source));
                    this.onPoolClone?.(movieId);
                }
            }
        }
        if (scope.testSeeds) this.testSeeds = [...this.testSeeds];
        try {
            const outcome = operation();
            if (outcome.changed) {
                if (this.baselineLoadFailed) {
                    throw new Error("Cannot persist seed state because the bundled baseline failed to load");
                }
                this.stateStore.write(this.snapshot());
            }
            return outcome;
        } catch (error) {
            this.pools = previousPools;
            this.testSeeds = previousTestSeeds;
            this.selectedMovieId = previousSelectedMovieId;
            this.mode = previousMode;
            throw error;
        }
    }

    // ====== 共享工具 ======

    private trace(msg: string): void { this.logger.log(`[SEED] ${msg}`); }

    /** 播放池稀有度匹配 */
    private isPlayMatch(s: number, p: MoviePool, ri: number): boolean {
        const e = p.playPool.get(s);
        return !!(e && e.r === ri && e.tag !== '冷血躲避球');
    }

    /** 确认池稀有度匹配（同池，不跨池回退） */
    private isConfirmMatch(ri: number, p: MoviePool, s: number): boolean {
        const r = p.confirmPool.get(s);
        const ok = r !== undefined && (r === null || r === ri);
        return ok;
    }

    /** 检查种子是否已存在于当前 movie 的任一持久池。 */
    private inAnyPool(p: MoviePool, s: number): boolean {
        return p.confirmPool.has(s)
            || p.playPool.has(s)
            || p.verifiedPool.has(s)
            || p.pendingPool.has(s);
    }

    /** 种子被确认/播放后清理 sentSeeds */
    private cleanupPending(seed: number, p: MoviePool): void {
        p.sentSeeds.delete(seed);
        p.sentPlayFlags.delete(seed);
    }

    // ====== 种子状态变更 ======

    private confirmInMemory(movieId: SeedMovieId, seed: number, r?: number | null): boolean {
        const existingPool = this.peekPool(movieId);
        if (existingPool) this.cleanupPending(seed, existingPool);
        if (existingPool?.verifiedPool.has(seed) || existingPool?.playPool.has(seed)) return false;
        const p = existingPool ?? this.pool(movieId);
        if (p.confirmPool.has(seed)) {
            if (r !== undefined && r !== null && p.confirmPool.get(seed) !== r) {
                p.confirmPool.set(seed, r);
                return true;
            }
            return false;
        }
        p.pendingPool.delete(seed);
        p.confirmPool.set(seed, r !== undefined ? r : null);
        return true;
    }

    confirm(movieId: string, seed: number, r?: number | null): boolean {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        const normalizedRarity = r === undefined || r === null
            ? r
            : validateRarityIndex(r, "seed rarity");
        const outcome = this.mutate({ movieIds: [normalizedMovieId] }, () => {
            const didChange = this.confirmInMemory(normalizedMovieId, normalizedSeed, normalizedRarity);
            return { changed: didChange, result: didChange };
        });
        if (outcome.changed && normalizedRarity !== undefined) {
            this.logger.log(`[TRACE] confirm seed=${normalizedSeed} r=${'★'+(normalizedRarity!+3)} confirmPool.size=${this.peekPool(normalizedMovieId)?.confirmPool.size ?? 0}`);
        }
        return outcome.changed;
    }

    private addPlayInMemory(
        movieId: SeedMovieId,
        seed: number,
        r: number,
        didPlay?: boolean | null,
    ): boolean {
        const existingPool = this.peekPool(movieId);
        if (existingPool) this.cleanupPending(seed, existingPool);
        if (existingPool?.verifiedPool.has(seed)) return false;
        const p = existingPool ?? this.pool(movieId);
        if (didPlay === true) {
            const existing = p.playPool.get(seed);
            if (
                existing?.r === r
                && existing.tag === '未测试'
                && existing.play === true
                && !p.confirmPool.has(seed)
                && !p.pendingPool.has(seed)
            ) return false;
            p.confirmPool.delete(seed);
            p.pendingPool.delete(seed);
            p.playPool.set(seed, { r, tag: '未测试', play: true });
            return true;
        } else if (didPlay === false) {
            return this.confirmInMemory(movieId, seed, r);
        }
        return this.addPendingInMemory(movieId, seed, r);
    }

    addPlay(movieId: string, seed: number, r: number, didPlay?: boolean | null): boolean {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        const normalizedRarity = validateRarityIndex(r, "seed rarity");
        if (didPlay !== undefined && didPlay !== null && typeof didPlay !== "boolean") {
            throw new SeedInputError(`Invalid play flag: ${String(didPlay)}`);
        }
        const outcome = this.mutate({ movieIds: [normalizedMovieId] }, () => {
            const didChange = this.addPlayInMemory(
                normalizedMovieId,
                normalizedSeed,
                normalizedRarity,
                didPlay,
            );
            return { changed: didChange, result: didChange };
        });
        if (outcome.changed && didPlay === true) {
            this.logger.log(`[TRACE] addPlay seed=${normalizedSeed} r=${'★'+(normalizedRarity+3)} play=true playPool.size=${this.peekPool(normalizedMovieId)?.playPool.size ?? 0}`);
            this.logger.log(`[SEED] PLAY [${normalizedMovieId}] seed=${normalizedSeed} ★${normalizedRarity+3} play=1`);
        }
        return outcome.changed;
    }

    /** 稀有度经 C3032 客户端校验后移入验证池，并清理同 movie 的低优先级状态 */
    private moveToVerifiedInMemory(movieId: SeedMovieId, seed: number, r: number): boolean {
        const p = this.pool(movieId);
        this.cleanupPending(seed, p);
        if (p.verifiedPool.get(seed) === r) return false;
        p.verifiedPool.set(seed, r);
        p.playPool.delete(seed);
        p.confirmPool.delete(seed);
        p.pendingPool.delete(seed);
        return true;
    }

    moveToVerified(movieId: string, seed: number, r: number): boolean {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        const normalizedRarity = validateRarityIndex(r, "seed rarity");
        const outcome = this.mutate({ movieIds: [normalizedMovieId] }, () => ({
            changed: this.moveToVerifiedInMemory(normalizedMovieId, normalizedSeed, normalizedRarity),
            result: undefined,
        }));
        if (outcome.changed) {
            this.logger.log(`[SEED] VERIFY [${normalizedMovieId}] seed=${normalizedSeed} ★${normalizedRarity+3} (rarity verified by client)`);
        }
        return outcome.changed;
    }

    confirmPlayedAndVerify(movieId: string, seed: number, r: number): boolean {
        return this.moveToVerified(movieId, seed, r);
    }

    private addPendingInMemory(movieId: SeedMovieId, seed: number, r: number | null): boolean {
        const existingPool = this.peekPool(movieId);
        if (existingPool?.verifiedPool.has(seed)) {
            if (existingPool) this.cleanupPending(seed, existingPool);
            return false;
        }
        const p = existingPool ?? this.pool(movieId);
        const e = p.playPool.get(seed);
        if (e) {
            this.cleanupPending(seed, p);
            if (r !== null && e.r !== r) {
                e.r = r;
                return true;
            }
            return false;
        }
        if (r !== null) return this.confirmInMemory(movieId, seed, r);
        this.cleanupPending(seed, p);
        if (p.playPool.has(seed) || p.confirmPool.has(seed)) return false;
        if (p.pendingPool.has(seed) && p.pendingPool.get(seed) === null) return false;
        p.pendingPool.set(seed, null);
        return true;
    }

    addPending(movieId: string, seed: number, r: number | null): boolean {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        const normalizedRarity = r === null ? null : validateRarityIndex(r, "seed rarity");
        return this.mutate({ movieIds: [normalizedMovieId] }, () => ({
            changed: this.addPendingInMemory(normalizedMovieId, normalizedSeed, normalizedRarity),
            result: undefined,
        })).changed;
    }

    markSent(movieId: string, seed: number, rarity?: number): void {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        const rarityIndex = rarity !== undefined
            ? validateRarityIndex(rarity - 3, "rarity")
            : null;
        const p = this.pool(normalizedMovieId);
        p.sentSeeds.set(normalizedSeed, rarityIndex);
        console.log(`[SEED] SENT [${normalizedMovieId}] seed=${normalizedSeed} r=${rarityIndex !== null ? '★'+(rarityIndex+3) : 'null'}  [DBG] sentSeeds.size=${p.sentSeeds.size}`);
    }

    getSentR(movieId: string, seed: number): number | null | undefined {
        return this.peekPool(movieId)?.sentSeeds.get(seed);
    }

    /** 记录客户端返回的 play=1/0，供 flushAll 使用 */
    recordPlay(movieId: string, seed: number, didPlay: boolean): void {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        if (typeof didPlay !== "boolean") {
            throw new SeedInputError(`Invalid play flag: ${String(didPlay)}`);
        }
        this.pool(normalizedMovieId).sentPlayFlags.set(normalizedSeed, didPlay);
    }

    /** 清理 sentSeeds：有 play 标记的按标记入池，无标记的入 pendingPool 重测 */
    flushAll(): boolean {
        return this.mutate({ movieIds: Array.from(this.pools.keys()) }, () => {
            let changed = false;
            for (const [movieId, p] of this.pools) {
                let flushed = 0, play1 = 0, play0 = 0, unmarked = 0;
                for (const [seed, r] of p.sentSeeds) {
                    const didPlay = p.sentPlayFlags.get(seed);
                    if (didPlay === true) {
                        changed = this.addPlayInMemory(movieId, seed, r ?? 0, true) || changed;
                        changed = this.moveToVerifiedInMemory(movieId, seed, r ?? 0) || changed;
                        play1++;
                    } else if (didPlay === false) {
                        changed = this.confirmInMemory(movieId, seed, r) || changed;
                        play0++;
                    } else {
                        // 完全丢失：pendingPool 下次重测
                        changed = this.addPendingInMemory(movieId, seed, r) || changed;
                        unmarked++;
                    }
                    flushed++;
                }
                if (flushed > 0) this.logger.log(`[SEED] flushAll [${movieId}] flushed ${flushed} stale seeds  [DBG] play=1:${play1} play=0:${play0} unmarked:${unmarked}`);
            }
            return { changed, result: undefined };
        }).changed;
    }

    // Tag / testSeed / mode — unchanged
    setTag(movieId: string, seed: number, tag: SeedTag): boolean {
        const normalizedMovieId = validateMovieId(movieId);
        const normalizedSeed = validateRuntimeSeed(seed);
        const normalizedTag = validateSeedTag(tag);
        return this.mutate({ movieIds: [normalizedMovieId], testSeeds: true }, () => {
            const e = this.peekPool(normalizedMovieId)?.playPool.get(normalizedSeed);
            if (!e) return { changed: false, result: false };
            const tagChanged = e.tag !== normalizedTag;
            e.tag = normalizedTag;
            const testSeedChanged = normalizedTag === '冷血躲避球'
                ? this.clearTestSeedInMemory(e.r + 3)
                : false;
            const changed = tagChanged || testSeedChanged;
            return { changed, result: changed };
        }).changed;
    }
    setTestSeed(movieId: string, rarity: 3 | 4 | 5, seed: number): boolean {
        validateMovieId(movieId);
        const rarityIndex = validateRarityIndex(rarity - 3, "rarity");
        const normalizedSeed = validateTestSeed(seed);
        return this.mutate({ testSeeds: true }, () => {
            if (this.testSeeds[rarityIndex] === normalizedSeed) {
                return { changed: false, result: false };
            }
            this.testSeeds[rarityIndex] = normalizedSeed;
            return { changed: true, result: true };
        }).changed;
    }
    private clearTestSeedInMemory(rarity: number): boolean {
        const r = rarity - 3;
        if (this.testSeeds[r] === null) return false;
        this.testSeeds[r] = null;
        return true;
    }
    clearTestSeed(rarity: number): boolean {
        validateRarityIndex(rarity - 3, "rarity");
        return this.mutate({ testSeeds: true }, () => {
            const changed = this.clearTestSeedInMemory(rarity);
            return { changed, result: changed };
        }).changed;
    }
    getMode(): PoolMode { return this.mode; } getSelectedMovieId(): string { return this.selectedMovieId; }
    setMode(m: PoolMode): void {
        if (!['natural', 'play', 'test'].includes(m)) {
            throw new SeedInputError(`Invalid seed pool mode: ${String(m)}`);
        }
        this.mode = m;
    }
    setModeAndSelectedMovieId(mode: PoolMode, selectedMovieId?: string): void {
        if (!['natural', 'play', 'test'].includes(mode)) {
            throw new SeedInputError(`Invalid seed pool mode: ${String(mode)}`);
        }
        const movieId = selectedMovieId === undefined
            ? undefined
            : validateMovieId(selectedMovieId);
        this.mutate({}, () => {
            this.mode = mode;
            if (movieId === undefined || this.selectedMovieId === movieId) {
                return { changed: false, result: undefined };
            }
            this.selectedMovieId = movieId;
            return { changed: true, result: undefined };
        });
    }
    setSelectedMovieId(id: string): boolean {
        const movieId = validateMovieId(id);
        return this.mutate({}, () => {
            if (this.selectedMovieId === movieId) {
                return { changed: false, result: false };
            }
            this.selectedMovieId = movieId;
            return { changed: true, result: true };
        }).changed;
    }
    getMovieIds(): string[] { return [...SEED_MOVIE_IDS]; }

    // ====== 种子选取 ======

    getSeed(movieId: string, rarity: number, pool: number[], characterId: number, drawIndex?: number): number {
        const normalizedMovieId = validateMovieId(movieId);
        const ri = validateRarityIndex(rarity - 3, "rarity");
        if (this.testSeeds[ri] !== null) { console.log(`[DBG] getSeed mode=${this.mode} ★${rarity} ${movieId} di=${drawIndex} → testSeed=${this.testSeeds[ri]}`); return this.testSeeds[ri]!; }  // ①

        const p = this.peekPool(normalizedMovieId) ?? new MoviePool();
        const avail = pool.filter(s => !p.sentSeeds.has(s));
        const rand = (arr: number[]) => arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined;

        if (avail.length < pool.length) this.trace(`★${rarity} avail: ${avail.length}/${pool.length} (sentSeeds blocked ${pool.length - avail.length})`);

        // Natural mode: log verifiedPool match count
        if (this.mode === 'play') {
            const pur = rand(avail.filter(s => this.isPlayMatch(s, p, ri)));
            if (pur !== undefined) return pur;
        }

        // ④ 测试模式
        if (this.mode === 'test') {
            // 1. 播放池种子（play=1 已确认，稀有度待 C3032 校验），排除当前 movie 已入验证池的
            const pur = rand(avail.filter(s => this.isPlayMatch(s, p, ri) && !p.verifiedPool.has(s)));
            if (pur !== undefined) return pur;
            // 2. pendingPool（/crash 已知 r，待重测 play）
            const pend = rand(avail.filter(s => p.pendingPool.has(s)));
            if (pend !== undefined) return pend;
            // 3. unknown（不在任何池的未测试种子）
            const unk = rand(avail.filter(s => !this.inAnyPool(p, s)));
            if (unk !== undefined) { console.log(`[DBG] getSeed mode=${this.mode} ★${rarity} ${movieId} → unknown=${unk}`); return unk; }
            const fb = characterId * 1000;
            console.log(`[DBG] getSeed mode=${this.mode} ★${rarity} ${movieId} → fallback=${fb}`);
            return fb;
        }

        // ⑤ 自然模式
        if (this.mode === 'natural') {
            const isFirst = drawIndex !== undefined && drawIndex === 0;
            const verList = avail.filter(s => p.verifiedPool.has(s) && p.verifiedPool.get(s) === ri);
            if (isFirst) {
                const ver = rand(verList);
                if (ver !== undefined) { console.log(`[DBG] getSeed ★${rarity} ri=${ri} → natural:verified=★${p.verifiedPool.get(ver)!+3}`); return ver; }
            }
            const ver = rand(verList);
            if (ver !== undefined && Math.random() < 0.10) { console.log(`[DBG] getSeed ★${rarity} ri=${ri} → natural:verified=★${p.verifiedPool.get(ver)!+3}`); return ver; }
            if (verList.length > 0) console.log(`[DBG] getSeed ★${rarity} ri=${ri} verifiedPool matches=${verList.length} (none picked this time)`);
        }

        // ⑥ 兜底链
        const confList = avail.filter(s => this.isConfirmMatch(ri, p, s));
        const conf = rand(confList);
        if (conf !== undefined) {
            const cr = p.confirmPool.get(conf);
            console.log(`[DBG] getSeed ★${rarity} ri=${ri} mode=${this.mode} → confirm=${conf} r=${cr !== undefined && cr !== null ? '★'+(cr+3) : 'null'} (${confList.length} matches)`);
            return conf;
        }
        const pend = rand(avail.filter(s => p.pendingPool.has(s)));
        if (pend !== undefined) { console.log(`[DBG] getSeed ★${rarity} → pending=${pend}`); return pend; }
        const unk = rand(avail.filter(s => !this.inAnyPool(p, s)));
        if (unk !== undefined) { console.log(`[DBG] getSeed ★${rarity} mode=${this.mode} → unknown=${unk}`); return unk; }

        const fb = characterId * 1000;
        console.log(`[DBG] getSeed ★${rarity} mode=${this.mode} → fallback=${fb} charId=${characterId}`);
        return fb;
    }

    getPlayForRarity(movieId: string, rarity: number): number[] {
        const ri = rarity - 3;
        const pool = this.peekPool(movieId);
        if (!pool) return [];
        return Array.from(pool.playPool.entries())
            .filter(([, e]) => e.r === ri && e.tag !== '冷血躲避球')
            .map(([s]) => s);
    }

    stats(movieId?: string) {
        const mid = movieId || this.selectedMovieId || 'fes';
        const p = this.peekPool(mid);
        let allPlay = { r3: 0, r4: 0, r5: 0, total: 0 };
        let allConfirm = 0, allPending = 0, allVerified = 0;
        for (const [, pool] of this.pools) {
            for (const [, e] of pool.playPool) { if (e.r === 0) allPlay.r3++; else if (e.r === 1) allPlay.r4++; else { allPlay.r5++; } allPlay.total++; }
            allConfirm += pool.confirmPool.size;
            allPending += pool.pendingPool.size;
            allVerified += pool.verifiedPool.size;
        }
        return {
            confirm: p?.confirmPool.size ?? 0, confirm_total: allConfirm,
            play_r3: allPlay.r3, play_r4: allPlay.r4, play_r5: allPlay.r5, play_total: allPlay.total,
            mov_play: p?.playPool.size ?? 0,
            verified: p?.verifiedPool.size ?? 0, verified_total: allVerified,
            pending: p?.pendingPool.size ?? 0, pending_total: allPending,
            test_seeds: [...this.testSeeds],
            mode: this.mode, selectedMovieId: this.selectedMovieId, movieIds: this.getMovieIds(),
        };
    }

    getPlayList(movieId: string): { seed: number; rarity: number; tag: SeedTag; play?: boolean }[] {
        const pool = this.peekPool(movieId);
        if (!pool) return [];
        return Array.from(pool.playPool.entries()).map(([s, e]) => ({ seed: s, rarity: e.r + 3, tag: e.tag, play: e.play }));
    }

    getVerifiedList(movieId: string): { seed: number; rarity: number }[] {
        const pool = this.peekPool(movieId);
        if (!pool) return [];
        return Array.from(pool.verifiedPool.entries())
            .map(([s, r]) => ({ seed: s, rarity: r + 3 }));
    }
}

export function createSeedValidator(options: SeedValidatorOptions = {}): SeedValidator {
    return new SeedValidator(options);
}

const validator = createSeedValidator();
export default validator;
