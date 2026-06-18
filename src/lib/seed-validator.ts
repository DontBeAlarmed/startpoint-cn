/**
 * Seed Validator — 简化版种子验证系统
 *
 * 三个池:
 *   unknown — 仿真生成，未测试
 *   confirmed — 发送 1 次无 C3032（或 C3032 但 play=false），rarity 正确
 *   purified — C3032 beacon + play=1，rarity 正确 + 确认播放动画
 *
 * 选择优先级: testSeed > purified > confirmed > unknown
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");
const CONFIRMED_FILE = join(ASSETS_DIR, "confirmed_seeds.json");
const PURIFIED_FILE = join(ASSETS_DIR, "purified_seeds.json");
const CONFIG_FILE = join(ASSETS_DIR, "pool_config.json");
const TEST_SEEDS_FILE = join(ASSETS_DIR, "test_seeds.json");

export type PoolMode = 'unknown' | 'purified';
export type SeedTag = '未测试' | '热血躲避球' | '普通躲避球' | '冷血躲避球';

interface PurifiedEntry { r: number; tag: SeedTag; play?: boolean }

/** 每个卡池独立的状态 */
class MoviePool {
    confirmed: Set<number> = new Set();
    purified: Map<number, PurifiedEntry> = new Map();

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
    private testSeeds: (number | null)[] = [null, null, null];
    private mode: PoolMode = 'unknown';
    private selectedMovieId: string = 'fes';

    constructor() { this.load(); }

    private pool(m: string): MoviePool { if (!this.pools.has(m)) this.pools.set(m, new MoviePool()); return this.pools.get(m)!; }

    private load(): void {
        try { if (existsSync(CONFIRMED_FILE)) { const o = JSON.parse(readFileSync(CONFIRMED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { const p = this.pool(mid); for (const s of seeds as any[]) p.confirmed.add(Number(s)); } } } catch (_) {}
        try { if (existsSync(PURIFIED_FILE)) { const o = JSON.parse(readFileSync(PURIFIED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (typeof seeds !== 'object' || seeds === null) continue; for (const [s, e] of Object.entries(seeds as any)) this.pool(mid).purified.set(Number(s), { r: (e as any).r ?? 0, tag: (e as any).tag || '未测试', play: (e as any).play }); } } } catch (_) {}
        try { if (existsSync(TEST_SEEDS_FILE)) { const a = JSON.parse(readFileSync(TEST_SEEDS_FILE, "utf-8")); if (Array.isArray(a)) { this.testSeeds = [null, null, null]; for (let i = 0; i < 3; i++) if (typeof a[i] === 'number') this.testSeeds[i] = a[i]; } } } catch (_) {}
        try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); if (c.mode) this.mode = c.mode; if (c.selectedMovieId) this.selectedMovieId = c.selectedMovieId; } } catch (_) {}
        let t = 0; for (const m of this.pools.values()) t += m.purified.size;
        let c = 0; for (const m of this.pools.values()) c += m.confirmed.size;
        console.log(`[SEED] Confirmed:${c} Purified:${t} Mode:${this.mode}`);
    }

    private saveConfirmed(): void { const o: any = {}; for (const [mid, p] of this.pools) o[mid] = Array.from(p.confirmed); writeFileSync(CONFIRMED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private savePurified(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = {}; for (const [s, e] of p.purified) o[mid][String(s)] = e; } writeFileSync(PURIFIED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private saveConfig(): void { writeFileSync(CONFIG_FILE, JSON.stringify({ mode: this.mode, selectedMovieId: this.selectedMovieId }, null, 2), "utf-8"); }
    private saveTestSeeds(): void { writeFileSync(TEST_SEEDS_FILE, JSON.stringify(this.testSeeds, null, 2), "utf-8"); }

    // 确认种子（rarity 正确）
    confirm(movieId: string, seed: number): void {
        const p = this.pool(movieId);
        if (p.confirmed.has(seed) || p.purified.has(seed)) return;
        // Remove from other pools if present
        for (const [, other] of this.pools) other.confirmed.delete(seed);
        p.confirmed.add(seed);
        this.saveConfirmed();
    }

    // 净化种子（C3032 beacon + play=1）
    purify(movieId: string, seed: number, r: number, didPlay?: boolean): void {
        // Only purify if play=1 (client confirmed animation played)
        if (didPlay !== true) {
            this.confirm(movieId, seed);
            return;
        }
        const p = this.pool(movieId);
        p.confirmed.delete(seed);
        const entry: PurifiedEntry = { r, tag: '未测试', play: true };
        p.purified.set(seed, entry);
        this.savePurified(); this.saveConfirmed();
        console.log(`[SEED] PURIFIED [${movieId}] seed=${seed} ★${r+3} play=1`);
    }

    // 标记种子已发送（客户端无 C3032 → 确认正确）
    markSent(movieId: string, seed: number): void {
        this.confirm(movieId, seed);
        console.log(`[SEED] CONFIRMED [${movieId}] seed=${seed}`);
    }

    // Tag
    setTag(movieId: string, seed: number, tag: SeedTag): boolean {
        const e = this.pool(movieId).purified.get(seed); if (!e) return false;
        e.tag = tag; if (tag === '冷血躲避球') this.clearTestSeed(e.r); this.savePurified(); return true;
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
    setMode(m: PoolMode): void { this.mode = m; this.saveConfig(); } setSelectedMovieId(id: string): void { this.selectedMovieId = id; this.saveConfig(); }
    getMovieIds(): string[] { return Array.from(this.pools.keys()); }

    // 种子选取
    getSeed(movieId: string, rarity: number, pool: number[], characterId: number): number {
        const ri = rarity - 3;

        // ① 全局测试种子
        const ts = this.testSeeds[ri];
        if (ts !== null) return ts;

        const p = this.pool(movieId);

        // ② 净化池（仅净化池模式 + play=1）
        if (this.mode === 'purified') {
            const pur = pool.find(s => { const e = p.purified.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
            if (pur !== undefined) return pur;
            console.log(`[SEED] No purified ★${rarity} play=1 in [${movieId}]`);
        }

        // ③ 已确认种子（rarity 正确但播放未知）
        const conf = pool.find(s => p.confirmed.has(s));
        if (conf !== undefined) return conf;

        // ④ 未测试种子
        const unknown = pool.find(s => !p.confirmed.has(s) && !p.purified.has(s));
        if (unknown !== undefined) return unknown;

        // ⑤ 兜底
        return characterId * 1000;
    }

    // 跨池搜索（用于种子池注入）
    getPurifiedForRarity(movieId: string, rarity: number): number[] {
        const ri = rarity - 3;
        return Array.from(this.pool(movieId).purified.entries())
            .filter(([, e]) => e.r === ri && e.tag !== '冷血躲避球')
            .map(([s]) => s);
    }

    // 统计
    stats(movieId?: string) {
        const mid = movieId || this.selectedMovieId || 'fes';
        const p = this.pool(mid); const ps = p.purifiedStats();
        let all = { r3: 0, r4: 0, r5: 0, total: 0 };
        let allConfirmed = 0;
        for (const [, pool] of this.pools) {
            const s = pool.purifiedStats(); all.r3 += s.r3; all.r4 += s.r4; all.r5 += s.r5;
            all.total += pool.purified.size;
            allConfirmed += pool.confirmed.size;
        }
        return {
            confirmed: p.confirmed.size, confirmed_total: allConfirmed,
            purified_r3: all.r3, purified_r4: all.r4, purified_r5: all.r5, purified_total: all.total,
            mov_r3: ps.r3, mov_r4: ps.r4, mov_r5: ps.r5, mov_total: p.purified.size,
            test_seeds: this.testSeeds,
            mode: this.mode, selectedMovieId: this.selectedMovieId, movieIds: Array.from(this.pools.keys()),
        };
    }

    getPurifiedList(movieId: string): { seed: number; rarity: number; tag: SeedTag; play?: boolean }[] {
        return Array.from(this.pool(movieId).purified.entries()).map(([s, e]) => ({ seed: s, rarity: e.r + 3, tag: e.tag, play: e.play }));
    }

    getConfirmedList(movieId: string): number[] {
        return Array.from(this.pool(movieId).confirmed);
    }
}

const validator = new SeedValidator();
export default validator;
