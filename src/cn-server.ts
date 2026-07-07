import Fastify, { FastifyRequest } from "fastify";
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser";
import { pack, unpack } from "msgpackr";
import fastifyStatic from "@fastify/static";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { getServerTime, getServerTimeForPlayer } from "./utils";
import { restoreTimeOffset } from "./data/activeAccount";

import versionCheckPlugin from "./routes/cn/versionCheck";
import leitingAuthPlugin from "./routes/cn/leitingAuth";
import cnToolPlugin from "./routes/cn/tool";
import cnLoadPlugin from "./routes/cn/load";
import cnAssetPlugin from "./routes/cn/asset";
import indexWebPlugin from "./routes/web";
import indexWebApiPlugin from "./routes/web_api";
import seedsWebApiPlugin from "./routes/web_api/seeds";
import seedValidator from "./lib/seed-validator";
import reproduceApiPlugin from "./routes/api/reproduce";
import tutorialApiPlugin from "./routes/api/tutorial";
import gachaApiPlugin from "./routes/api/gacha";
import partyApiPlugin from "./routes/api/party";
import expodApiPlugin from "./routes/api/expod";
import storyQuestApiPlugin from "./routes/api/storyQuest";
import optionApiPlugin from "./routes/api/option";
import singleBattleQuestApiPlugin from "./routes/api/singleBattleQuest";
import { multiBattleRoutes } from "./multi";
import attentionApiPlugin from "./routes/api/attention";
import characterApiPlugin from "./routes/api/character";
import characterManaPlugin from "./routes/api/character/mana";
import characterBondPlugin from "./routes/api/character/bond";
import partyGroupApiPlugin from "./routes/api/partyGroup";
import equipmentApiPlugin from "./routes/api/equipment";
import sellApiPlugin from "./routes/api/sell";
import exBoostApiPlugin from "./routes/api/exBoost";
import boxGachaApiPlugin from "./routes/api/boxGacha";
import shopApiPlugin from "./routes/api/shop";
import exchangeApiPlugin from "./routes/api/exchange";
import encyclopediaApiPlugin from "./routes/api/encyclopedia";
import mailApiPlugin from "./routes/api/mail";
import rankingEventApiPlugin from "./routes/api/rankingEvent";
import missionApiPlugin from "./routes/api/mission";
import activeMissionApiPlugin from "./routes/api/activeMission";
import paymentApiPlugin from "./routes/api/payment";
import newsApiPlugin from "./routes/api/news";
import raidEventApiPlugin from "./routes/api/raidEvent";
import rushEventApiPlugin from "./routes/api/rushEvent";
import carnivalEventApiPlugin from "./routes/api/carnivalEvent";
import contentsGuideApiPlugin from "./routes/api/contentsGuide";
import profileApiPlugin from "./routes/api/profile";
import historyApiPlugin from "./routes/api/history";
import comicApiPlugin from "./routes/api/comic";
import questUnlockApiPlugin from "./routes/api/questUnlock";
import itemApiPlugin from "./routes/api/item";
import { startSessionServer } from "./multi";

const fastify = Fastify({
    logger: {
        level: "info"
    },
    bodyLimit: 262144  // 256KB — covers /single_battle_quest/finish large battle stats
});

// Restore saved time offset from active player on startup
restoreTimeOffset();

// Simple in-memory rate limiter for /crash endpoint only.
// /debug is excluded — game client sends heavy beacon traffic during normal startup.
const rateLimitMap = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60000;
fastify.addHook("onRequest", async (request, reply) => {
    if (request.url === "/crash") {
        const ip = (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
            || request.ip;
        const now = Date.now();
        const entry = rateLimitMap.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW };
        if (now > entry.reset) { entry.count = 0; entry.reset = now + RATE_LIMIT_WINDOW; }
        if (++entry.count > RATE_LIMIT_MAX) {
            return reply.status(429).send("Too Many Requests");
        }
        rateLimitMap.set(ip, entry);
    }
});

/**
 * Walk a MsgPack buffer in a single pass. Replaces uint32 tags (0xCE) with
 * int32 (0xD2) for values < 2^31, and with float64 (0xCB) for values ≥ 2^31.
 * All other bytes are copied verbatim.  Handles nested arrays/maps recursively.
 * Returns a new Buffer (may be larger than input when float64 replaces int32).
 */
function fixUint32Tags(buf: Buffer): Buffer {
    const out = Buffer.allocUnsafe(buf.length * 2); // worst-case: all 0xCE → 0xCB (+80%)
    let w = 0; // write position

    const put = (b: number) => { out[w++] = b; };

    const copy = (off: number, len: number) => {
        for (let i = 0; i < len; i++) out[w++] = buf[off + i]!;
    };

    function walk(off: number): number {
        const tag = buf[off]!;
        let pos = off + 1;

        // positive fixint  0x00..0x7f
        if (tag <= 0x7f) { put(tag); return pos; }
        // negative fixint  0xe0..0xff
        if (tag >= 0xe0) { put(tag); return pos; }

        switch (tag) {
            case 0xc0: case 0xc2: case 0xc3: // nil / false / true
                put(tag);
                return pos;
            case 0xcc: case 0xd0: // uint8 / int8
                copy(off, 2);
                return pos + 1;
            case 0xcd: case 0xd1: // uint16 / int16
                copy(off, 3);
                return pos + 2;
            case 0xce: {            // uint32 → int32 (< 2^31) or float64 (≥ 2^31)
                const u32 = buf.readUint32BE(pos);
                if (u32 < 0x80000000) {
                    put(0xd2);     // int32 tag
                    copy(pos, 4);  // data bytes unchanged
                } else {
                    put(0xcb);     // float64 tag
                    const f64 = Buffer.allocUnsafe(8);
                    f64.writeDoubleBE(u32);
                    for (let j = 0; j < 8; j++) put(f64[j]!);
                }
                return pos + 4;
            }
            case 0xd2: // int32
                copy(off, 5);
                return pos + 4;
            case 0xcf: case 0xd3: // uint64 / int64
                copy(off, 9);
                return pos + 8;
            case 0xca: // float32
                copy(off, 5);
                return pos + 4;
            case 0xcb: // float64
                copy(off, 9);
                return pos + 8;
            case 0xd9: { // str8
                const len = buf[pos]!;
                copy(off, 2 + len);
                return pos + 1 + len;
            }
            case 0xda: { // str16
                const len = buf.readUint16BE(pos);
                copy(off, 3 + len);
                return pos + 2 + len;
            }
            case 0xdb: { // str32
                const len = buf.readUint32BE(pos);
                copy(off, 5 + len);
                return pos + 4 + len;
            }
            case 0xc4: { // bin8
                const len = buf[pos]!;
                copy(off, 2 + len);
                return pos + 1 + len;
            }
            case 0xc5: { // bin16
                const len = buf.readUint16BE(pos);
                copy(off, 3 + len);
                return pos + 2 + len;
            }
            case 0xc6: { // bin32
                const len = buf.readUint32BE(pos);
                copy(off, 5 + len);
                return pos + 4 + len;
            }
            case 0xdc: { // array16
                const count = buf.readUint16BE(pos);
                put(tag);
                put(buf[off + 1]!); put(buf[off + 2]!); // count bytes
                pos += 2;
                for (let i = 0; i < count; i++) pos = walk(pos);
                return pos;
            }
            case 0xdd: { // array32
                const count = buf.readUint32BE(pos);
                put(tag);
                copy(off + 1, 4); // count bytes
                pos += 4;
                for (let i = 0; i < count; i++) pos = walk(pos);
                return pos;
            }
            case 0xde: { // map16
                const count = buf.readUint16BE(pos);
                put(tag);
                put(buf[off + 1]!); put(buf[off + 2]!); // count bytes
                pos += 2;
                for (let i = 0; i < count; i++) { pos = walk(pos); pos = walk(pos); }
                return pos;
            }
            case 0xdf: { // map32
                const count = buf.readUint32BE(pos);
                put(tag);
                copy(off + 1, 4); // count bytes
                pos += 4;
                for (let i = 0; i < count; i++) { pos = walk(pos); pos = walk(pos); }
                return pos;
            }
            // ext family (copy verbatim)
            case 0xc7: { // ext8
                const len = buf[pos]!;
                copy(off, 2 + len + 1);
                return pos + 1 + len + 1;
            }
            case 0xc8: { // ext16
                const len = buf.readUint16BE(pos);
                copy(off, 3 + len + 1);
                return pos + 2 + len + 1;
            }
            case 0xc9: { // ext32
                const len = buf.readUint32BE(pos);
                copy(off, 5 + len + 1);
                return pos + 4 + len + 1;
            }
            case 0xd4: copy(off, 2);  return pos + 1;   // fixext1
            case 0xd5: copy(off, 3);  return pos + 2;   // fixext2
            case 0xd6: copy(off, 5);  return pos + 4;   // fixext4
            case 0xd7: copy(off, 9);  return pos + 8;   // fixext8
            case 0xd8: copy(off, 17); return pos + 16;  // fixext16
            default: {
                // fixstr   0xa0..0xbf
                if (tag >= 0xa0 && tag <= 0xbf) {
                    const len = tag & 0x1f;
                    copy(off, 1 + len);
                    return pos + len;
                }
                // fixarray 0x90..0x9f
                if (tag >= 0x90 && tag <= 0x9f) {
                    put(tag);
                    const count = tag & 0x0f;
                    for (let i = 0; i < count; i++) pos = walk(pos);
                    return pos;
                }
                // fixmap   0x80..0x8f
                if (tag >= 0x80 && tag <= 0x8f) {
                    put(tag);
                    const count = tag & 0x0f;
                    for (let i = 0; i < count; i++) { pos = walk(pos); pos = walk(pos); }
                    return pos;
                }
                put(tag); // unknown, copy defensively
                return pos;
            }
        }
    }

    let i = 0;
    while (i < buf.length) i = walk(i);
    return out.subarray(0, w);
}

fastify.addHook("onSend", (_, reply, payload, done) => {
    try {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            const packed = fixUint32Tags(pack(payload));
            done(null, packed.toString("base64"));
            return;
        }
    } catch {}
    done(null, payload);
});

function jsonParser(_: FastifyRequest, body: string, done: ContentTypeParserDoneFunction) {
    try {
        done(null, JSON.parse(body));
    } catch {
        done(null, undefined);
    }
}

fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" },
    (_request: FastifyRequest, body: string, done) => {
        try {
            done(null, unpack(Buffer.from(body, "base64")));
        } catch {
            try {
                done(null, Object.fromEntries(new URLSearchParams(body)));
            } catch {
                jsonParser(_request, body, done);
            }
        }
    }
);
fastify.addContentTypeParser("application/json", { parseAs: "string" }, jsonParser);

fastify.register(versionCheckPlugin);
fastify.register(leitingAuthPlugin, { prefix: "/api/index.php" });

const apiPrefix = "/api/index.php";
fastify.register(cnLoadPlugin, { prefix: apiPrefix });
fastify.register(cnAssetPlugin, { prefix: `${apiPrefix}/asset` });

function stubMsgpackReply(reply: any, data: any, playerId?: number) {
    const servertime = playerId ? getServerTimeForPlayer(playerId) : getServerTime()
    reply.header("content-type", "application/x-msgpack");
    reply.status(200).send({
        data_headers: { force_update: false, asset_update: false, short_udid: 0, viewer_id: 0, servertime, result_code: 1 },
        data
    });
}

fastify.post(`${apiPrefix}/assetintitle/version_info_in_title`, async (_request, reply) => {
    const { CDN_TOTAL_SIZE, ENTITY_LISTS_DIR } = require("./routes/cn/asset");
    stubMsgpackReply(reply, {
        base_url: `${CDN_BASE_URL}/${ENTITY_LISTS_DIR}/`,
        files_list: `${CDN_BASE_URL}/${ENTITY_LISTS_DIR}/10939-android_medium.csv`,
        total_size: CDN_TOTAL_SIZE,
        delayed_assets_size: 0
    });
});

fastify.post(`${apiPrefix}/tool/check_social_link_enable`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable: false });
});

// Gift code exchange (礼包码兑换): enable button in menu, exchange not implemented
fastify.post(`${apiPrefix}/tool/check_enable_gift`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable_gift: true });
});

fastify.post(`${apiPrefix}/tool/contact_active`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable_customer_service: false });
});

fastify.post(`${apiPrefix}/tool/custom_notify`, async (_request, reply) => {
    stubMsgpackReply(reply, {});
});

fastify.post(`${apiPrefix}/channels/channel_leiting_pay/query_unfinish_order`, async (_request, reply) => {
    stubMsgpackReply(reply, { order_id: "" });
});

fastify.post(`${apiPrefix}/channels/channel_leiting_pay/query_purcharge`, async (_request, reply) => {
    stubMsgpackReply(reply, { status: 3 });  // 3 = purchase success
});

fastify.post(`${apiPrefix}/channels/channel_leiting_pay/set_unfinish_order_status`, async (_request, reply) => {
    stubMsgpackReply(reply, {});
});

// PassCard (修行之道): get current pass card data
fastify.post(`${apiPrefix}/Pass_card/get_pass_card`, async (_request, reply) => {
    stubMsgpackReply(reply, { point: 0, is_buy: false, all_received_record: [] });
});

// PassCard: claim all available rewards
fastify.post(`${apiPrefix}/Pass_card/receive_all`, async (_request, reply) => {
    stubMsgpackReply(reply, { all_received_record: [] });
});

// Episode trial reading: finish stub (character story trial)
fastify.post(`${apiPrefix}/episode_trial_reading/finish`, async (_request, reply) => {
    stubMsgpackReply(reply, {});
});

fastify.get("/debug", async (request, reply) => {
    const ts = new Date().toISOString();
    const loc = (request.query as any)?.loc || "unknown";
    // Parse C3032 from beacon query string (04e patch sends via CrashUtil.debugBeacon)
    try { parseC3032Beacon(loc); } catch (_) {}
    try { parsePlayBeacon(loc); } catch (_) {}
    reply.status(200).send("OK");
});

// Parse C3032 from beacon loc string — ★ garbled to â, extract digits via garbled pattern
function parseC3032Beacon(loc: string): void {
    if (!loc.includes("C3032")) return;
    const seedMatch = loc.match(/seed=(\d+)/);
    if (!seedMatch) return;
    const badSeed = parseInt(seedMatch[1], 10);
    const movieMatch = loc.match(/movie_id=(\w+)/);
    const movieId = movieMatch ? movieMatch[1] : "normal";
    console.log(`[DBG-BCN] C3032 seed=${badSeed} movieId=${movieId}`);
    const starDigits = [...loc.matchAll(/â(\d)/g)];
    // first match = ball rarity (結果レア度), second = char rarity (キャラクターレア度)
    const ballRarity = starDigits.length > 0 ? parseInt(starDigits[0][1], 10) : 3;
    // Extract play= field (0=no animation, 1=played) — APK 04e patch v2
    const playMatch = loc.match(/play=(\d)/);
    const didPlay = playMatch ? playMatch[1] === '1' : null;
    const r = ballRarity - 3; // 0=★3, 1=★4, 2=★5
    if (didPlay !== null) seedValidator.recordPlay(movieId, badSeed, didPlay);  // record for flushAll
    // C3032 = client-verified rarity → verifiedPool (superset of playPool/confirmPool)
    console.log(`[DBG-BCN] C3032 → moveToVerified [${movieId}] seed=${badSeed} ★${ballRarity}`);
    seedValidator.moveToVerified(movieId, badSeed, r);
    if (didPlay === false) {
        console.log(`[DBG-BCN] C3032 → confirm [${movieId}] seed=${badSeed} ★${ballRarity}`);
        seedValidator.confirm(movieId, badSeed, r);  // play=0 → confirmPool
    }
    const playStr = didPlay === true ? ' play=1' : didPlay === false ? ' play=0' : '';
    console.log(`[BEACON] C3032 → ${didPlay === true ? 'play' : 'confirm'} seed ${badSeed} ★${ballRarity}${playStr} [${movieId}]`);
    if (didPlay === null) { seedValidator.addPending(movieId, badSeed, r); }
}

// PLAY beacon — every draw reports play=1|0 (APK 04e Patch 5)
// Format: PLAY|play=1|seed=10000001, movie_id=fes
function parsePlayBeacon(loc: string): void {
    if (loc.startsWith("PLAY|")) {
        const seedMatch = loc.match(/seed=(\d+)/);
        if (!seedMatch) { console.log(`[PLAY] no seed in: ${loc.substring(0,80)}`); return; }
        const seed = parseInt(seedMatch[1], 10);
        const movieMatch = loc.match(/movie_id=(\w+)/);
        const movieId = movieMatch ? movieMatch[1] : "normal";
        const playMatch = loc.match(/play=(\d)/);
        const didPlay = playMatch ? playMatch[1] === '1' : false;
        console.log(`[DBG-BCN] PLAY seed=${seed} play=${didPlay?'1':'0'} movieId=${movieId}`);
        seedValidator.recordPlay(movieId, seed, didPlay);  // record for flushAll
        if (didPlay) {
            const r = seedValidator.getSentR(movieId, seed);
            if (r !== undefined && r !== null) {
                seedValidator.addPlay(movieId, seed, r, true);
                seedValidator.moveToVerified(movieId, seed, r);
                console.log(`[PLAY] playPool seed=${seed} movie=${movieId}`);
            } else {
                console.log(`[PLAY] play=1 skipped seed=${seed} getSentR=${r === null ? 'null' : 'undefined'} (already cleaned up by prior beacon)`);
            }
        } else {
            const r = seedValidator.getSentR(movieId, seed);
            console.log(`[DBG-BCN] PLAY play=0 → confirm [${movieId}] seed=${seed} r=${r !== undefined && r !== null ? '★'+(r+3) : r === null ? 'null' : 'undefined'}`);
            if (r !== undefined) seedValidator.confirm(movieId, seed, r);
        }
    }
}

fastify.post("/debug", async (request, reply) => {
    const ts = new Date().toISOString();
    const loc = (request.body as any)?.loc || "unknown";
    console.log(`[BEACON ${ts}] ${loc}`);

    // Parse C3032 beacons for auto-purification (04e patch skips throw but keeps beacon)
    try { parseC3032Beacon(loc); } catch (_) {}

    reply.status(200).send("OK");
});

fastify.post("/crash", async (request, reply) => {
    // Log crash (truncated to avoid log explosion)
    const bodyStr = JSON.stringify(request.body);
    console.log(`[CRASH] ${bodyStr.substring(0, 2000)}`);

    // Parse C3032 gacha seed mismatches and auto-block bad seeds
    try {
        const seedMatch = bodyStr.match(/seed=(\d+)/);
        if (seedMatch && bodyStr.includes("C3032")) {
            const badSeed = parseInt(seedMatch[1], 10);
            const ballMatch = bodyStr.match(/結果レア度=★(\d)/);
            const ballRarity = ballMatch ? parseInt(ballMatch[1], 10) : 0;
            const r = ballRarity - 3;
            const movieMatch = bodyStr.match(/movie_id=(\w+)/);
            const movieId = movieMatch ? movieMatch[1] : "normal";
            // Crash path: no play= info → pendingPlay (rarity known, play unknown)
            if (r >= 0 && r <= 2) seedValidator.addPending(movieId, badSeed, r);
            console.log(`[CRASH] seed ${badSeed} device★${ballRarity} movie=${movieId}`);
        }
    } catch (e) {}

    reply.status(200).send("OK");
});


fastify.register(cnToolPlugin, { prefix: `${apiPrefix}/tool` });
fastify.register(reproduceApiPlugin, { prefix: `${apiPrefix}/reproduce` });
fastify.register(tutorialApiPlugin, { prefix: `${apiPrefix}/tutorial` });
fastify.register(gachaApiPlugin, { prefix: `${apiPrefix}/gacha` });
fastify.register(partyApiPlugin, { prefix: `${apiPrefix}/party` });
fastify.register(expodApiPlugin, { prefix: `${apiPrefix}/expod` });
fastify.register(storyQuestApiPlugin, { prefix: `${apiPrefix}/story_quest` });
fastify.register(optionApiPlugin, { prefix: `${apiPrefix}/option` });
fastify.register(singleBattleQuestApiPlugin, { prefix: `${apiPrefix}/single_battle_quest` });
fastify.register(multiBattleRoutes, { prefix: `${apiPrefix}/multi_battle_quest` });
fastify.register(attentionApiPlugin, { prefix: `${apiPrefix}/attention` });
fastify.register(characterApiPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(characterManaPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(characterBondPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(partyGroupApiPlugin, { prefix: `${apiPrefix}/party_group` });
fastify.register(equipmentApiPlugin, { prefix: `${apiPrefix}/equipment` });
fastify.register(sellApiPlugin, { prefix: `${apiPrefix}/equipment` });
fastify.register(exBoostApiPlugin, { prefix: `${apiPrefix}/ex_boost` });
fastify.register(boxGachaApiPlugin, { prefix: `${apiPrefix}/box_gacha` });
fastify.register(shopApiPlugin, { prefix: `${apiPrefix}/shop` });
fastify.register(exchangeApiPlugin, { prefix: `${apiPrefix}/exchange` });
fastify.register(encyclopediaApiPlugin, { prefix: `${apiPrefix}/encyclopedia` });
fastify.register(mailApiPlugin, { prefix: `${apiPrefix}/mail` });
fastify.register(rankingEventApiPlugin, { prefix: `${apiPrefix}/ranking_event` });
fastify.register(missionApiPlugin, { prefix: `${apiPrefix}/mission` });
fastify.register(activeMissionApiPlugin, { prefix: `${apiPrefix}/active_mission` });
fastify.register(paymentApiPlugin, { prefix: `${apiPrefix}/payment` });
fastify.register(newsApiPlugin, { prefix: `${apiPrefix}/news` });
fastify.register(raidEventApiPlugin, { prefix: `${apiPrefix}/event/raid` });
fastify.register(rushEventApiPlugin, { prefix: `${apiPrefix}/event/rush` });
fastify.register(carnivalEventApiPlugin, { prefix: `${apiPrefix}/carnival_event` });
fastify.register(contentsGuideApiPlugin, { prefix: `${apiPrefix}/contents_guide` });
fastify.register(profileApiPlugin, { prefix: `${apiPrefix}/profile` });
fastify.register(historyApiPlugin, { prefix: `${apiPrefix}/history` });
fastify.register(comicApiPlugin, { prefix: `${apiPrefix}/comic` });
fastify.register(questUnlockApiPlugin, { prefix: `${apiPrefix}/quest` });
fastify.register(itemApiPlugin, { prefix: `${apiPrefix}/item` });

// Web management panel
fastify.register(indexWebPlugin);
fastify.register(indexWebApiPlugin, { prefix: "/api" });
fastify.register(seedsWebApiPlugin, { prefix: "/api/seeds" });

const cdnHost = process.env.CN_LISTEN_HOST || "localhost";
const cdnPort = process.env.CN_LISTEN_PORT || "8001";
const cdnDisplayHost = cdnHost === "0.0.0.0" ? "localhost" : cdnHost;
const CDN_BASE_URL = process.env.CDN_BASE_URL || `http://${cdnDisplayHost}:${cdnPort}/patch/cn`;
const cdnDir = process.env.CDN_DIR || ".cdn";
fastify.register(fastifyStatic, {
    root: path.isAbsolute(cdnDir) ? cdnDir : path.join(__dirname, "..", cdnDir),
    prefix: "/patch",
    decorateReply: false
});

// Web static assets
fastify.register(fastifyStatic, {
    root: path.join(__dirname, "..", "web", "public"),
    prefix: "/public",
    decorateReply: false
});

// New admin SPA (React, built from admin/ into web/dist) — served at /admin.
// Old pages at / stay untouched until the SPA fully replaces them (see docs/admin-refactor-plan.md).
const adminDistDir = path.join(__dirname, "..", "web", "dist");
const adminSpaAvailable = existsSync(path.join(adminDistDir, "index.html"));
if (adminSpaAvailable) {
    fastify.register(fastifyStatic, {
        root: adminDistDir,
        prefix: "/admin/",
        decorateReply: false
    });
    fastify.get("/admin", (_request, reply) => reply.redirect("/admin/"));
} else {
    console.log("[admin] web/dist not found — admin SPA disabled (run: npm run build:admin)");
}

// Catch-all to log unknown endpoints
fastify.setNotFoundHandler((request, reply) => {
    // SPA fallback: client-side routes like /admin/accounts resolve to index.html
    if (adminSpaAvailable && request.method === "GET" && request.url.startsWith("/admin/")) {
        reply.header("content-type", "text/html; charset=utf-8");
        reply.send(readFileSync(path.join(adminDistDir, "index.html")));
        return;
    }
    console.log(`[UNKNOWN] ${request.method} ${request.url}`);
    reply.status(404).send({ error: "Not Found" });
});

const host = process.env.CN_LISTEN_HOST ?? "127.0.0.1";
const port = parseInt(process.env.CN_LISTEN_PORT ?? "8001");

fastify.listen({ port, host }, (err, address) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`CN StarPoint listening on http://${host}:${port}`);

    // Start multi battle TCP session server
    startSessionServer();
});
