/**
 * Gacha Ball Movie Physics Engine
 *
 * A faithful port of the CN client's gacha table physics simulation
 * (FixedFallingField + FallingField + gacha_physics.World).
 *
 * Source files:
 *   wf-2.1.125-cn-decompiled/scripts/scripts/pinball/
 *     common/random/MersenneTwister.as
 *     gacha/ballMovie/fallingField/FallingField.as
 *     gacha/ballMovie/fallingField/FixedFallingField.as
 *     gacha/ballMovie/element/Ball.as
 *     gacha/ballMovie/element/Pin.as
 *     gacha/ballMovie/element/Amulet.as
 *
 * Purpose: Generate valid seed pools for each rarity tier (★3/★4/★5)
 * by running the same MersenneTwister-seeded simulation the CN client runs.
 *
 * 2026-06-18: Ported AS3 MathCompat.cos/sin (Taylor-series) to replace
 * JS Math.cos/sin — eliminates ~28% seed prediction error caused by
 * IEEE-754 vs Taylor approximation trajectory divergence. Also removed
 * CCD ball-position rewind to match client's end-of-frame contact logic.
 *
 * Config source: CN CDN archive-common-full (AMF3 → deflate decompressed)
 *   gacha/normal.gacha.amf3.deflate
 *   gacha/fes.gacha.amf3.deflate
 *   gacha/normal_guarantee.gacha.amf3.deflate
 *   gacha/rarity_5_guarantee.gacha.amf3.deflate
 *
 * All 4 configs are nearly identical — differences in the threshold section.
 */

// ============================================================================
// MathCompat — AS3 custom cos/sin ported for 100% client alignment
// AS3: pinball.common.math.MathCompat.cos / sin
// Uses Taylor-series approximation (NOT IEEE 754), critical for RNG-trace match
// ============================================================================

const PI = 3.141592653589793;
const PI_2 = PI / 2;                          // 1.5707963267948966
const PI_4 = PI / 4;                          // 0.7853981633974483
const TWO_PI = 2 * PI;                        // 6.283185307179586

/** cos(x) — Cody-Waite range reduction + 6/5-term Taylor (matches AS3 exactly) */
function gachaCosCore(x: number): number {
    const absX = x < 0 ? -x : x;
    const x2 = x * x;
    const poly = x2 * (0.0416666666666666 + x2 * (-0.001388888888887411
        + x2 * (0.00002480158728947673 + x2 * (-2.7557314351390663e-7
        + x2 * (2.087572321298175e-9 + x2 * -1.1359647557788195e-11)))));
    const t = absX > 0.78125 ? 0.28125 : x / 4;
    const a = 0.5 * x2 - t;
    const b = 1 - t;
    return b - (a - x2 * poly);
}

/** sin(x) core — 5-term odd Taylor series */
function gachaSinCore(x: number): number {
    const x2 = x * x;
    const x3 = x2 * x;
    const poly = 0.00833333333332249 + x2 * (-0.0001984126982985795
        + x2 * (0.0000027557313707070068 + x2 * (-2.5050760253406863e-8
        + x2 * 1.58969099521155e-10)));
    return x + x3 * (-0.16666666666666632 + x2 * poly);
}

/** Full cos(x) — quadrant reduction wrapping _cos/_sin cores */
function gachaCos(x: number): number {
    x = x < 0 ? -x : x;
    const frac = (x + PI_4) % TWO_PI / PI_2;
    const quadrant = frac < 0 ? Math.floor(frac - 1e-10) : Math.floor(frac + 1e-10);
    const reduced = (frac - quadrant) * PI_2 - PI_4;
    const q = quadrant & 3;
    switch (q) {
        case 0: return gachaCosCore(reduced);
        case 1: return -gachaSinCore(reduced);
        case 2: return -gachaCosCore(reduced);
        case 3: return gachaSinCore(reduced);
        default: return NaN;
    }
}

/** sin(x) = cos(x - π/2) */
function gachaSin(x: number): number {
    return gachaCos(x - PI_2);
}

// ============================================================================
// MersenneTwister — MT19937 ported from AS3
// ============================================================================

const MT_LENGTH = 624;

class MersenneTwister {
    private mt: number[];
    private index: number;

    constructor(seed: number) {
        // Force int32 range (Flash int semantics — signed 32-bit)
        this.seed = seed | 0;
        this.index = 0;
        this.mt = new Array(MT_LENGTH);

        // Initialize state array using int32 arithmetic
        // AS3: _loc2_ = 1812433253 * (_loc2_ ^ _loc2_ >>> 30) + _loc4_;
        // Use |0 to mimic AS3 signed int32 overflow behavior
        this.mt[0] = seed | 0;
        let v = seed | 0;
        for (let i = 1; i < MT_LENGTH; i++) {
            // 1812433253 * (v ^ (v >>> 30)) + i  (int32)
            v = (Math.imul(1812433253, v ^ (v >>> 30)) + i) | 0;
            this.mt[i] = v;
        }

        // Burn-in: generate 624 values to complete initialization
        for (let i = 0; i < MT_LENGTH; i++) {
            this.randomUInt();
        }
    }

    /** Generate next raw 32-bit unsigned integer */
    randomUInt(): number {
        const i = this.index;
        const mt = this.mt;

        // Read as signed int32 (matches AS3 int(mt[i]))
        let y = mt[i] | 0;
        this.index = (i + 1) % MT_LENGTH;

        // Twister: y & UPPER_MASK | mt[index] & LOWER_MASK
        // UPPER_MASK = 0x80000000, LOWER_MASK = 0x7FFFFFFF
        const y2 = (y & 0x80000000) | (mt[this.index] & 0x7FFFFFFF);

        // mt[i] = mt[(i + 397) % 624] ^ (y2 >>> 1) ^ magic
        // Use |0 to match AS3 signed int32 storage
        const magic = -1727483681; // 0x9908B0DF
        mt[i] = (mt[(i + 397) % MT_LENGTH] ^ (y2 >>> 1) ^ (y2 & 1 ? magic : 0)) | 0;

        // Tempering (on PRE-TWIST y — matches AS3 which tempers _loc2_
        // that was read before the twist on line int(mt[_loc1_]))
        y ^= y >>> 11;
        y ^= (y << 7) & 0x9D2C5680; // -1658038656
        y ^= (y << 15) & 0xEFC60000; // -272236544
        y ^= y >>> 18;

        return y >>> 0;
    }

    /** Convert uint to float in [0, 1) — matches Flash Number = uint / 4294967296 */
    private toFloat(v: number): number {
        return (v >>> 0) / 4294967296;
    }

    /** Random float in [min, max) */
    randomRangeFloat(min: number, max: number): number {
        return min + this.toFloat(this.randomUInt()) * (max - min);
    }

    /** Random integer in [min, max] (inclusive) */
    randomRange(min: number, max: number): number {
        return Math.floor(this.randomRangeFloat(min, max + 1) + 1e-10 + 1e-10);
    }

    // For backward compatibility with some implementations
    get seed(): number {
        return 0; // Not exposed in AS3 after construction
    }

    set seed(_v: number) { /* noop */ }
}

// ============================================================================
// Data types — mirroring AS3 Pin / Amulet / Ball
// ============================================================================

interface Vec2 {
    x: number;
    y: number;
}

enum AmuletPlaceId {
    Circle = 0,
    Bar = 1,
}

interface AmuletData {
    placeId: AmuletPlaceId;
    probability: number;
    twoUpProbability: number;
    x: number;
    y: number;
    rarity: number;
    contacted: boolean;
    forceContacted: boolean;
    sensor: boolean; // sensor amulets don't bounce
}

interface PinData {
    id: number;
    x: number;
    y: number;
    radius: number;
    restitution: number;
    contacted: boolean;
}

// ============================================================================
// Physics configuration — extracted from CN CDN normal.amf3
// ============================================================================

export interface GachaPhysicsConfig {
    /** Random seed injected by the server (from draw response) */
    seed: number;
    field: {
        width: number;
        height: number;
        gravityX: number;
        gravityY: number;
        wallRestitution: number;
    };
    ball: {
        initialXMin: number;
        initialXMax: number;
        initialY: number;
        ejectionVelocity: number;
        ejectionAngleMin: number;
        ejectionAngleMax: number;
        radius: number;
        maxSpeed: number;
    };
    pin: {
        countPerLine: number;
        lineCount: number;
        firstLineY: number;
        evenLineOffsetRatio: number;
        oddLineOffsetRatio: number;
        distanceHorizontal: number;
        lineDistance: number;
        verticalRestitution: number;
        horizontalRestitution: number;
        totalCountMin: number;
        totalCountMax: number;
        radius: number;
    };
    amulet: {
        countPerLine: number;
        lineCount: number;
        firstLineY: number;
        evenLineOffsetRatio: number;
        oddLineOffsetRatio: number;
        distanceHorizontal: number;
        lineDistance: number;
        radius: number;
        totalCount: number;
        limitTotalCount: boolean;
        decideTwoUpWhenAppear: boolean;
    };
    barAmulet: {
        lineCount: number;
        firstLineY: number;
        lineDistance: number;
        height: number;
        totalCount: number;
    };
    threshold: {
        ballStar4: number;
        amuletTwoUp: number;
        amulets: (number | null)[];
        playMovie: number;
        isRarity5?: boolean;
    };
}

/**
 * Default CN gacha physics configuration for movie_id="normal".
 * Extracted from CN CDN archive-common-full /gacha/normal.gacha.amf3.deflate.
 */
export const CN_GACHA_PHYSICS_CONFIG: Omit<GachaPhysicsConfig, 'seed'> = {
    field: {
        width: 1080,
        height: 3840,
        gravityX: 0,
        gravityY: 0.9,
        wallRestitution: 1,
    },
    ball: {
        initialXMin: 100,
        initialXMax: 880,
        initialY: 200,
        ejectionVelocity: 15,
        ejectionAngleMin: 40,
        ejectionAngleMax: 140,
        radius: 48,
        maxSpeed: 35,
    },
    pin: {
        countPerLine: 4,
        lineCount: 12,
        firstLineY: 1070,
        evenLineOffsetRatio: 0.25,
        oddLineOffsetRatio: -0.25,
        distanceHorizontal: 290,
        lineDistance: 165,
        verticalRestitution: 0.7,
        horizontalRestitution: 0.7,
        totalCountMin: 30,
        totalCountMax: 35,
        radius: 24, // AMF3 verified: pin U29 int at position 8
    },
    amulet: {
        countPerLine: 3,
        lineCount: 14,
        firstLineY: 1630,
        evenLineOffsetRatio: -0.25,
        oddLineOffsetRatio: 0.25,
        distanceHorizontal: 290,
        lineDistance: 165,
        radius: 40,
        totalCount: 5,
        limitTotalCount: false,
        decideTwoUpWhenAppear: false,
    },
    barAmulet: {
        totalCount: 1,      // FIX: decoded from real client AMF3 (was 5 — wrong, mis-aligned the MT stream)
        lineCount: 5,       // FIX: real client AMF3 (was 40)
        firstLineY: 3025,   // AMF3 verified
        lineDistance: 165,  // AMF3 verified
        height: 40,         // FIX: real client AMF3 (was 1)
    },
    threshold: {
        ballStar4: 0.7582740783691406,
        amuletTwoUp: 0.8148193359375,
        amulets: [null, 0, 0, 0, 0, 0, 0.9022216796875, 0, 0, 0, 0, 0, 0],
        playMovie: 0.8995208740234375,
    },
};

/** Deep-partial: nested config objects become optional; arrays/primitives kept intact. */
type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends any[] ? T[P] : T[P] extends object ? DeepPartial<T[P]> : T[P]
};

/**
 * Movie-specific config overrides for different gacha animation types.
 * Extracted from CN CDN AMF3 files.
 */
export const MOVIE_CONFIGS: Record<string, DeepPartial<Omit<GachaPhysicsConfig, 'seed'>>> = {
    normal: {
        amulet: { totalCount: 5 },
        threshold: {
            amulets: [0, 0, 0, 0, 0, 0.9022216796875],
            ballStar4: 0.7582740783691406,
            amuletTwoUp: 0.8148193359375,
            playMovie: 0.8995208740234375,
        },
    },
    fes: {
        amulet: { totalCount: 7 },
        threshold: {
            amulets: [0, 0, 0, 0, 0, 0, 0, 0.7190780639648438],
            ballStar4: 0.7429313659667969,
            amuletTwoUp: 0.475677490234375,
            playMovie: 0.8994979858398438,
        },
    },
    normal_guarantee: {
        amulet: { totalCount: 5 },
        threshold: {
            amulets: [0, 0, 0, 0, 0.18988037109375, 1],
            ballStar4: 3.814697265625e-05,
            amuletTwoUp: 0.5,
            playMovie: 0.9299392700195312,
        },
    },
    fes_guarantee: {
        amulet: { totalCount: 7 },
        threshold: {
            amulets: [0, 0, 0, 0, 0, 0.6259765625, 0.999114990234375, 1],
            ballStar4: 3.814697265625e-05,
            amuletTwoUp: 0.5,
            playMovie: 0.8994979858398438,
        },
    },
    rarity_5_guarantee: {
        amulet: { totalCount: 5 },
        threshold: {
            amulets: [0, 0, 0, 0, 0, 0],
            ballStar4: 0,
            amuletTwoUp: 0,
            playMovie: 0,
            isRarity5: true,
        },
    },
};

// ============================================================================
// Gacha Physics Simulator
// ============================================================================

export class GachaSimulator {
    private config: GachaPhysicsConfig;
    private rng: MersenneTwister;

    // Ball state
    private ballX: number = 0;
    private ballY: number = 0;
    private ballVx: number = 0;
    private ballVy: number = 0;
    private ballRarity: number = 0;
    private ballProbability: number = 0;

    // Static elements
    private pins: PinData[] = [];
    private amulets: AmuletData[] = [];

    // State
    private playProbability: number = 0;
    public moviePlayable: boolean = false;
    private finished: boolean = false;
    private pendingFinish: number = -1;
    private frameCount: number = 0;
    private accumulatedRarity: number = 0;

    constructor(seed: number, config?: Partial<GachaPhysicsConfig>) {
        const base = CN_GACHA_PHYSICS_CONFIG as any;
        const merged: any = { ...base, seed };
        if (config) {
            for (const key of Object.keys(config)) {
                if (key === 'seed') continue;
                const override = (config as any)[key];
                // Deep-merge nested objects (amulet, barAmulet, threshold) instead of replacing
                if (typeof override === 'object' && override !== null && !Array.isArray(override)) {
                    merged[key] = { ...base[key], ...override };
                } else {
                    merged[key] = override;
                }
            }
        }
        this.config = merged as GachaPhysicsConfig;
        this.rng = new MersenneTwister(seed);
    }

    /**
     * Initialize the field: create ball, pins, amulets, wall. Consumes RNG in the
     * exact order as FallingField.initField().
     */
    private initField(): void {
        const cfg = this.config;
        const c = cfg.field;
        const cb = cfg.ball;
        const cp = cfg.pin;
        const ca = cfg.amulet;
        const cba = cfg.barAmulet;

        // --- Ball creation (consumes 4 RNG calls) ---
        // FallingField.createBall() lines 392-401
        this.ballX = this.rng.randomRangeFloat(cb.initialXMin, cb.initialXMax);    // RNG #1
        this.ballY = cb.initialY;
        const angle = this.rng.randomRangeFloat(cb.ejectionAngleMin, cb.ejectionAngleMax) / 180 * Math.PI; // RNG #2
        this.ballVx = cb.ejectionVelocity * gachaCos(angle);
        this.ballVy = cb.ejectionVelocity * gachaSin(angle);
        this.ballProbability = this.rng.randomRangeFloat(0, 1);                    // RNG #3
        // Note: maxSpeed is recorded but not actively enforced in this simplified sim

        // --- Pin creation (chooseNumbers + createPin) ---
        // initPins() lines 283-299
        const pinTotalSlots = cp.countPerLine * cp.lineCount - 1;
        const pinCount = this.rng.randomRange(cp.totalCountMin, cp.totalCountMax);  // RNG #4 (randomRange)
        const chosenPinIds = chooseNumbers(this.rng, 0, pinTotalSlots, pinCount);   // N RNG calls per chosen pin

        this.pins = [];
        for (const id of chosenPinIds) {
            const col = id % cp.countPerLine;
            const row = Math.floor(id / cp.countPerLine);
            const rowOffset = row % 2 === 0 ? cp.evenLineOffsetRatio : cp.oddLineOffsetRatio;
            const baseX = (c.width - (cp.countPerLine - 1) * cp.distanceHorizontal) / 2
                + rowOffset * cp.distanceHorizontal;
            const px = baseX + col * cp.distanceHorizontal;
            const py = cp.firstLineY + row * cp.lineDistance;

            this.pins.push({
                id,
                x: px, y: py,
                radius: cp.radius,
                restitution: cp.verticalRestitution,
                contacted: false,
            });
        }

        // --- Circle Amulet creation ---
        // initAmulets() lines 340-369
        // FallingField: first create circle amulets, then bar amulets
        const amuletTotalSlots = ca.countPerLine * ca.lineCount - 1;
        const chosenAmuletIds = chooseNumbers(this.rng, 0, amuletTotalSlots, ca.totalCount);

        for (const id of chosenAmuletIds) {
            const col = id % ca.countPerLine;
            const row = Math.floor(id / ca.countPerLine);
            const rowOffset = row % 2 === 0 ? ca.evenLineOffsetRatio : ca.oddLineOffsetRatio;
            const baseX = (c.width - (ca.countPerLine - 1) * ca.distanceHorizontal) / 2
                + rowOffset * ca.distanceHorizontal;
            const ax = baseX + col * ca.distanceHorizontal;
            const ay = ca.firstLineY + row * ca.lineDistance;
            // createAmulet() — 2 RNG calls per amulet (line 414-415)
            const amuProbability = this.rng.randomRangeFloat(0, 1);        // RNG
            const amuTwoUpProb = this.rng.randomRangeFloat(0, 1);          // RNG

            this.amulets.push({
                placeId: AmuletPlaceId.Circle,
                probability: amuProbability,
                twoUpProbability: amuTwoUpProb,
                x: ax, y: ay,
                rarity: 1, // will be set in initAmuletRarity()
                contacted: false,
                forceContacted: false,
                sensor: true,
            });
        }

        // --- Bar Amulet creation ---
        // FallingField.createBarAmulet() lines 384-390
        const barSlotRange = cba.lineCount - 1;
        const chosenBarIds = chooseNumbers(this.rng, 0, barSlotRange, cba.totalCount);

        for (const id of chosenBarIds) {
            const bx = c.width / 2;
            const by = cba.firstLineY + id * cba.lineDistance;
            const barProb = this.rng.randomRangeFloat(0, 1);                // RNG

            this.amulets.push({
                placeId: AmuletPlaceId.Bar,
                probability: barProb,
                twoUpProbability: 0, // bar amulets don't have twoUp
                x: bx, y: by,
                rarity: 1, // will be set in initAmuletRarity()
                contacted: false,
                forceContacted: false,
                sensor: true,
            });
        }

        // --- Play probability (consumes 1 RNG call AFTER field setup) ---
        // FallingField.initField() line 311
        this.playProbability = this.rng.randomRangeFloat(0, 1);

        // --- Initialize ball and amulet rarities ---
        // FixedFallingField constructor lines 33-35
        this.initBallRarity();
        this.initAmuletRarity();

        // Determine if movie should play
        const threshold = this.config.threshold;
        this.moviePlayable = this.playProbability >= threshold.playMovie;

        // FixedFallingField constructor lines 37-39: ★5 guarantee override
        if (threshold.isRarity5) {
            this.ballRarity = 2; // force ★5
            this.moviePlayable = false; // skip animation
        }

        this.frameCount = 0;
        this.finished = false;
        this.pendingFinish = -1;
    }

    /**
     * FixedFallingField.initBallRarity() line 126
     * ball.rarity = ballProbability > threshold.ballStar4 ? 1 : 0
     */
    private initBallRarity(): void {
        this.ballRarity = this.ballProbability > this.config.threshold.ballStar4 ? 1 : 0;
    }

    /**
     * FixedFallingField.initAmuletRarity() lines 129-180
     *
     * Determines each amulet's upgrade value based on:
     *   - TwoUpProbability > threshold.amuletTwoUp → +2 (★ upgrade by 2)
     *   - probability > threshold.amulets[i] → active
     *   - limitTotalCount / decideTwoUpWhenAppear flags
     */
    private initAmuletRarity(): void {
        const cfg = this.config;
        const threshold = cfg.threshold;
        let totalAdded = 0;

        for (let i = 0; i < this.amulets.length; i++) {
            const amu = this.amulets[i];
            let rarity = 0;

            switch (amu.placeId) {
                case AmuletPlaceId.Circle: {
                    // Circle amulet: can give +1 or +2
                    const twoUp = amu.twoUpProbability > threshold.amuletTwoUp ? 2 : 1;

                    // AS3: Number(undefined)=NaN → probability>NaN=false
                    //      Number(null)=0 → probability>0 ~always true
                    const tV = threshold.amulets[i];
                    if (tV !== undefined && amu.probability > (tV as number)) {
                        if (cfg.amulet.limitTotalCount) {
                            if (cfg.amulet.decideTwoUpWhenAppear) {
                                // Cap by remaining slots
                                const remaining = Math.max(0, 2 - this.ballRarity - totalAdded);
                                const maxRarity = Math.min(remaining, twoUp);
                                rarity = Math.floor(maxRarity + 1e-10);
                            } else {
                                // First N amulets get rarity, rest get 0
                                rarity = i < 2 - this.ballRarity ? twoUp : 0;
                            }
                        } else {
                            rarity = twoUp;
                        }
                    }
                    break;
                }
                case AmuletPlaceId.Bar: {
                    // Bar amulet: only +1, only if ball is still ★3
                    // AS3: Number(undefined)=NaN → probability>NaN=false
                    const tV = threshold.amulets[i];
                    rarity = this.ballRarity === 0
                        ? (tV !== undefined && amu.probability > (tV as number) ? 1 : 0)
                        : 0;
                    break;
                }
            }

            amu.rarity = rarity;
            totalAdded += rarity;
        }
    }

    /**
     * Main update loop — one physics frame.
     *
     * FallingField.update() via World.step():
     *   1. Amulet contacts: pre-motion distance check (Phase A narrowPhase.detect)
     *   2. Gravity + integrate: Box2D semi-implicit Euler
     *   3. Pin contacts: sensor distance check (no bounce)
     *   4. Wall collision + exit detection
     *
     * Pre-motion amulet check matches client Phase A (before ball moves).
     * Amulets with sensor=true have disabled=true → solver skips,
     * but onBeginBodyContact still fires via isBodyContactCreated().
     */
    step(): void {
        if (this.finished) return;

        const cfg = this.config;
        const c = cfg.field;
        const cb = cfg.ball;

        // ---- Phase 1: Amulet contact detection at pre-motion position ----
        // Matches client World.step() Phase A: broadPhase + narrowPhase.detect()
        // checks circle overlap at the CURRENT (pre-integration) position.
        const contactDist = cb.radius + cfg.amulet.radius;
        const contactDistSq = contactDist * contactDist;
        for (const amu of this.amulets) {
            if (amu.contacted || amu.forceContacted) continue;
            const dx = this.ballX - amu.x;
            const dy = this.ballY - amu.y;
            if (amu.placeId === AmuletPlaceId.Bar) {
                if (Math.abs(dy) < contactDist) {
                    amu.contacted = true;
                    this.handleAmuletContact(amu);
                }
            } else {
                if (dx * dx + dy * dy < contactDistSq) {
                    amu.contacted = true;
                    this.handleAmuletContact(amu);
                }
            }
        }

        // ---- Phase 2: Gravity + Integrate (Box2D semi-implicit Euler) ----
        this.ballVx += c.gravityX;
        this.ballVy += c.gravityY;

        this.ballX += this.ballVx;
        this.ballY += this.ballVy;

        this.frameCount++;

        // ---- Phase 3: Pin contact detection (sensor → no bounce) ----
        for (const pin of this.pins) {
            if (pin.contacted) continue;
            const dx = this.ballX - pin.x;
            const dy = this.ballY - pin.y;
            const minDist = cb.radius + pin.radius;
            if (dx * dx + dy * dy < minDist * minDist) {
                pin.contacted = true;
            }
        }

        // ---- Phase 4: Wall collision ----
        const wr = c.wallRestitution;
        if (this.ballX - cb.radius < 0) {
            this.ballX = cb.radius;
            this.ballVx = -this.ballVx * wr;
        }
        if (this.ballX + cb.radius > c.width) {
            this.ballX = c.width - cb.radius;
            this.ballVx = -this.ballVx * wr;
        }

        // ---- Phase 5: Exit detection ----
        if (this.ballY > c.height + cb.radius) {
            if (this.pendingFinish < 0) {
                this.pendingFinish = 5;
            } else {
                this.pendingFinish -= 1;
                if (this.pendingFinish === 0) {
                    this.finished = true;
                }
            }
        }
    }

    /**
     * FixedFallingField.performAmuletContacted() lines 74-92
     *
     * When ball contacts an amulet:
     * 1. Add amulet's rarity to ball's rarity (capped at 2 = ★5)
     * 2. If ball just upgraded to ★5, trigger all remaining contacts
     */
    private handleAmuletContact(amu: AmuletData): void {
        if (amu.rarity === 0) return;

        const prevRarity = this.ballRarity;
        this.ballRarity += amu.rarity;
        if (this.ballRarity > 2) {
            this.ballRarity = 2;
        }

        // Rising to ★5 triggers all remaining amulet and pin contacts
        // FixedFallingField.performAllAmuletAndPinContacted() lines 94-122
        if (prevRarity < 2 && this.ballRarity === 2) {
            this.forceAllAmuletContacts();
            this.forceAllPinContacts();
        }
    }

    /** Force-contact all uncontacted amulets (after ★5 upgrade) */
    private forceAllAmuletContacts(): void {
        for (const amu of this.amulets) {
            if (!amu.contacted && !amu.forceContacted) {
                amu.forceContacted = true;
                this.handleAmuletContact(amu);
            }
        }
    }

    /** Mark all uncontacted pins as contacted */
    private forceAllPinContacts(): void {
        for (const pin of this.pins) {
            pin.contacted = true;
        }
    }

    /**
     * Run the full simulation and return the final ball rarity.
     *
     * Matches BallMovie.precalculateFieldResult():
     *   1. Create field
     *   2. Run update() loop until finished
     *   3. Return ball.rarity
     *
     * @returns 0=★3, 1=★4, 2=★5
     */
    simulate(): number {
        this.initField();

        if (!this.moviePlayable) {
            // Client: precalculateFieldResult() skips update() when !moviePlayable.
            // Ball rarity stays at initBallRarity only (no amulet contacts happen).
            return this.ballRarity;
        }

        // Max iterations safety
        const MAX_FRAMES = 10000;

        while (!this.finished && this.frameCount < MAX_FRAMES) {
            this.step();
        }

        return this.ballRarity;
    }

    /**
     * Get play probability without running the physics step loop.
     * Runs initField() (RNG only), then returns playProbability.
     * Used to pre-filter seeds that will trigger the movie animation.
     * playProbability >= playMovie(0.8995) → movie plays.
     */
    getPlayProbability(): number {
        this.initField();
        return this.playProbability;
    }
}

// ============================================================================
// Helper: chooseNumbers — pick N unique random integers from range
// FallingField.chooseNumbers() lines 419-432
// ============================================================================

function chooseNumbers(rng: MersenneTwister, min: number, max: number, count: number): number[] {
    const result: number[] = [];
    while (result.length < count) {
        const n = rng.randomRange(min, max);
        if (result.indexOf(n) < 0) {
            result.push(n);
        }
    }
    return result;
}

// ============================================================================
// Seed generation utility
// ============================================================================

export interface SeedGenerationResult {
    rarity: number;       // 0=★3, 1=★4, 2=★5
    seed: number;
}

/**
 * Generate seed pools for all rarity tiers by brute-forcing seed values.
 *
 * @param config Optional config override (defaults to CN normal config)
 * @param seedMin Minimum seed to test (default: 10,000,000)
 * @param seedMax Maximum seed to test (default: 10,100,000)
 */
export function generateSeedPools(
    config?: Partial<GachaPhysicsConfig>,
    seedMin: number = 10_000_000,
    seedMax: number = 10_100_000,
    requirePlayable: boolean = false,
): Record<number, number[]> {
    const pools: Record<number, number[]> = { 0: [], 1: [], 2: [] };

    for (let seed = seedMin; seed <= seedMax; seed++) {
        const sim = new GachaSimulator(seed, config);
        const rarity = sim.simulate();

        if (requirePlayable && !sim.moviePlayable) continue;

        if (!pools[rarity]) pools[rarity] = [];
        pools[rarity].push(seed);
    }

    return pools;
}
