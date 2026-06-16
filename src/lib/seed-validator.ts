/**
 * Seed Validator — 抽卡种子自动验证 + 惊险净化 + Tag + 测试种子 + 动画强制
 *
 * Tags: 未测试 / 热血躲避球 / 普通躲避球 / 冷血躲避球
 * 冷血 = 从池中排除。新 purified 默认为 未测试。
 * 测试种子 10 分钟超时自动清除。
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { GachaSimulator } from "./gacha-physics";

const ASSETS_DIR = join(__dirname, "..", "..", "assets");
const BLOCKED_FILE = join(ASSETS_DIR, "blocked_seeds.json");
const VERIFIED_FILE = join(ASSETS_DIR, "verified_seeds.json");
const PENDING_FILE = join(ASSETS_DIR, "pending_seeds.json");
const PURIFIED_FILE = join(ASSETS_DIR, "purified_seeds.json");
const DEVICE_FILE = join(ASSETS_DIR, "device_seeds.json");
const CONFIG_FILE = join(ASSETS_DIR, "pool_config.json");
const TEST_SEEDS_FILE = join(ASSETS_DIR, "test_seeds.json");

const VERIFY_THRESHOLD = 10;

export type PoolMode = 'unknown' | 'purified';
export type TestPriority = 'all' | '3' | '4' | '5';
export type SeedTag = '未测试' | '热血躲避球' | '普通躲避球' | '冷血躲避球';

interface PurifiedEntry { r: number; tag: SeedTag }

const TEST_SEED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class SeedValidator {
    private blocked: Set<number> = new Set();
    private verified: Set<number> = new Set();
    private sendCount: Map<number, number> = new Map();
    private purified: Map<number, PurifiedEntry> = new Map();
    private deviceData: Map<number, { ballRarity: number; charRarity: number }> = new Map();
    private testSeeds: (number | null)[] = [null, null, null];
    private testSeedTimestamps: (number | null)[] = [null, null, null];
    private forceAnimation: boolean = false; // ★3, ★4, ★5

    private mode: PoolMode = 'unknown';
    private priority: TestPriority = 'all';

    constructor() { this.load(); }

    // ========================================================================
    // 持久化
    // ========================================================================

    private load(): void {
        try { if (existsSync(BLOCKED_FILE)) { const a = JSON.parse(readFileSync(BLOCKED_FILE,"utf-8")); if (Array.isArray(a)) this.blocked = new Set(a); console.log(`[SEED] Blocked: ${this.blocked.size}`); } } catch (e) { console.error(`[SEED] blocked:`, (e as Error).message); }
        try { if (existsSync(VERIFIED_FILE)) { const a = JSON.parse(readFileSync(VERIFIED_FILE,"utf-8")); if (Array.isArray(a)) this.verified = new Set(a); console.log(`[SEED] Verified: ${this.verified.size}`); } } catch (e) { console.error(`[SEED] verified:`, (e as Error).message); }
        try { if (existsSync(PENDING_FILE)) { const o = JSON.parse(readFileSync(PENDING_FILE,"utf-8")); for (const [k,v] of Object.entries(o)) this.sendCount.set(Number(k), v as number); console.log(`[SEED] Pending: ${this.sendCount.size}`); } } catch (e) { console.error(`[SEED] pending:`, (e as Error).message); }
        try { if (existsSync(PURIFIED_FILE)) { this.loadPurified(); } } catch (e) { console.error(`[SEED] purified:`, (e as Error).message); }
        try { if (existsSync(DEVICE_FILE)) { const o = JSON.parse(readFileSync(DEVICE_FILE,"utf-8")); for (const [k,v] of Object.entries(o)) this.deviceData.set(Number(k), {ballRarity: v as number, charRarity: 0}); console.log(`[SEED] Device data: ${this.deviceData.size}`); } } catch (e) { console.error(`[SEED] device:`, (e as Error).message); }
        try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE,"utf-8")); if (c.mode) this.mode=c.mode; if (c.priority) this.priority=c.priority; if (c.forceAnimation !== undefined) this.forceAnimation=c.forceAnimation; console.log(`[SEED] Mode: ${this.mode} Priority: ${this.priority} ForceAnim: ${this.forceAnimation}`); } } catch (e) { console.error(`[SEED] config:`, (e as Error).message); }
        try { if (existsSync(TEST_SEEDS_FILE)) { const a = JSON.parse(readFileSync(TEST_SEEDS_FILE,"utf-8")); if (Array.isArray(a)) this.testSeeds = a.slice(0,3); if (a.length > 3 && Array.isArray(a[3])) this.testSeedTimestamps = a[3]; console.log(`[SEED] Test seeds: ${this.testSeeds} ts:${this.testSeedTimestamps}`); } } catch (e) { console.error(`[SEED] testSeeds:`, (e as Error).message); }
    }

    /** 加载 purified，自动迁移旧格式 {seed: rarity} → {seed: {r, tag}} */
    private loadPurified(): void {
        const obj = JSON.parse(readFileSync(PURIFIED_FILE,"utf-8"));
        let migrated = false;
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'number') {
                this.purified.set(Number(k), { r: v, tag: '未测试' });
                migrated = true;
            } else if (typeof v === 'object' && v !== null) {
                this.purified.set(Number(k), { r: (v as any).r ?? 0, tag: (v as any).tag || '未测试' });
            }
        }
        if (migrated) { this.savePurified(); console.log('[SEED] Migrated purified to new format'); }
        console.log(`[SEED] Purified: ${this.purified.size}`);
    }

    private savePurified(): void {
        const obj: Record<string, PurifiedEntry> = {};
        for (const [k, v] of this.purified) obj[String(k)] = v;
        writeFileSync(PURIFIED_FILE, JSON.stringify(obj, null, 2), "utf-8");
    }

    private saveBlocked(): void { writeFileSync(BLOCKED_FILE, JSON.stringify(Array.from(this.blocked).sort((a,b)=>a-b), null, 2), "utf-8"); }
    private saveVerified(): void { writeFileSync(VERIFIED_FILE, JSON.stringify(Array.from(this.verified).sort((a,b)=>a-b), null, 2), "utf-8"); }
    private savePending(): void { writeFileSync(PENDING_FILE, JSON.stringify(Object.fromEntries(this.sendCount), null, 2), "utf-8"); }
    private saveDeviceData(): void { writeFileSync(DEVICE_FILE, JSON.stringify(Object.fromEntries(Array.from(this.deviceData.entries()).map(([k,v])=>[k,v.ballRarity])), null, 2), "utf-8"); }
    private saveConfig(): void { writeFileSync(CONFIG_FILE, JSON.stringify({mode:this.mode, priority:this.priority, forceAnimation:this.forceAnimation}, null, 2), "utf-8"); }
    private saveTestSeeds(): void { writeFileSync(TEST_SEEDS_FILE, JSON.stringify([...this.testSeeds, this.testSeedTimestamps], null, 2), "utf-8"); }

    // ========================================================================
    // C3032 回调
    // ========================================================================

    recordDeviceData(seed: number, ballRarity: number, charRarity: number): void {
        this.deviceData.set(seed, { ballRarity, charRarity });
        this.saveDeviceData();
    }

    blockSeed(seed: number): void {
        if (this.blocked.has(seed)) return;
        this.sendCount.delete(seed);
        this.verified.delete(seed);
        this.blocked.add(seed);
        this.saveBlocked(); this.savePending(); this.saveVerified();
        console.log(`[SEED] BLOCKED seed ${seed} (C3032)`);
    }

    autoPurify(): number {
        let count = 0;
        const toDelete: number[] = [];
        for (const seed of this.blocked) {
            const dd = this.deviceData.get(seed);
            if (dd) {
                this.purified.set(seed, { r: dd.ballRarity - 3, tag: '未测试' });
                toDelete.push(seed);
                count++;
                console.log(`[SEED] PURIFIED seed ${seed}: ★${dd.ballRarity} (未测试)`);
            }
        }
        for (const s of toDelete) this.blocked.delete(s);
        if (count > 0) { this.savePurified(); this.saveBlocked(); }
        return count;
    }

    // ========================================================================
    // 发送计数
    // ========================================================================

    markSent(seed: number): void {
        if (this.blocked.has(seed)) return;
        if (this.verified.has(seed)) return;
        if (this.purified.has(seed)) return;

        const count = (this.sendCount.get(seed) || 0) + 1;
        this.sendCount.set(seed, count);
        this.savePending();

        if (count >= VERIFY_THRESHOLD) {
            this.sendCount.delete(seed);
            this.verified.add(seed);
            this.savePending(); this.saveVerified();
            console.log(`[SEED] VERIFIED seed ${seed} (${count}x no crash)`);
        }
    }

    // ========================================================================
    // Tag 管理
    // ========================================================================

    setTag(seed: number, tag: SeedTag): boolean {
        const entry = this.purified.get(seed);
        if (!entry) return false;
        entry.tag = tag;
        this.savePurified();
        // 冷血 → 清除该稀有度的测试种子
        if (tag === '冷血躲避球') this.clearTestSeed(entry.r + 3);
        return true;
    }

    // ========================================================================
    // 测试种子
    // ========================================================================

    /** 设置测试种子 — 自动开启强制动画 */
    setTestSeed(rarity: 3|4|5, seed: number): boolean {
        const entry = this.purified.get(seed);
        if (!entry || entry.tag === '冷血躲避球') return false;
        if (entry.r !== rarity - 3) return false;
        this.testSeeds[rarity - 3] = seed;
        this.testSeedTimestamps[rarity - 3] = Date.now();
        this.forceAnimation = true; // 设测试种子 → 自动开
        this.saveTestSeeds();
        this.saveConfig();
        return true;
    }

    /** 清除测试种子 — 无测试种子+净化池 → 自动关 */
    clearTestSeed(rarity: 3|4|5): boolean {
        if (this.testSeeds[rarity - 3] === null) return false;
        this.testSeeds[rarity - 3] = null;
        this.testSeedTimestamps[rarity - 3] = null;
        if (!this.hasActiveTestSeeds() && this.mode === 'purified') this.forceAnimation = false;
        this.saveTestSeeds();
        this.saveConfig();
        return true;
    }

    getTestSeeds(): (number | null)[] { return [...this.testSeeds]; }

    // ========================================================================
    // 池模式
    // ========================================================================

    getMode(): PoolMode { return this.mode; }
    getPriority(): TestPriority { return this.priority; }

    setMode(mode: PoolMode): void {
        this.mode = mode;
        // 净化池 → 根据是否有测试种子自动切换
        if (mode === 'purified') this.forceAnimation = this.hasActiveTestSeeds();
        // 测试池 → 自动开
        if (mode === 'unknown') this.forceAnimation = true;
        this.saveConfig();
        console.log(`[SEED] Mode → ${mode}, ForceAnim → ${this.forceAnimation}`);
    }

    setPriority(priority: TestPriority): void { this.priority = priority; this.saveConfig(); console.log(`[SEED] Priority → ${priority}`); }
    setForceAnimation(v: boolean): void { this.forceAnimation = v; this.saveConfig(); console.log(`[SEED] ForceAnimation → ${v}`); }
    getForceAnimation(): boolean { return this.forceAnimation; }

    private hasActiveTestSeeds(): boolean {
        const now = Date.now();
        for (let i = 0; i < 3; i++) {
            if (this.testSeeds[i] !== null && (this.testSeedTimestamps[i] === null || now - this.testSeedTimestamps[i]! < TEST_SEED_TIMEOUT_MS)) return true;
        }
        return false;
    }

    /**
     * 过滤出 playProbability >= playMovie 的种子（100% 触发动画）。
     * 扫描至多 5000 个种子，找到至少 50 个满足条件的。
     * moviePlayable = playProbability >= playMovie(0.8995)
     */
    private filterPlayable(pool: number[]): number[] {
        const result: number[] = [];
        const PLAY_MOVIE = 0.8995;
        const MAX_SCAN = 5000;
        const MIN_MATCH = 50;
        for (let i = 0; i < pool.length && i < MAX_SCAN; i++) {
            const sim = new GachaSimulator(pool[i]);
            if (sim.getPlayProbability() >= PLAY_MOVIE) {
                result.push(pool[i]);
                if (result.length >= MIN_MATCH) break;
            }
        }
        if (result.length === 0) {
            console.log(`[SEED] ForceAnim: no playable seeds found in ${Math.min(pool.length, MAX_SCAN)} scanned`);
            return pool.slice(0, MIN_MATCH); // fallback: return some seeds anyway
        }
        return result;
    }

    // ========================================================================
    // 跨池搜索
    // ========================================================================

    getPurifiedForRarity(rarity: number): number[] {
        const ri = rarity - 3;
        const seeds: number[] = [];
        for (const [seed, e] of this.purified) {
            if (e.r === ri && e.tag !== '冷血躲避球') seeds.push(seed);
        }
        return seeds;
    }

    // ========================================================================
    // 种子选取
    // ========================================================================

    getSeed(rarity: number, pool: number[], characterId: number): number {
        const ri = rarity - 3;

        // 惰性清理过期 testSeeds
        const now = Date.now();
        for (let i = 0; i < 3; i++) {
            const ts = this.testSeedTimestamps[i];
            if (ts && now - ts > TEST_SEED_TIMEOUT_MS) {
                this.testSeeds[i] = null;
                this.testSeedTimestamps[i] = null;
                console.log(`[SEED] Test seed ★${i+3} expired (10min timeout)`);
            }
        }

        // 测试种子：forceAnimation ON 时跳过低动画触发率的种子
        const ts = this.testSeeds[ri];
        if (ts !== null) {
            if (this.forceAnimation) {
                const sim = new GachaSimulator(ts);
                if (sim.getPlayProbability() >= 0.8995) {
                    return ts;
                }
                console.log(`[SEED] Test seed ${ts} playProbability < 0.9, skipping (forceAnimation ON)`);
            } else {
                return ts;
            }
        }

        // 强制动画过滤（所有模式生效，采样前500个满足条件的种子）
        let effectivePool = pool;
        if (this.forceAnimation) {
            effectivePool = this.filterPlayable(pool);
            console.log(`[SEED] ForceAnim: filtered ${pool.length}→${effectivePool.length} seeds for ★${rarity}`);
        }

        if (this.mode === 'purified') {
            // ② 同稀有度 + 非冷血
            const same = effectivePool.filter(s => {
                const e = this.purified.get(s);
                return e && e.r === ri && e.tag !== '冷血躲避球';
            });
            if (same.length > 0) return same[Math.floor(Math.random() * same.length)];

            console.log(`[SEED] No purified ★${rarity} seeds, check Web page`);
        }

        // 测试池：UNKNOWN > PENDING·N > VERIFIED > PURIFIED
        const unknown = effectivePool.filter(s =>
            !this.blocked.has(s) && !this.verified.has(s) && !this.sendCount.has(s) && !this.purified.has(s)
        );
        if (unknown.length > 0) return unknown[Math.floor(Math.random() * unknown.length)];

        for (let tc = 1; tc < VERIFY_THRESHOLD; tc++) {
            const pending = effectivePool.filter(s => this.sendCount.get(s) === tc);
            if (pending.length > 0) return pending[Math.floor(Math.random() * pending.length)];
        }

        const ver = effectivePool.filter(s => this.verified.has(s));
        if (ver.length > 0) return ver[Math.floor(Math.random() * ver.length)];

        const pur = effectivePool.filter(s => {
            const e = this.purified.get(s);
            return e && e.r === ri && e.tag !== '冷血躲避球';
        });
        if (pur.length > 0) return pur[Math.floor(Math.random() * pur.length)];

        const fb = characterId * 1000;
        if (!this.blocked.has(fb)) return fb;
        for (let o = 0; o < 10000; o++) { const c = characterId * 1000 + o; if (!this.blocked.has(c)) return c; }
        return characterId * 1000;
    }

    // ========================================================================
    // 统计
    // ========================================================================

    stats() {
        const ps = { r3: 0, r4: 0, r5: 0 };
        for (const [, e] of this.purified) { if (e.r===0) ps.r3++; else if (e.r===1) ps.r4++; else ps.r5++; }
        return {
            blocked: this.blocked.size, verified: this.verified.size,
            pending: this.sendCount.size, unknown: 0,
            purified_r3: ps.r3, purified_r4: ps.r4, purified_r5: ps.r5,
            purified_total: this.purified.size,
            test_seeds: this.testSeeds,
            mode: this.mode, priority: this.priority,
            forceAnimation: this.forceAnimation,
        };
    }

    getBlockedList(): number[] { return Array.from(this.blocked).sort((a,b)=>a-b); }
    getVerifiedList(): number[] { return Array.from(this.verified).sort((a,b)=>a-b); }
    getPurifiedList(): {seed:number; rarity:number; tag:SeedTag}[] {
        return Array.from(this.purified.entries()).map(([s, e]) => ({ seed: s, rarity: e.r + 3, tag: e.tag }));
    }
    getDeviceDataFor(seed: number) { return this.deviceData.get(seed); }
}

const validator = new SeedValidator();
export default validator;
