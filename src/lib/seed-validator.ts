/**
 * Seed Validator — 种子验证系统
 *
 * 池:
 *   testPool — 仿真生成，未测试
 *   confirmPool — play=0 或无 C3032，rarity 正确
 *   playPool — play=1，rarity 正确
 *   pendingPool — /crash 已知 r，待重测
 *   seedBacklog — 优先测试队列 (FIFO)
 *
 * 选择优先级:
 *   natural: testSeed > backlog > playPool(10%/first) > confirmPool > playFallback > pending > testPool
 *   play:    testSeed > backlog > playPool > playFallback > confirmPool > ...
 *   test:    testSeed > backlog > pendingPool > testPool
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");
const CONFIRMED_FILE = join(ASSETS_DIR, "confirmed_seeds.json");
const PURIFIED_FILE = join(ASSETS_DIR, "purified_seeds.json");
const CONFIG_FILE = join(ASSETS_DIR, "pool_config.json");
const TEST_SEEDS_FILE = join(ASSETS_DIR, "test_seeds.json");
const BACKLOG_FILE = join(ASSETS_DIR, "seed_backlog.json");

export type PoolMode = 'natural' | 'play' | 'test';
export type SeedTag = '未测试' | '热血躲避球' | '普通躲避球' | '冷血躲避球';

interface PlayEntry { r: number; tag: SeedTag; play?: boolean }

class MoviePool {
    confirmPool: Map<number, number | null> = new Map();
    playPool: Map<number, PlayEntry> = new Map();
    pendingPool: Map<number, number | null> = new Map();
    sentSeeds: Map<number, number | null> = new Map();
    seedBacklog: number[] = [];
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

    // ====== 持久化 ======

    private load(): void {
        try { if (existsSync(CONFIRMED_FILE)) { const o = JSON.parse(readFileSync(CONFIRMED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (mid.endsWith("_play")) { /* skip */ } else if (mid.endsWith("_pend")) { const m = mid.replace("_pend", ""); for (const [s, r] of Object.entries(seeds as any)) this.pool(m).pendingPool.set(Number(s), r as number | null); } else { const p = this.pool(mid); if (Array.isArray(seeds)) { for (const s of seeds as any[]) { if (!p.playPool.has(Number(s))) p.confirmPool.set(Number(s), null); } } else { for (const [s, r] of Object.entries(seeds as any)) { if (!p.playPool.has(Number(s))) p.confirmPool.set(Number(s), r as number | null); } } } } } } catch (_) {}
        try { if (existsSync(PURIFIED_FILE)) { const o = JSON.parse(readFileSync(PURIFIED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (typeof seeds !== 'object' || seeds === null) continue; const p = this.pool(mid); for (const [s, e] of Object.entries(seeds as any)) { p.confirmPool.delete(Number(s)); p.playPool.set(Number(s), { r: (e as any).r ?? 0, tag: (e as any).tag || '未测试', play: true }); } } } } catch (_) {}
        try { if (existsSync(TEST_SEEDS_FILE)) { const a = JSON.parse(readFileSync(TEST_SEEDS_FILE, "utf-8")); if (Array.isArray(a)) { this.testSeeds = [null, null, null]; for (let i = 0; i < 3; i++) if (typeof a[i] === 'number') this.testSeeds[i] = a[i]; } } } catch (_) {}
        try { if (existsSync(BACKLOG_FILE)) { const o = JSON.parse(readFileSync(BACKLOG_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (Array.isArray(seeds)) this.pool(mid).seedBacklog = seeds; } } } catch (_) {}
        try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); if (c.selectedMovieId) this.selectedMovieId = c.selectedMovieId; } } catch (_) {}
        this.mode = 'natural';
        let pl = 0, cf = 0; for (const m of this.pools.values()) { pl += m.playPool.size; cf += m.confirmPool.size; }
        console.log(`[SEED] Play:${pl} Confirm:${cf} Backlog:${this.pool('fes').seedBacklog.length}+${this.pool('normal').seedBacklog.length} Mode:${this.mode}`);
    }

    private saveConfirm(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = Object.fromEntries(p.confirmPool); o[mid + "_pend"] = Object.fromEntries(p.pendingPool); } writeFileSync(CONFIRMED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private savePlay(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = {}; for (const [s, e] of p.playPool) o[mid][String(s)] = e; } writeFileSync(PURIFIED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private saveConfig(): void { writeFileSync(CONFIG_FILE, JSON.stringify({ selectedMovieId: this.selectedMovieId }, null, 2), "utf-8"); }
    private saveTestSeeds(): void { writeFileSync(TEST_SEEDS_FILE, JSON.stringify(this.testSeeds, null, 2), "utf-8"); }

    // ====== 共享工具 ======

    /** 种子被确认/播放后清理 sentSeeds + backlog */
    private cleanupPending(seed: number, p: MoviePool): void {
        p.sentSeeds.delete(seed);
        const bi = p.seedBacklog.indexOf(seed); if (bi >= 0) p.seedBacklog.splice(bi, 1);
        // Also clean base pool's backlog (e.g., fes_guarantine → fes)
        for (const [, other] of this.pools) {
            if (other === p) continue;
            const oi = other.seedBacklog.indexOf(seed); if (oi >= 0) other.seedBacklog.splice(oi, 1);
        }
    }

    /** _guarantee 池回退到基础池 */
    private basePool(movieId: string): MoviePool | null {
        const baseMovie = movieId.replace('_guarantee', '');
        return baseMovie !== movieId ? this.pool(baseMovie) : null;
    }

    // ====== 种子状态变更 ======

    confirm(movieId: string, seed: number, r?: number | null): void {
        const p = this.pool(movieId);
        this.cleanupPending(seed, p);
        if (p.playPool.has(seed)) return;
        if (p.confirmPool.has(seed)) {
            if (r !== undefined && r !== null) { p.confirmPool.set(seed, r); this.saveConfirm(); }
            return;
        }
        p.pendingPool.delete(seed);
        p.confirmPool.set(seed, r !== undefined ? r : null);
        this.saveConfirm();
    }

    addPlay(movieId: string, seed: number, r: number, didPlay?: boolean | null): void {
        const p = this.pool(movieId);
        this.cleanupPending(seed, p);
        if (didPlay === true) {
            p.confirmPool.delete(seed);
            p.pendingPool.delete(seed);
            p.playPool.set(seed, { r, tag: '未测试', play: true });
            this.savePlay(); this.saveConfirm();
            console.log(`[SEED] PLAY [${movieId}] seed=${seed} ★${r+3} play=1`);
        } else if (didPlay === false) {
            this.confirm(movieId, seed, r);
        } else {
            this.addPending(movieId, seed, r);
        }
    }

    addPending(movieId: string, seed: number, r: number | null): void {
        const p = this.pool(movieId);
        this.cleanupPending(seed, p);
        const e = p.playPool.get(seed);
        if (e) { e.r = r !== null ? r : e.r; this.savePlay(); return; }
        if (r !== null) this.confirm(movieId, seed, r);
        this.saveConfirm();
    }

    markSent(movieId: string, seed: number, rarity?: number): void {
        const p = this.pool(movieId);
        const r = rarity !== undefined ? rarity - 3 : null;
        p.sentSeeds.set(seed, r);
        console.log(`[SEED] SENT [${movieId}] seed=${seed} r=${r !== null ? '★'+(r+3) : 'null'}`);
    }

    getSentR(movieId: string, seed: number): number | null | undefined {
        return this.pool(movieId).sentSeeds.get(seed);
    }

    // Tag / testSeed / mode — unchanged
    setTag(movieId: string, seed: number, tag: SeedTag): boolean {
        const e = this.pool(movieId).playPool.get(seed); if (!e) return false;
        e.tag = tag; if (tag === '冷血躲避球') this.clearTestSeed(e.r); this.savePlay(); return true;
    }
    setTestSeed(_movieId: string, rarity: 3 | 4 | 5, seed: number): boolean {
        const r = rarity - 3; this.testSeeds[r] = seed; this.saveTestSeeds(); return true;
    }
    clearTestSeed(rarity: number): boolean {
        const r = rarity - 3; if (this.testSeeds[r] === null) return false; this.testSeeds[r] = null; this.saveTestSeeds(); return true;
    }
    getMode(): PoolMode { return this.mode; } getSelectedMovieId(): string { return this.selectedMovieId; }
    setMode(m: PoolMode): void { this.mode = m; } setSelectedMovieId(id: string): void { this.selectedMovieId = id; this.saveConfig(); }
    getMovieIds(): string[] { return Array.from(this.pools.keys()); }

    // ====== 种子选取 ======

    getSeed(movieId: string, rarity: number, pool: number[], characterId: number, drawIndex?: number): number {
        const ri = rarity - 3;
        if (this.testSeeds[ri] !== null) return this.testSeeds[ri]!;  // ①

        const p = this.pool(movieId);
        const base = this.basePool(movieId);
        const avail = pool.filter(s => !p.sentSeeds.has(s));
        const rand = (arr: number[]) => arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : undefined;

        // Helpers with base fallback
        const poolGet = <T>(getter: (mp: MoviePool) => T, fallback?: T): T => { const v = getter(p); if (v === undefined && base) return getter(base); return v ?? fallback as T; };

        // ② backlog
        const blIdx = pool.findIndex(s => p.seedBacklog.includes(s) && !p.sentSeeds.has(s));
        if (blIdx === -1 && base) {
            const blIdx2 = pool.findIndex(s => base.seedBacklog.includes(s) && !p.sentSeeds.has(s));
            if (blIdx2 >= 0) return base.seedBacklog.splice(base.seedBacklog.indexOf(pool[blIdx2]), 1)[0];
        }
        if (blIdx >= 0) {
            const cur = p.seedBacklog.splice(p.seedBacklog.indexOf(pool[blIdx]), 1)[0];
            console.log(`[TRACE] ★${rarity} mode=${this.mode} pool=backlog seed=${cur} remaining=${p.seedBacklog.length}`);
            return cur;
        }

        // ③ 播放模式
        if (this.mode === 'play') {
            const pur = rand(avail.filter(s => { const e = p.playPool.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; }));
            if (pur !== undefined) return pur;
        }

        // ④ 测试模式
        if (this.mode === 'test') {
            const pend = rand(avail.filter(s => { const r = poolGet(mp => mp.pendingPool.get(s)); return r !== undefined && (r === null || r === ri); }));
            if (pend !== undefined) return pend;
            const unk = rand(avail.filter(s => !poolGet(mp => mp.confirmPool.has(s) || mp.playPool.has(s) || mp.pendingPool.has(s), true)));
            if (unk !== undefined) return unk;
            return characterId * 1000;
        }

        // ⑤ 自然模式
        if (this.mode === 'natural') {
            const isFirst = drawIndex !== undefined && drawIndex === 0;
            if (isFirst) { const pur = rand(avail.filter(s => { const e = p.playPool.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; })); if (pur !== undefined) return pur; }
            const pur = rand(avail.filter(s => { const e = p.playPool.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; }));
            if (pur !== undefined && Math.random() < 0.10) return pur;
        }

        // ⑥ 兜底链
        const conf = rand(avail.filter(s => { const r = poolGet(mp => mp.confirmPool.get(s)); return r !== undefined && (r === null || r === ri); }));
        if (conf !== undefined) return conf;
        const play2 = rand(avail.filter(s => poolGet(mp => mp.playPool.has(s), false)));
        if (play2 !== undefined) return play2;
        const pend = rand(avail.filter(s => { const r = poolGet(mp => mp.pendingPool.get(s)); return r !== undefined && (r === null || r === ri); }));
        if (pend !== undefined) return pend;
        const unk = rand(avail.filter(s => !poolGet(mp => mp.confirmPool.has(s) || mp.playPool.has(s) || mp.pendingPool.has(s), true)));
        if (unk !== undefined) return unk;

        return characterId * 1000;
    }

    getPlayForRarity(movieId: string, rarity: number): number[] {
        const ri = rarity - 3;
        return Array.from(this.pool(movieId).playPool.entries())
            .filter(([, e]) => e.r === ri && e.tag !== '冷血躲避球')
            .map(([s]) => s);
    }

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
