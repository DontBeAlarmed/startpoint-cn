import Fastify, { FastifyRequest } from "fastify";
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser";
import { unpack } from "msgpackr";
import path from "path";
import { getServerTime } from "./utils";
import getDatabase, {
    checkpointDatabase,
    closeDatabase,
    Database,
    getDatabaseStatus,
    initializeDatabase,
} from "./data";
import { restoreTimeOffset } from "./data/activeAccount";
import { getContentSnapshot, initializeContentSnapshot } from "./content/runtime/content-snapshot";
import { createContentLifecycleDependencies } from "./modes/cn-lifecycle";
import { configureSerializedAssetVersionProvider } from "./data/utils/serialized-asset-version";
import { parseCnRuntimeConfig } from "./runtime/config";
import {
    createRuntimeCoordinator,
    RuntimeCoordinator,
} from "./runtime/lifecycle";
import { registerRuntimeHealthRoute } from "./runtime/health";
import { loadBundleMetadata } from "./runtime/bundle-metadata";
import { registerAdminUi } from "./runtime/admin";

import versionCheckPlugin from "./routes/cn/versionCheck";
import leitingAuthPlugin from "./routes/cn/leitingAuth";
import cnToolPlugin from "./routes/cn/tool";
import cnLoadPlugin from "./routes/cn/load";
import { registerCnAssetProviderRoutes } from "./routes/cn/asset-provider";
import { registerCnMsgpackOnSend } from "./routes/cn/msgpack";
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
import passCardApiPlugin from "./routes/api/passCard";
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
import characterElectionApiPlugin from "./routes/api/characterElection";
import {
    isSessionServerListening,
    startSessionServer,
    stopSessionServer,
} from "./multi";

const fastify = Fastify({
    logger: {
        level: "info"
    },
    bodyLimit: 262144  // 256KB — covers /single_battle_quest/finish large battle stats
});
const projectRoot = path.resolve(__dirname, "..");
let runtimeCoordinator: RuntimeCoordinator;

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

registerCnMsgpackOnSend(fastify);
registerRuntimeHealthRoute(fastify, () => runtimeCoordinator.getHealthSnapshot());

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

function stubMsgpackReply(reply: any, data: any) {
    const servertime = getServerTime()
    reply.header("content-type", "application/x-msgpack");
    reply.status(200).send({
        data_headers: { force_update: false, asset_update: false, short_udid: 0, viewer_id: 0, servertime, result_code: 1 },
        data
    });
}

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
    // C3032 reports a client-verified rarity. Its final persistent state is verified.
    console.log(`[DBG-BCN] C3032 → moveToVerified [${movieId}] seed=${badSeed} ★${ballRarity}`);
    seedValidator.moveToVerified(movieId, badSeed, r);
    const playStr = didPlay === true ? ' play=1' : didPlay === false ? ' play=0' : '';
    console.log(`[BEACON] C3032 → verified seed ${badSeed} ★${ballRarity}${playStr} [${movieId}]`);
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
                seedValidator.confirmPlayedAndVerify(movieId, seed, r);
                console.log(`[PLAY] verified seed=${seed} movie=${movieId}`);
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
fastify.register(passCardApiPlugin, { prefix: `${apiPrefix}/Pass_card` });
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
fastify.register(characterElectionApiPlugin, { prefix: `${apiPrefix}/character_election` });

fastify.register(indexWebApiPlugin, { prefix: "/api" });
fastify.register(seedsWebApiPlugin, { prefix: "/api/seeds" });

registerAdminUi(fastify, { projectRoot });

let runtimeHttpConfigured = false;
function configureRuntimeHttp(config: ReturnType<typeof parseCnRuntimeConfig>): void {
    if (runtimeHttpConfigured) return;
    configureSerializedAssetVersionProvider(() => getContentSnapshot().cdn.targetVersion);
    fastify.register(cnLoadPlugin, {
        prefix: apiPrefix,
        assetProvider: config.assetProvider,
    });
    registerCnAssetProviderRoutes(fastify, { config: config.assetProvider });
    runtimeHttpConfigured = true;
}

function getRuntimeDatabaseHealth(): { ready: boolean; schema: number | null } {
    const status = getDatabaseStatus();
    if (!status.open || !status.ready || status.schema === null) {
        return { ready: false, schema: null };
    }
    try {
        const row = getDatabase(Database.WDFP_DATA)
            .prepare("SELECT 1 AS value")
            .get() as { value?: number } | undefined;
        return { ready: row?.value === 1, schema: status.schema };
    } catch {
        return { ready: false, schema: status.schema };
    }
}

let bundleMetadataError = false;
let bundleMetadata = { version: "unknown", bundleId: null as string | null };
try {
    bundleMetadata = loadBundleMetadata({
        bundleRoot: projectRoot,
        requireManifest: process.env.EMBEDDED_RUNTIME === "1",
    });
} catch {
    bundleMetadataError = true;
}
runtimeCoordinator = createRuntimeCoordinator({
    loadConfig: () => {
        if (bundleMetadataError) throw new Error("invalid embedded bundle metadata");
        return parseCnRuntimeConfig({ projectRoot });
    },
    configureHttp: configureRuntimeHttp,
    initializeDatabase,
    restoreTimeOffset,
    // Content snapshot, then operator-installed gameplay modules (modes.d/).
    // Composed by the seam so the lifecycle test drives this exact entry
    // point instead of re-creating the ordering.
    ...createContentLifecycleDependencies<ReturnType<typeof parseCnRuntimeConfig>>({
        projectRoot,
        initializeContentSnapshot: config => initializeContentSnapshot({
            assetMode: config.assetProvider.mode,
            localCdn: config.assetProvider.mode === "local",
        }),
    }),
    readyHttp: async () => { await fastify.ready(); },
    listenHttp: config => fastify.listen({ ...config.http }),
    closeHttp: () => fastify.close(),
    forceCloseHttp: () => {
        fastify.server.closeIdleConnections?.();
        fastify.server.closeAllConnections?.();
    },
    startTcp: (config, onFatalError) => startSessionServer({
        ...config.tcp,
        onFatalError,
    }),
    stopTcp: stopSessionServer,
    checkpointDatabase,
    closeDatabase,
    getDatabaseHealth: getRuntimeDatabaseHealth,
    isHttpListening: () => fastify.server.listening,
    isTcpListening: isSessionServerListening,
    processTarget: process,
    setExitCode: code => { process.exitCode = code; },
    bundleVersion: bundleMetadata.version,
    bundleId: bundleMetadata.bundleId,
    nodeVersion: process.version,
    adminAvailable: true,
    reportStartupFailure: stage => console.error(`[runtime] ${stage} startup failed`),
    reportShutdownFailures: failures => console.error(
        `[runtime] shutdown failed steps=${failures.map(failure => (
            `${failure.step}:${failure.code ?? "UNKNOWN"}`
        )).join(",")}`,
    ),
    reportShutdownComplete: () => console.log("[runtime] shutdown complete"),
});

void runtimeCoordinator.start();
