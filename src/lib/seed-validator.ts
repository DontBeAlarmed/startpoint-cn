/**
 * Seed Validator — 简化版种子验证系统
 *
 * 种子状态:
 *   未知 — 仿真生成，未经过客户端校验 → testPool
 *   确认 — play=0 或无 C3032，rarity 已修正 → confirmPool
 *   播放 — play=1，rarity 已修正 → playPool (merged purified + confirmedPlay)
 *   未校验 — /crash 已知 r，等重测 → pendingPool
 *
 * 模式优先级:
 *   natural: testSeed > playPool(10%) > confirmPool > testPool > fallback
 *   play:    testSeed > playPool > fallback
 *   test:    testSeed > pendingPool > testPool > fallback
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");
const CONFIRMED_FILE = join(ASSETS_DIR, "confirmed_seeds.json");
const PURIFIED_FILE = join(ASSETS_DIR, "purified_seeds.json");
const CONFIG_FILE = join(ASSETS_DIR, "pool_config.json");
const TEST_SEEDS_FILE = join(ASSETS_DIR, "test_seeds.json");

export type PoolMode = 'natural' | 'play' | 'test';
export type SeedTag = '未测试' | '热血躲避球' | '普通躲避球' | '冷血躲避球';

interface PlayEntry { r: number; tag: SeedTag; play?: boolean }

/** 每个卡池独立的状态 */
class MoviePool {
    confirmPool: Set<number> = new Set();          // 确认池（play=0 或无 C3032）
    playPool: Map<number, PlayEntry> = new Map();   // 播放池（play=1，合并原 purified + confirmedPlay）
    pendingPool: Map<number, number | null> = new Map(); // 等待校验池（/crash 已知 r）
}

// ============================================================================
// SeedValidator
// ============================================================================

export class SeedValidator {
    private pools: Map<string, MoviePool> = new Map();
    private testSeeds: (number | null)[] = [null, null, null];
    private mode: PoolMode = 'natural';
    private selectedMovieId: string = 'fes';

    constructor() { this.load(); }

    private pool(m: string): MoviePool { if (!this.pools.has(m)) this.pools.set(m, new MoviePool()); return this.pools.get(m)!; }

    private load(): void {
        // Load confirm + play + pending from confirmed_seeds.json
        try { if (existsSync(CONFIRMED_FILE)) { const o = JSON.parse(readFileSync(CONFIRMED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (mid.endsWith("_play")) { const mid2 = mid.replace("_play", ""); for (const s of seeds as any[]) { const e = this.pool(mid2).playPool.get(Number(s)); if (e) e.play = true; else this.pool(mid2).playPool.set(Number(s), { r: 0, tag: '未测试', play: true }); } } else if (mid.endsWith("_pend")) { const mid2 = mid.replace("_pend", ""); for (const [s, r] of Object.entries(seeds as any)) this.pool(mid2).pendingPool.set(Number(s), r as number | null); } else { const p = this.pool(mid); for (const s of seeds as any[]) { if (!p.playPool.has(Number(s))) p.confirmPool.add(Number(s)); } } } } } catch (_) {}
        // Load play pool from purified_seeds.json (legacy — now merged with _play)
        try { if (existsSync(PURIFIED_FILE)) { const o = JSON.parse(readFileSync(PURIFIED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (typeof seeds !== 'object' || seeds === null) continue; const p = this.pool(mid); for (const [s, e] of Object.entries(seeds as any)) { const entry: PlayEntry = { r: (e as any).r ?? 0, tag: (e as any).tag || '未测试', play: true }; p.confirmPool.delete(Number(s)); p.playPool.set(Number(s), entry); } } } } catch (_) {}
        try { if (existsSync(TEST_SEEDS_FILE)) { const a = JSON.parse(readFileSync(TEST_SEEDS_FILE, "utf-8")); if (Array.isArray(a)) { this.testSeeds = [null, null, null]; for (let i = 0; i < 3; i++) if (typeof a[i] === 'number') this.testSeeds[i] = a[i]; } } } catch (_) {}
        try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); if (c.selectedMovieId) this.selectedMovieId = c.selectedMovieId; } } catch (_) {}
        this.mode = 'natural';
        let pl = 0, cf = 0; for (const m of this.pools.values()) { pl += m.playPool.size; cf += m.confirmPool.size; }
        console.log(`[SEED] Play:${pl} Confirm:${cf} Mode:${this.mode}`);
    }

    private saveConfirm(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = Array.from(p.confirmPool); o[mid + "_play"] = Array.from(p.playPool.keys()); o[mid + "_pend"] = Object.fromEntries(p.pendingPool); } writeFileSync(CONFIRMED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private savePlay(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = {}; for (const [s, e] of p.playPool) o[mid][String(s)] = e; } writeFileSync(PURIFIED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private saveConfig(): void { writeFileSync(CONFIG_FILE, JSON.stringify({ selectedMovieId: this.selectedMovieId }, null, 2), "utf-8"); }
    private saveTestSeeds(): void { writeFileSync(TEST_SEEDS_FILE, JSON.stringify(this.testSeeds, null, 2), "utf-8"); }

    // === 种子状态变更 ===

    // 确认（play=0 或无 C3032，rarity 已修正）
    confirm(movieId: string, seed: number): void {
        const p = this.pool(movieId);
        if (p.confirmPool.has(seed) || p.playPool.has(seed)) return;
        p.pendingPool.delete(seed);
        for (const [, other] of this.pools) other.confirmPool.delete(seed);
        p.confirmPool.add(seed);
        this.saveConfirm();
    }

    // 播放（play=1，rarity 已修正）
    addPlay(movieId: string, seed: number, r: number, didPlay?: boolean | null): void {
        const p = this.pool(movieId);
        if (didPlay === true) {
            p.confirmPool.delete(seed);
            p.pendingPool.delete(seed);
            const entry: PlayEntry = { r, tag: '未测试', play: true };
            p.playPool.set(seed, entry);
            this.savePlay(); this.saveConfirm();
            console.log(`[SEED] PLAY [${movieId}] seed=${seed} ★${r+3} play=1`);
        } else if (didPlay === false) {
            this.confirm(movieId, seed);
        } else {
            // null = /crash path, unknown play → pending
            this.addPending(movieId, seed, r);
        }
    }

    // 未校验（/crash 路径，无 patch APK）
    addPending(movieId: string, seed: number, r: number | null): void {
        const p = this.pool(movieId);
        if (p.playPool.has(seed)) return;
        p.confirmPool.delete(seed);
        p.pendingPool.set(seed, r);
        this.saveConfirm();
    }

    // 种子已发送（无 crash → 默认确认）
    markSent(movieId: string, seed: number): void {
        const p = this.pool(movieId);
        if (p.pendingPool.has(seed) || p.playPool.has(seed) || p.confirmPool.has(seed)) return;
        this.confirm(movieId, seed);
        console.log(`[SEED] CONFIRM [${movieId}] seed=${seed}`);
    }

    // Tag
    setTag(movieId: string, seed: number, tag: SeedTag): boolean {
        const e = this.pool(movieId).playPool.get(seed); if (!e) return false;
        e.tag = tag; if (tag === '冷血躲避球') this.clearTestSeed(e.r); this.savePlay(); return true;
    }

    // 测试种子（全局）
    setTestSeed(_movieId: string, rarity: 3 | 4 | 5, seed: number): boolean {
        const r = rarity - 3; this.testSeeds[r] = seed; this.saveTestSeeds(); return true;
    }
    clearTestSeed(rarity: number): boolean {
        const r = rarity - 3; if (this.testSeeds[r] === null) return false; this.testSeeds[r] = null; this.saveTestSeeds(); return true;
    }

    // 模式
    getMode(): PoolMode { return this.mode; } getSelectedMovieId(): string { return this.selectedMovieId; }
    setMode(m: PoolMode): void { this.mode = m; } setSelectedMovieId(id: string): void { this.selectedMovieId = id; this.saveConfig(); }
    getMovieIds(): string[] { return Array.from(this.pools.keys()); }

    // 种子选取
    getSeed(movieId: string, rarity: number, pool: number[], characterId: number, drawIndex?: number): number {
        const ri = rarity - 3;
        const PURIFIED_PLAY_RATE = 0.10;
        const isFirstDraw = drawIndex !== undefined && drawIndex === 0;

        // ① 全局测试种子
        const ts = this.testSeeds[ri];
        if (ts !== null) return ts;

        const p = this.pool(movieId);

        if (this.mode === 'play') {
            // 播放模式：只选播放池种子
            const pur = pool.find(s => { const e = p.playPool.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
            if (pur !== undefined) return pur;
        }

        if (this.mode === 'test') {
            // 测试模式：未校验 > 测试池
            const pend = pool.find(s => { const r = p.pendingPool.get(s); return r !== undefined && (r === null || r === ri); });
            if (pend !== undefined) return pend;

            const unknown = pool.find(s => !p.confirmPool.has(s) && !p.playPool.has(s) && !p.pendingPool.has(s));
            if (unknown !== undefined) return unknown;

            return characterId * 1000;
        }

        if (this.mode === 'natural') {
            // First draw (drawIndex=0): always pick playPool
            // Client BallMovie.run(): drawIndex==0 always plays animation regardless of moviePlayable
            if (isFirstDraw) {
                const pur = pool.find(s => { const e = p.playPool.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
                if (pur !== undefined) return pur;
            }
            // Subsequent draws: 10% playPool, 90% confirmPool/testPool
            const pur = pool.find(s => { const e = p.playPool.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
            if (pur !== undefined && Math.random() < PURIFIED_PLAY_RATE) return pur;
        }

        // 确认池（自然模式兜底，优先保证不报错）
        const conf = pool.find(s => p.confirmPool.has(s));
        if (conf !== undefined) return conf;

        // 播放池（兜底，如果确认池也没种子）
        const play = pool.find(s => p.playPool.has(s));
        if (play !== undefined) return play;

        // 未校验池
        const pend = pool.find(s => { const r = p.pendingPool.get(s); return r !== undefined && (r === null || r === ri); });
        if (pend !== undefined) return pend;

        // 未知种子（仿真生成）
        const unknown = pool.find(s => !p.confirmPool.has(s) && !p.playPool.has(s) && !p.pendingPool.has(s));
        if (unknown !== undefined) return unknown;

        return characterId * 1000;
    }

    // 跨池搜索
    getPlayForRarity(movieId: string, rarity: number): number[] {
        const ri = rarity - 3;
        return Array.from(this.pool(movieId).playPool.entries())
            .filter(([, e]) => e.r === ri && e.tag !== '冷血躲避球')
            .map(([s]) => s);
    }

    // 统计
    stats(movieId?: string) {
        const mid = movieId || this.selectedMovieId || 'fes';
        const p = this.pool(mid);
        let allPlay = { r3: 0, r4: 0, r5: 0, total: 0 };
        let allConfirm = 0, allPending = 0;
        for (const [, pool] of this.pools) {
            for (const [, e] of pool.playPool) { if (e.r === 0) allPlay.r3++; else if (e.r === 1) allPlay.r4++; else allPlay.r5++; }
            allPlay.total += pool.playPool.size;
            allConfirm += pool.confirmPool.size;
            allPending += pool.pendingPool.size;
        }
        return {
            confirm: p.confirmPool.size, confirm_total: allConfirm,
            play_r3: allPlay.r3, play_r4: allPlay.r4, play_r5: allPlay.r5, play_total: allPlay.total,
            mov_play: p.playPool.size,
            pending: p.pendingPool.size, pending_total: allPending,
            test_seeds: this.testSeeds,
            mode: this.mode, selectedMovieId: this.selectedMovieId, movieIds: Array.from(this.pools.keys()),
        };
    }

    getPlayList(movieId: string): { seed: number; rarity: number; tag: SeedTag; play?: boolean }[] {
        return Array.from(this.pool(movieId).playPool.entries()).map(([s, e]) => ({ seed: s, rarity: e.r + 3, tag: e.tag, play: e.play }));
    }
}

const validator = new SeedValidator();
export default validator;
