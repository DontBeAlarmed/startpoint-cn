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
import { ServerTimeService } from "./runtime/server-time/service";
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
import iosLeitingPlugin from "./routes/cn/ios-leiting";
import leitingAuthPlugin from "./routes/cn/leitingAuth";
import cnToolPlugin from "./routes/cn/tool";
import cnLoadPlugin from "./routes/cn/load";
import { registerCnAssetProviderRoutes } from "./routes/cn/asset-provider";
import { registerCnMsgpackOnSend } from "./routes/cn/msgpack";
import indexWebApiPlugin from "./routes/web_api";
import seedsWebApiPlugin from "./routes/web_api/seeds";
import { getDefaultGachaSeedQuarantine } from "./lib/gacha-seed-quarantine";
import reproduceApiPlugin from "./routes/api/reproduce";
import tutorialApiPlugin from "./routes/api/tutorial";
import gachaApiPlugin from "./routes/api/gacha";
import partyApiPlugin from "./routes/api/party";
import expodApiPlugin from "./routes/api/expod";
import storyQuestApiPlugin from "./routes/api/storyQuest";
import optionApiPlugin from "./routes/api/option";
import singleBattleQuestApiPlugin from "./routes/api/singleBattleQuest";
import { multiBattleRoutes } from "./multi";
import { createMultiRuntimeService } from "./multi/runtime/service";
import { MultiManagementService } from "./multi/management/service";
import { createMultiManagementCredentialProvider } from "./multi/management/credentials";
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
import howToGetApiPlugin from "./routes/api/howToGet";
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
import playerHistoryApiPlugin from "./routes/api/playerHistory";
import { followCompatibilityRoutes, snsCompatibilityRoutes } from "./routes/api/socialCompatibility";
import historyApiPlugin from "./routes/api/history";
import comicApiPlugin from "./routes/api/comic";
import questUnlockApiPlugin from "./routes/api/questUnlock";
import itemApiPlugin from "./routes/api/item";
import characterElectionApiPlugin from "./routes/api/characterElection";
const fastify = Fastify({
    logger: {
        level: "info"
    },
    bodyLimit: 262144  // 256KB — covers /single_battle_quest/finish large battle stats
});
const projectRoot = path.resolve(__dirname, "..");
let runtimeCoordinator: RuntimeCoordinator;
const multiRuntimeService = createMultiRuntimeService();
let startupRuntimeConfig: ReturnType<typeof parseCnRuntimeConfig> | null = null;
let multiManagementService: MultiManagementService | null = null;
const serverTimeService = new ServerTimeService();
const gachaSeedQuarantine = getDefaultGachaSeedQuarantine();

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

// Gift code exchange is not implemented, so do not advertise the client entry.
fastify.post(`${apiPrefix}/tool/check_enable_gift`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable_gift: false });
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
    const loc = (request.query as any)?.loc || "unknown";
    parseC3032Beacon(loc, "debug-get");
    reply.status(200).send("OK");
});

function parseC3032Beacon(loc: string, source: string): void {
    if (!loc.includes("C3032")) return;
    const seedMatch = loc.match(/seed=(\d+)/);
    const movieMatch = loc.match(/movie_id=(\w+)/);
    if (!seedMatch || !movieMatch) return;
    const badSeed = parseInt(seedMatch[1], 10);
    const movieId = movieMatch[1];
    try {
        const quarantined = gachaSeedQuarantine.quarantineIfRecentlySent(movieId, badSeed);
        console.log(
            `[GACHA-SEED] C3032 source=${source} movie=${movieId} seed=${badSeed} `
            + (quarantined ? "quarantined" : "ignored-not-recent"),
        );
    } catch (error) {
        console.error(`[GACHA-SEED] C3032 quarantine failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

fastify.post("/debug", async (request, reply) => {
    const ts = new Date().toISOString();
    const loc = (request.body as any)?.loc || "unknown";
    console.log(`[BEACON ${ts}] ${loc}`);

    parseC3032Beacon(loc, "debug-post");

    reply.status(200).send("OK");
});

fastify.post("/crash", async (request, reply) => {
    // Log crash (truncated to avoid log explosion)
    const bodyStr = JSON.stringify(request.body);
    console.log(`[CRASH] ${bodyStr.substring(0, 2000)}`);

    parseC3032Beacon(bodyStr, "crash");

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
fastify.register(howToGetApiPlugin, { prefix: `${apiPrefix}/how_to_get` });
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
fastify.register(playerHistoryApiPlugin, { prefix: `${apiPrefix}/player_history` });
fastify.register(followCompatibilityRoutes, { prefix: `${apiPrefix}/follow` });
fastify.register(snsCompatibilityRoutes, { prefix: `${apiPrefix}/sns` });
fastify.register(historyApiPlugin, { prefix: `${apiPrefix}/history` });
fastify.register(questUnlockApiPlugin, { prefix: `${apiPrefix}/quest` });
fastify.register(itemApiPlugin, { prefix: `${apiPrefix}/item` });
fastify.register(characterElectionApiPlugin, { prefix: `${apiPrefix}/character_election` });

fastify.register(indexWebApiPlugin, {
    prefix: "/api",
    getMultiStatus: () => multiRuntimeService.getAdminStatus(),
    getMultiManagementService: () => multiManagementService,
    getRuntimeConfig: () => startupRuntimeConfig,
    serverTimeService,
});
fastify.register(seedsWebApiPlugin, { prefix: "/api/seeds" });

registerAdminUi(fastify, { projectRoot });

let runtimeHttpConfigured = false;
function configureRuntimeHttp(config: ReturnType<typeof parseCnRuntimeConfig>): void {
    if (runtimeHttpConfigured) return;
    configureSerializedAssetVersionProvider(() => getContentSnapshot().cdn.targetVersion);
    const multiContext = multiRuntimeService.getHttpContext();
    fastify.register(multiBattleRoutes, {
        prefix: `${apiPrefix}/multi_battle_quest`,
        context: multiContext,
    });
    fastify.register(cnLoadPlugin, {
        prefix: apiPrefix,
        assetProvider: config.assetProvider,
        httpDisplayHost: config.httpDisplayHost,
        httpPort: config.http.port,
        summonComSeconds: config.summonComSeconds,
        dailyResetHour: config.dailyResetHour,
        multiMode: config.multi.mode,
        multiRecoveryVerifier: multiContext.settlementVerifier,
        getMultiParticipant: multiContext.snapshotProvider.getParticipant,
    });
    fastify.register(comicApiPlugin, {
        prefix: `${apiPrefix}/comic`,
        comicDir: config.comicDir,
        httpDisplayHost: config.httpDisplayHost,
        httpPort: config.http.port,
    });
    registerCnAssetProviderRoutes(fastify, { config: config.assetProvider });
    // iOS实验性兼容（IOS_COMPAT_ENABLED=1）：SDK裸路由与 iOS专用行为仅在启用时注册。
    // versionCheck需要运行时配置，故在 config就绪的 http阶段注册（不能早于此时）。
    fastify.register(versionCheckPlugin, { ios: config.iosCompat });
    if (config.iosCompat.enabled) {
        // iOS SDK请求的是裸路径（/sdk/v3-3/...、/mobile!...），必须无前缀注册。
        fastify.register(iosLeitingPlugin, { ios: config.iosCompat });
    }
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
        const config = parseCnRuntimeConfig({ projectRoot });
        startupRuntimeConfig = config;
        if (multiManagementService === null) {
            multiManagementService = new MultiManagementService({
                mode: config.multi.mode,
                credentials: createMultiManagementCredentialProvider({
                    mode: config.multi.mode,
                    env: process.env,
                    projectRoot,
                }),
                getStatus: () => multiRuntimeService.getAdminStatus(),
                probe: () => multiRuntimeService.probeControlStatus(),
                getAuthenticationDiagnostics: () => multiRuntimeService.getAuthenticationDiagnostics(),
            });
        }
        return config;
    },
    configureHttp: configureRuntimeHttp,
    initializeDatabase,
    restoreServerTime: () => { serverTimeService.restore(); },
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
    startMulti: (config, onFatalError) => multiRuntimeService.start(
        config.multi,
        onFatalError,
        config.multiTuning,
    ),
    stopMulti: () => multiRuntimeService.stop(),
    checkpointDatabase,
    closeDatabase,
    getDatabaseHealth: getRuntimeDatabaseHealth,
    isHttpListening: () => fastify.server.listening,
    getMultiStatus: () => multiRuntimeService.getStatus(),
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
