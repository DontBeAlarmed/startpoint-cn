/**
 * Seed Validator — 按卡池独立的种子验证系统
 *
 * 每个 movie_id 拥有独立的 MoviePool (purified/verified/pending)
 * testSeeds 全局生效，不区分 movie 配置。
 *
 * 选择优先级: testSeed > purified > test pool (unverified)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");
const BLOCKED_FILE = join(ASSETS_DIR, "blocked_seeds.json");
const VERIFIED_FILE = join(ASSETS_DIR, "verified_seeds.json");
const PENDING_FILE = join(ASSETS_DIR, "pending_seeds.json");
const PURIFIED_FILE = join(ASSETS_DIR, "purified_seeds.json");
const DEVICE_FILE = join(ASSETS_DIR, "device_seeds.json");
const CONFIG_FILE = join(ASSETS_DIR, "pool_config.json");
const TEST_SEEDS_FILE = join(ASSETS_DIR, "test_seeds.json");

const VERIFY_THRESHOLD = 10;
const TEST_SEED_TIMEOUT_MS = 10 * 60 * 1000;

export type PoolMode = 'unknown' | 'purified';
export type TestPriority = 'all' | '3' | '4' | '5';
export type SeedTag = '未测试' | '热血躲避球' | '普通躲避球' | '冷血躲避球';

interface PurifiedEntry { r: number; tag: SeedTag }

/** 每个卡池独立的状态（purified/verified/pending，不含 testSeeds） */
class MoviePool {
    purified: Map<number, PurifiedEntry> = new Map();
    verified: Set<number> = new Set();
    pending: Map<number, number> = new Map();

    getPurifiedSame(ri: number, pool: number[]): number | null {
        const same = pool.filter(s => { const e = this.purified.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
        return same.length > 0 ? same[Math.floor(Math.random() * same.length)] : null;
    }

    getPurifiedAny(ri: number, pool: number[]): number | null {
        const any = pool.filter(s => { const e = this.purified.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
        return any.length > 0 ? any[Math.floor(Math.random() * any.length)] : null;
    }

    selectFromTestPool(ri: number, pool: number[]): number | null {
        const unknown = pool.filter(s => !this.purified.has(s) && !this.verified.has(s) && !this.pending.has(s));
        if (unknown.length > 0) return unknown[Math.floor(Math.random() * unknown.length)];
        for (let tc = 1; tc < VERIFY_THRESHOLD; tc++) {
            const p = pool.filter(s => this.pending.get(s) === tc);
            if (p.length > 0) return p[Math.floor(Math.random() * p.length)];
        }
        const ver = pool.filter(s => this.verified.has(s));
        if (ver.length > 0) return ver[Math.floor(Math.random() * ver.length)];
        const pur = pool.filter(s => { const e = this.purified.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
        return pur.length > 0 ? pur[Math.floor(Math.random() * pur.length)] : null;
    }

    markSent(seed: number): void {
        if (this.purified.has(seed) || this.verified.has(seed)) return;
        const c = (this.pending.get(seed) || 0) + 1;
        this.pending.set(seed, c);
        if (c >= VERIFY_THRESHOLD) { this.pending.delete(seed); this.verified.add(seed); }
    }

    purifiedStats(): { r3: number; r4: number; r5: number } {
        const s = { r3: 0, r4: 0, r5: 0 };
        for (const [, e] of this.purified) { if (e.r === 0) s.r3++; else if (e.r === 1) s.r4++; else s.r5++; }
        return s;
    }
}

// ============================================================================
// SeedValidator
// ============================================================================

export class SeedValidator {
    private pools: Map<string, MoviePool> = new Map();
    private blocked: Set<number> = new Set();
    private deviceData: Map<number, number> = new Map();
    /** 全局测试种子 — 不区分 movie 配置 */
    private testSeeds: (number | null)[] = [null, null, null];
    private testTimestamps: (number | null)[] = [null, null, null];
    private mode: PoolMode = 'unknown';
    private priority: TestPriority = 'all';
    private selectedMovieId: string = 'fes';

    constructor() { this.load(); }

    private pool(m: string): MoviePool { if (!this.pools.has(m)) this.pools.set(m, new MoviePool()); return this.pools.get(m)!; }

    private load(): void {
        try { if (existsSync(BLOCKED_FILE)) { const a = JSON.parse(readFileSync(BLOCKED_FILE, "utf-8")); if (Array.isArray(a)) this.blocked = new Set(a); } } catch (_) {}
        try { if (existsSync(DEVICE_FILE)) { const o = JSON.parse(readFileSync(DEVICE_FILE, "utf-8")); for (const [k, v] of Object.entries(o)) this.deviceData.set(Number(k), v as number); } } catch (_) {}
        try { if (existsSync(PURIFIED_FILE)) { const o = JSON.parse(readFileSync(PURIFIED_FILE, "utf-8")); this.loadPurified(o); } } catch (_) {}
        try { if (existsSync(VERIFIED_FILE)) { const o = JSON.parse(readFileSync(VERIFIED_FILE, "utf-8")); this.loadPerMovie(o, 'verified'); } } catch (_) {}
        try { if (existsSync(PENDING_FILE)) { const o = JSON.parse(readFileSync(PENDING_FILE, "utf-8")); this.loadPerMovie(o, 'pending'); } } catch (_) {}
        try { if (existsSync(TEST_SEEDS_FILE)) { const a = JSON.parse(readFileSync(TEST_SEEDS_FILE, "utf-8")); this.loadTestSeeds(a); } } catch (_) {}
        try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); if (c.mode) this.mode = c.mode; if (c.priority) this.priority = c.priority; if (c.selectedMovieId) this.selectedMovieId = c.selectedMovieId; } } catch (_) {}
        let t = 0; for (const m of this.pools.values()) t += m.purified.size;
        console.log(`[SEED] Blocked:${this.blocked.size} Purified:${t} Mode:${this.mode}`);
    }

    private loadPurified(obj: any): void {
        for (const [topKey, topVal] of Object.entries(obj)) {
            if (typeof topVal === 'number') this.pool(this.selectedMovieId || 'fes').purified.set(Number(topKey), { r: topVal, tag: '未测试' });
            else if (typeof topVal === 'object' && topVal !== null && 'r' in (topVal as any)) this.pool(this.selectedMovieId || 'fes').purified.set(Number(topKey), { r: (topVal as any).r ?? 0, tag: (topVal as any).tag || '未测试' });
            else if (typeof topVal === 'object' && topVal !== null) {
                const seeds = topVal as Record<string, any>;
                for (const [seed, entry] of Object.entries(seeds)) {
                    if (typeof entry === 'number') this.pool(topKey).purified.set(Number(seed), { r: entry, tag: '未测试' });
                    else this.pool(topKey).purified.set(Number(seed), { r: entry.r ?? 0, tag: entry.tag || '未测试' });
                }
            }
        }
    }

    private loadPerMovie(obj: any, type: 'verified' | 'pending'): void {
        const entries = Object.entries(obj);
        const isNested = entries.length > 0 && typeof entries[0][1] === 'object' && !Array.isArray(entries[0][1]);
        if (isNested) {
            for (const [movieId, seeds] of entries) { const p = this.pool(movieId); for (const [s, v] of Object.entries(seeds as any)) { if (type === 'verified') p.verified.add(Number(s)); else p.pending.set(Number(s), v as number); } }
        } else {
            const p = this.pool(this.selectedMovieId || 'fes');
            for (const [s, v] of entries) { if (type === 'verified') p.verified.add(Number(s)); else p.pending.set(Number(s), v as number); }
        }
    }

    private loadTestSeeds(a: any): void {
        if (!Array.isArray(a)) return;
        this.testSeeds = a.slice(0, 3); for (let i = 0; i < 3; i++) if (typeof this.testSeeds[i] !== 'number') this.testSeeds[i] = null;
        if (a.length > 3 && Array.isArray(a[3])) this.testTimestamps = a[3] as any;
    }

    private savePurified(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = {}; for (const [s, e] of p.purified) o[mid][String(s)] = e; } writeFileSync(PURIFIED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private saveVerified(): void { const o: any = {}; for (const [mid, p] of this.pools) o[mid] = Array.from(p.verified); writeFileSync(VERIFIED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private savePending(): void { const o: any = {}; for (const [mid, p] of this.pools) o[mid] = Object.fromEntries(p.pending); writeFileSync(PENDING_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private saveTestSeeds(): void { writeFileSync(TEST_SEEDS_FILE, JSON.stringify([...this.testSeeds, this.testTimestamps], null, 2), "utf-8"); }
    private saveBlocked(): void { writeFileSync(BLOCKED_FILE, JSON.stringify(Array.from(this.blocked).sort((a, b) => a - b), null, 2), "utf-8"); }
    private saveDeviceData(): void { writeFileSync(DEVICE_FILE, JSON.stringify(Object.fromEntries(this.deviceData), null, 2), "utf-8"); }
    private saveConfig(): void { writeFileSync(CONFIG_FILE, JSON.stringify({ mode: this.mode, priority: this.priority, selectedMovieId: this.selectedMovieId }, null, 2), "utf-8"); }

    // C3032
    recordDeviceData(seed: number, ballRarity: number, _charRarity: number): void { this.deviceData.set(seed, ballRarity); this.saveDeviceData(); }
    blockSeed(seed: number): void { if (this.blocked.has(seed)) return; this.blocked.add(seed); this.saveBlocked(); }
    autoPurify(movieId: string): number {
        let count = 0; const toDelete: number[] = [];
        for (const seed of this.blocked) { const ball = this.deviceData.get(seed); if (ball) { this.pool(movieId).purified.set(seed, { r: ball - 3, tag: '未测试' }); toDelete.push(seed); count++; } }
        for (const s of toDelete) this.blocked.delete(s);
        if (count > 0) { this.savePurified(); this.saveBlocked(); console.log(`[SEED] PURIFIED [${movieId}]: ${count} seeds`); }
        return count;
    }

    // 发送计数
    markSent(movieId: string, seed: number): void { if (this.blocked.has(seed)) return; this.pool(movieId).markSent(seed); this.savePending(); }

    // Tag
    setTag(movieId: string, seed: number, tag: SeedTag): boolean {
        const e = this.pool(movieId).purified.get(seed); if (!e) return false;
        e.tag = tag; if (tag === '冷血躲避球') this.clearTestSeed(e.r); this.savePurified(); return true;
    }

    // 测试种子（全局）
    setTestSeed(_movieId: string, rarity: 3 | 4 | 5, seed: number): boolean {
        const r = rarity - 3; this.testSeeds[r] = seed; this.testTimestamps[r] = Date.now(); this.saveTestSeeds(); return true;
    }
    clearTestSeed(rarity: number): boolean {
        const r = rarity - 3; if (this.testSeeds[r] === null) return false; this.testSeeds[r] = null; this.testTimestamps[r] = null; this.saveTestSeeds(); return true;
    }

    // 模式
    getMode(): PoolMode { return this.mode; } getPriority(): TestPriority { return this.priority; } getSelectedMovieId(): string { return this.selectedMovieId; }
    setMode(m: PoolMode): void { this.mode = m; this.saveConfig(); } setPriority(p: TestPriority): void { this.priority = p; this.saveConfig(); } setSelectedMovieId(id: string): void { this.selectedMovieId = id; this.saveConfig(); }
    getMovieIds(): string[] { return Array.from(this.pools.keys()); }

    // 跨池搜索
    getPurifiedForRarity(movieId: string, rarity: number): number[] {
        const ri = rarity - 3; const seeds: number[] = [];
        for (const [s, e] of this.pool(movieId).purified) if (e.r === ri && e.tag !== '冷血躲避球') seeds.push(s);
        return seeds;
    }

    // 种子选取
    getSeed(movieId: string, rarity: number, pool: number[], characterId: number): number {
        const ri = rarity - 3;
        // 惰性清理过期 testSeeds
        const now = Date.now();
        for (let i = 0; i < 3; i++) { if (this.testTimestamps[i] && now - this.testTimestamps[i]! > TEST_SEED_TIMEOUT_MS) { this.testSeeds[i] = null; this.testTimestamps[i] = null; } }

        // ① 全局测试种子
        const ts = this.testSeeds[ri];
        if (ts !== null) return ts;

        const p = this.pool(movieId);

        // ② 净化池同稀有度
        const pur = p.getPurifiedSame(ri, pool);
        if (pur !== null) return pur;

        if (this.mode === 'purified') {
            const any = p.getPurifiedAny(ri, pool);
            if (any !== null) return any;
            console.log(`[SEED] No purified ★${rarity} in [${movieId}]`);
        }

        // ③ 测试池
        const test = p.selectFromTestPool(ri, pool);
        if (test !== null) return test;

        const fb = characterId * 1000;
        return this.blocked.has(fb) ? this.findFallback(characterId) : fb;
    }

    private findFallback(charId: number): number { for (let o = 0; o < 10000; o++) { const c = charId * 1000 + o; if (!this.blocked.has(c)) return c; } return charId * 1000; }

    // 统计
    stats(movieId?: string) {
        const mid = movieId || this.selectedMovieId || 'fes';
        const p = this.pool(mid); const ps = p.purifiedStats();
        let all = { r3: 0, r4: 0, r5: 0, hot: 0, normal: 0, total: 0 };
        for (const [, pool] of this.pools) {
            const s = pool.purifiedStats(); all.r3 += s.r3; all.r4 += s.r4; all.r5 += s.r5;
            for (const [, e] of pool.purified) { if (e.tag === '热血躲避球') all.hot++; else if (e.tag === '普通躲避球') all.normal++; }
            all.total += pool.purified.size;
        }
        let movHot = 0, movNormal = 0;
        for (const [, e] of p.purified) { if (e.tag === '热血躲避球') movHot++; else if (e.tag === '普通躲避球') movNormal++; }
        return {
            blocked: this.blocked.size, pending: p.pending.size, verified: p.verified.size, unknown: 0,
            mov_r3: ps.r3, mov_r4: ps.r4, mov_r5: ps.r5, mov_total: p.purified.size, mov_hot: movHot, mov_normal: movNormal,
            mov_pending: p.pending.size, mov_verified: p.verified.size,
            purified_r3: all.r3, purified_r4: all.r4, purified_r5: all.r5, purified_total: all.total, hot: all.hot, normal: all.normal,
            test_seeds: this.testSeeds,
            mode: this.mode, priority: this.priority, selectedMovieId: this.selectedMovieId, movieIds: Array.from(this.pools.keys()),
        };
    }

    getPurifiedList(movieId: string): { seed: number; rarity: number; tag: SeedTag }[] {
        return Array.from(this.pool(movieId).purified.entries()).map(([s, e]) => ({ seed: s, rarity: e.r + 3, tag: e.tag }));
    }
}

const validator = new SeedValidator();
export default validator;
