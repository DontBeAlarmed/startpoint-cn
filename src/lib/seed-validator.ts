/**
 * Seed Validator — 简化版种子验证系统
 *
 * 池:
 *   unknown — 仿真生成，未测试
 *   confirmed — markSent 无 crash，rarity 正确
 *   confirmedPlay — PLAY beacon play=1，可播放
 *   pendingPlay — /crash 已知 r，待重测
 *   purified — C3032 + play=1，rarity 正确 + 可播放
 *
 * 自然模式优先级: testSeed > purified(10%) > confirmedPlay > confirmed > pendingPlay > unknown > fallback
 *   优先保证零 C3032（confirmed 已验证），降低崩溃风险
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

interface PurifiedEntry { r: number; tag: SeedTag; play?: boolean }

/** 每个卡池独立的状态 */
class MoviePool {
    confirmed: Set<number> = new Set();
    confirmedPlay: Set<number> = new Set();
    pendingPlay: Map<number, number | null> = new Map(); // seed → r (或 null=无crash)
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
    private mode: PoolMode = 'natural';
    private selectedMovieId: string = 'fes';

    constructor() { this.load(); }

    private pool(m: string): MoviePool { if (!this.pools.has(m)) this.pools.set(m, new MoviePool()); return this.pools.get(m)!; }

    private load(): void {
        try { if (existsSync(CONFIRMED_FILE)) { const o = JSON.parse(readFileSync(CONFIRMED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (mid.endsWith("_play")) { const mid2 = mid.replace("_play", ""); for (const s of seeds as any[]) this.pool(mid2).confirmedPlay.add(Number(s)); } else if (mid.endsWith("_pend")) { const mid2 = mid.replace("_pend", ""); for (const [s, r] of Object.entries(seeds as any)) this.pool(mid2).pendingPlay.set(Number(s), r as number | null); } else { const p = this.pool(mid); for (const s of seeds as any[]) p.confirmed.add(Number(s)); } } } } catch (_) {}
        try { if (existsSync(PURIFIED_FILE)) { const o = JSON.parse(readFileSync(PURIFIED_FILE, "utf-8")); for (const [mid, seeds] of Object.entries(o)) { if (typeof seeds !== 'object' || seeds === null) continue; for (const [s, e] of Object.entries(seeds as any)) this.pool(mid).purified.set(Number(s), { r: (e as any).r ?? 0, tag: (e as any).tag || '未测试', play: (e as any).play }); } } } catch (_) {}
        try { if (existsSync(TEST_SEEDS_FILE)) { const a = JSON.parse(readFileSync(TEST_SEEDS_FILE, "utf-8")); if (Array.isArray(a)) { this.testSeeds = [null, null, null]; for (let i = 0; i < 3; i++) if (typeof a[i] === 'number') this.testSeeds[i] = a[i]; } } } catch (_) {}
        try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); if (c.selectedMovieId) this.selectedMovieId = c.selectedMovieId; } } catch (_) {}
        // mode always defaults to 'natural' — not loaded from config (temporary web toggle only)
        this.mode = 'natural';
        let t = 0; for (const m of this.pools.values()) t += m.purified.size;
        let c = 0; for (const m of this.pools.values()) c += m.confirmed.size;
        console.log(`[SEED] Confirmed:${c} Purified:${t} Mode:${this.mode}`);
    }

    private saveConfirmed(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = Array.from(p.confirmed); o[mid + "_play"] = Array.from(p.confirmedPlay); o[mid + "_pend"] = Object.fromEntries(p.pendingPlay); } writeFileSync(CONFIRMED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private savePurified(): void { const o: any = {}; for (const [mid, p] of this.pools) { o[mid] = {}; for (const [s, e] of p.purified) o[mid][String(s)] = e; } writeFileSync(PURIFIED_FILE, JSON.stringify(o, null, 2), "utf-8"); }
    private saveConfig(): void { writeFileSync(CONFIG_FILE, JSON.stringify({ selectedMovieId: this.selectedMovieId }, null, 2), "utf-8"); }
    private saveTestSeeds(): void { writeFileSync(TEST_SEEDS_FILE, JSON.stringify(this.testSeeds, null, 2), "utf-8"); }

    // 确认种子（rarity 正确）
    confirm(movieId: string, seed: number): void {
        const p = this.pool(movieId);
        if (p.confirmed.has(seed) || p.purified.has(seed)) return;
        // Remove from pending pools if present
        p.pendingPlay.delete(seed);
        for (const [, other] of this.pools) other.confirmed.delete(seed);
        p.confirmed.add(seed);
        this.saveConfirmed();
    }

    // 确认种子可播放（PLAY beacon: seed confirmed + play=1）
    confirmPlay(movieId: string, seed: number): void {
        const p = this.pool(movieId);
        if (p.purified.has(seed)) return;
        p.pendingPlay.delete(seed);
        p.confirmedPlay.add(seed);
        if (!p.confirmed.has(seed)) p.confirmed.add(seed);
        this.saveConfirmed();
    }

    // 净化种子（C3032 beacon + play=1 → purified, play=0 → confirmed, null → pendingPlay）
    purify(movieId: string, seed: number, r: number, didPlay?: boolean | null): void {
        if (didPlay === true) {
            const p = this.pool(movieId);
            p.confirmed.delete(seed);
            p.pendingPlay.delete(seed);
            p.confirmedPlay.delete(seed);
            const entry: PurifiedEntry = { r, tag: '未测试', play: true };
            p.purified.set(seed, entry);
            this.savePurified(); this.saveConfirmed();
            console.log(`[SEED] PURIFIED [${movieId}] seed=${seed} ★${r+3} play=1`);
        } else if (didPlay === false) {
            this.confirm(movieId, seed);
        } else {
            // null = crash path, unknown play status → pendingPlay
            this.addPending(movieId, seed, r);
        }
    }

    // 无 patch APK 测试结果：crash → r 已知，无 crash → r=null
    addPending(movieId: string, seed: number, r: number | null): void {
        const p = this.pool(movieId);
        if (p.purified.has(seed)) return;
        p.confirmed.delete(seed);
        p.confirmedPlay.delete(seed);
        p.pendingPlay.set(seed, r);
        this.saveConfirmed();
    }

    // 标记种子已发送：无 crash → pendingPlay(r=null, 等后续有 beacon 确认)
    markSent(movieId: string, seed: number): void {
        const p = this.pool(movieId);
        if (p.pendingPlay.has(seed) || p.purified.has(seed) || p.confirmed.has(seed) || p.confirmedPlay.has(seed)) return;
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
    setMode(m: PoolMode): void { this.mode = m; } setSelectedMovieId(id: string): void { this.selectedMovieId = id; this.saveConfig(); }
    getMovieIds(): string[] { return Array.from(this.pools.keys()); }

    // 种子选取
    getSeed(movieId: string, rarity: number, pool: number[], characterId: number): number {
        const ri = rarity - 3;
        const PURIFIED_PLAY_RATE = 0.10; // 10% natural play rate

        // ① 全局测试种子（最高优先级）
        const ts = this.testSeeds[ri];
        if (ts !== null) return ts;

        const p = this.pool(movieId);

        if (this.mode === 'play') {
            // 播放模式：100% purified 可播放种子
            const pur = pool.find(s => { const e = p.purified.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
            if (pur !== undefined) return pur;
            const play = pool.find(s => p.confirmedPlay.has(s));
            if (play !== undefined) return play;
        }

        if (this.mode === 'test') {
            // 测试模式：跳过已验证种子，优先发现新种子 + 重测 pending
            const pend = pool.find(s => {
                const r = p.pendingPlay.get(s);
                return r !== undefined && (r === null || r === ri);
            });
            if (pend !== undefined) return pend;

            const unknown = pool.find(s => !p.confirmed.has(s) && !p.purified.has(s) && !p.pendingPlay.has(s));
            if (unknown !== undefined) return unknown;

            return characterId * 1000;
        }

        if (this.mode === 'natural') {
            // 自然模式：10% 用 purified 播放种子，优先保证不崩溃
            const pur = pool.find(s => { const e = p.purified.get(s); return e && e.r === ri && e.tag !== '冷血躲避球'; });
            if (pur !== undefined && Math.random() < PURIFIED_PLAY_RATE) return pur;
        }

        // 已确认可播放种子（PLAY beacon: play=1 → 零 C3032）
        const play = pool.find(s => p.confirmedPlay.has(s));
        if (play !== undefined) return play;

        // 已确认不播放种子（markSent 无 crash → 已验证 1 次，极低 C3032 风险）
        const conf = pool.find(s => p.confirmed.has(s));
        if (conf !== undefined) return conf;

        // 待测播放池（/crash 已知 r，特意重测）
        const pend = pool.find(s => {
            const r = p.pendingPlay.get(s);
            return r !== undefined && (r === null || r === ri);
        });
        if (pend !== undefined) return pend;

        // 未知种子（仿真生成，~1% C3032 风险）
        const unknown = pool.find(s => !p.confirmed.has(s) && !p.purified.has(s) && !p.pendingPlay.has(s));
        if (unknown !== undefined) return unknown;

        // 兜底
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
        let allConfirmed = 0, allConfirmedPlay = 0, allPendingPlay = 0;
        for (const [, pool] of this.pools) {
            const s = pool.purifiedStats(); all.r3 += s.r3; all.r4 += s.r4; all.r5 += s.r5;
            all.total += pool.purified.size;
            allConfirmed += pool.confirmed.size;
            allConfirmedPlay += pool.confirmedPlay.size;
            allPendingPlay += pool.pendingPlay.size;
        }
        return {
            confirmed: p.confirmed.size, confirmed_total: allConfirmed,
            confirmed_play: p.confirmedPlay.size, confirmed_play_total: allConfirmedPlay,
            pending_play: p.pendingPlay.size, pending_play_total: allPendingPlay,
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
