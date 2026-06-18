import Fastify, { FastifyRequest } from "fastify";
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser";
import { pack, unpack } from "msgpackr";
import fastifyStatic from "@fastify/static";
import path from "path";
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
import multiBattleQuestApiPlugin from "./routes/api/multiBattleQuest";
import attentionApiPlugin from "./routes/api/attention";
import characterApiPlugin from "./routes/api/character";
import partyGroupApiPlugin from "./routes/api/partyGroup";
import equipmentApiPlugin from "./routes/api/equipment";
import exBoostApiPlugin from "./routes/api/exBoost";
import boxGachaApiPlugin from "./routes/api/boxGacha";
import shopApiPlugin from "./routes/api/shop";
import encyclopediaApiPlugin from "./routes/api/encyclopedia";
import mailApiPlugin from "./routes/api/mail";
import rankingEventApiPlugin from "./routes/api/rankingEvent";
import missionApiPlugin from "./routes/api/mission";
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
import { startSessionServer } from "./data/sessionServer";

const fastify = Fastify({
    logger: {
        level: "info"
    }
});

// Restore saved time offset from active player on startup
restoreTimeOffset();

fastify.addHook("onSend", (_, reply, payload, done) => {
    try {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            const packed = pack(payload);
            // Replace uint32 (0xCE) with int32 (0xD2) to test CN client compatibility
            // uint32(ce) → int32(d2) data bytes are identical (4-byte big-endian)
            for (let i = 0; i < packed.length; i++) {
                if (packed[i] === 0xCE) packed[i] = 0xD2;
            }
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
    const { CDN_TOTAL_SIZE } = require("./routes/cn/asset");
    stubMsgpackReply(reply, {
        base_url: `${CDN_BASE_URL}/EntityLists/`,
        files_list: `${CDN_BASE_URL}/EntityLists/10939-android_medium.csv`,
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
    const starDigits = [...loc.matchAll(/â(\d)/g)];
    // first match = ball rarity (結果レア度), second = char rarity (キャラクターレア度)
    const ballRarity = starDigits.length > 0 ? parseInt(starDigits[0][1], 10) : 3;
    // Extract play= field (0=no animation, 1=played) — APK 04e patch v2
    const playMatch = loc.match(/play=(\d)/);
    const didPlay = playMatch ? playMatch[1] === '1' : null;
    const r = ballRarity - 3; // 0=★3, 1=★4, 2=★5
    // purify only if play=1 (both rarity correct + confirmed playable)
    // otherwise → confirmed (rarity known correct, but not playable or play unknown)
    seedValidator.purify(movieId, badSeed, r, didPlay === true);
    const playStr = didPlay === true ? ' play=1' : didPlay === false ? ' play=0' : '';
    console.log(`[BEACON] C3032 → ${didPlay === true ? 'purified' : 'confirmed'} seed ${badSeed} ★${ballRarity}${playStr} [${movieId}]`);
}

// PLAY beacon — every draw reports play=1|0 (APK 04e Patch 5)
// Format: PLAY|play=1|seed=10000001, movie_id=fes
function parsePlayBeacon(loc: string): void {
    if (!loc.startsWith("PLAY|")) return;
    const seedMatch = loc.match(/seed=(\d+)/);
    if (!seedMatch) return;
    const seed = parseInt(seedMatch[1], 10);
    const movieMatch = loc.match(/movie_id=(\w+)/);
    const movieId = movieMatch ? movieMatch[1] : "normal";
    const playMatch = loc.match(/play=(\d)/);
    const didPlay = playMatch ? playMatch[1] === '1' : false;
    if (didPlay) seedValidator.confirmPlay(movieId, seed);
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
            // Crash path: no play= info → confirm only (rarity correct, play unknown)
            if (r >= 0 && r <= 2) seedValidator.purify(movieId, badSeed, r, false);
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
fastify.register(multiBattleQuestApiPlugin, { prefix: `${apiPrefix}/multi_battle_quest` });
fastify.register(attentionApiPlugin, { prefix: `${apiPrefix}/attention` });
fastify.register(characterApiPlugin, { prefix: `${apiPrefix}/character` });
fastify.register(partyGroupApiPlugin, { prefix: `${apiPrefix}/party_group` });
fastify.register(equipmentApiPlugin, { prefix: `${apiPrefix}/equipment` });
fastify.register(exBoostApiPlugin, { prefix: `${apiPrefix}/ex_boost` });
fastify.register(boxGachaApiPlugin, { prefix: `${apiPrefix}/box_gacha` });
fastify.register(shopApiPlugin, { prefix: `${apiPrefix}/shop` });
fastify.register(encyclopediaApiPlugin, { prefix: `${apiPrefix}/encyclopedia` });
fastify.register(mailApiPlugin, { prefix: `${apiPrefix}/mail` });
fastify.register(rankingEventApiPlugin, { prefix: `${apiPrefix}/ranking_event` });
fastify.register(missionApiPlugin, { prefix: `${apiPrefix}/mission` });
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

// Catch-all to log unknown endpoints
fastify.setNotFoundHandler((request, reply) => {
    console.log(`[UNKNOWN] ${request.method} ${request.url}`);
    reply.status(404).send({ error: "Not Found" });
});

const host = process.env.CN_LISTEN_HOST ?? "localhost";
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
