import Fastify, { FastifyRequest } from "fastify";
import { ContentTypeParserDoneFunction } from "fastify/types/content-type-parser";
import { pack, unpack } from "msgpackr";
import fastifyStatic from "@fastify/static";
import path from "path";

import versionCheckPlugin from "./routes/cn/versionCheck";
import leitingAuthPlugin from "./routes/cn/leitingAuth";
import cnToolPlugin from "./routes/cn/tool";
import cnLoadPlugin from "./routes/cn/load";
import cnAssetPlugin from "./routes/cn/asset";
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

const fastify = Fastify({
    logger: {
        level: "info"
    }
});

fastify.addHook("onSend", (_, reply, payload, done) => {
    try {
        if (reply.getHeader("content-type") === "application/x-msgpack") {
            done(null, pack(payload).toString("base64"));
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
            jsonParser(_request, body, done);
        }
    }
);
fastify.addContentTypeParser("application/json", { parseAs: "string" }, jsonParser);

fastify.register(versionCheckPlugin);
fastify.register(leitingAuthPlugin, { prefix: "/api/index.php" });

const apiPrefix = "/api/index.php";
fastify.register(cnLoadPlugin, { prefix: apiPrefix });
fastify.register(cnAssetPlugin, { prefix: `${apiPrefix}/asset` });

function stubMsgpackReply(reply: any, data: any) {
    reply.header("content-type", "application/x-msgpack");
    reply.status(200).send({
        data_headers: { force_update: false, asset_update: false, short_udid: 0, viewer_id: 0, servertime: Math.floor(Date.now() / 1000), result_code: 1 },
        data
    });
}

fastify.post(`${apiPrefix}/assetintitle/version_info_in_title`, async (_request, reply) => {
    stubMsgpackReply(reply, {
        base_url: `${CDN_BASE_URL}/EntityLists/`,
        files_list: `${CDN_BASE_URL}/EntityLists/10939-android_medium.csv`,
        total_size: 10500000000,
        delayed_assets_size: 7000000000
    });
});

fastify.post(`${apiPrefix}/tool/check_social_link_enable`, async (_request, reply) => {
    stubMsgpackReply(reply, { enable: false });
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

fastify.get("/debug", async (request, reply) => {
    const ts = new Date().toISOString();
    const loc = (request.query as any)?.loc || "unknown";
    console.log(`[BEACON ${ts}] ${loc}`);
    reply.status(200).send("OK");
});

fastify.post("/debug", async (request, reply) => {
    const ts = new Date().toISOString();
    const loc = (request.body as any)?.loc || "unknown";
    console.log(`[BEACON ${ts}] ${loc}`);
    reply.status(200).send("OK");
});

fastify.post("/crash", async (request, reply) => {
    console.log(`[CRASH] ${JSON.stringify(request.body).substring(0, 2000)}`);
    reply.status(200).send("OK");
});


fastify.register(cnToolPlugin, { prefix: `${apiPrefix}/tool` });
fastify.register(reproduceApiPlugin, { prefix: `${apiPrefix}/reproduce` });
fastify.post(`${apiPrefix}/tutorial/update_step`, async (_request, reply) => {
    stubMsgpackReply(reply, { step: 1, start_time: Math.floor(Date.now() / 1000), mail_arrived: false });
});
fastify.post(`${apiPrefix}/tutorial/finish_trigger`, async (_request, reply) => {
    stubMsgpackReply(reply, []);
});
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
});
