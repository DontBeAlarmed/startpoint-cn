"use strict"

// 启动清扫（startup-sweep）回归：进程重启后本地库的孤儿注册/招募行清除，
// 共享库部署与存活房间在场时跳过。

const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

require("ts-node/register/transpile-only")

const restoreContentSnapshot = require("./helpers/install-bundled-gameplay-snapshot.cjs")
    .installBundledGameplaySnapshot()
process.once("exit", () => restoreContentSnapshot())

const databaseDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "startup-sweep-"))
const previousDataDirectory = process.env.DATA_DIR
const previousSocialDbPath = process.env.MULTI_SOCIAL_DB_PATH
delete process.env.MULTI_SOCIAL_DB_PATH
process.env.DATA_DIR = databaseDirectory
process.once("exit", () => {
    if (previousDataDirectory === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDirectory
    if (previousSocialDbPath === undefined) delete process.env.MULTI_SOCIAL_DB_PATH
    else process.env.MULTI_SOCIAL_DB_PATH = previousSocialDbPath
    fs.rmSync(databaseDirectory, { recursive: true, force: true })
})

const data = require("../src/data")
const { getDb } = require("../src/data/db")
data.initializeDatabase()
const db = getDb()

const {
    getOrCreateRecruitmentForRoom,
    findOpenRecruitmentForRoom,
} = require("../src/data/domains/attention")
const {
    upsertRoomShareRowSync,
    getRoomShareRowSync,
} = require("../src/data/domains/social-room-shares")
const { purgeOrphanedSocialRowsForLocalAuthority } = require("../src/multi/runtime/startup-sweep")
const { createRoom, listActiveRooms } = require("../src/multi/room/manager")

const HOST = 64201
const nowMs = Date.now()

function seedRows(roomNumber) {
    upsertRoomShareRowSync({
        roomNumber,
        hostViewerId: HOST,
        categoryId: 1,
        questId: 1001001,
        shareBits: 1,
        raisingState: 1,
        mates: 2,
        establisherJson: "{}",
        nowMs,
        expiresAtMs: nowMs + 30 * 60 * 1000,
    })
    getOrCreateRecruitmentForRoom({
        hostPid: 4201,
        hostViewerId: HOST,
        category: 1,
        questId: 1001001,
        roomNumber,
        isNewbieHost: false,
        establisherJson: "{}",
        nowMs,
    })
}

// ---- 启动态（无存活房间）：孤儿行全部清除 ----
{
    seedRows("642101")
    assert.ok(getRoomShareRowSync("642101"), "前置：注册行存在")
    assert.ok(findOpenRecruitmentForRoom(HOST, "642101", nowMs), "前置：招募行 open")

    purgeOrphanedSocialRowsForLocalAuthority()

    assert.equal(getRoomShareRowSync("642101"), undefined, "孤儿注册行已清除")
    assert.equal(findOpenRecruitmentForRoom(HOST, "642101", nowMs), null, "孤儿招募行已关闭")
}

// ---- 存活房间在场（非启动态）：跳过清扫，绝不碰活数据 ----
{
    const room = createRoom(
        HOST, HOST + 1000, 1, 1, HOST + 2000, 1, HOST + 3000,
        false,
        { nodeSessionId: "embedded", viewerId: HOST },
    )
    seedRows(room.room_number)
    assert.ok(listActiveRooms().length > 0, "前置：内存房间存活")

    purgeOrphanedSocialRowsForLocalAuthority()

    assert.ok(getRoomShareRowSync(room.room_number), "存活房间的注册行保留")
    assert.ok(findOpenRecruitmentForRoom(HOST, room.room_number, nowMs), "存活房间的招募行保留")

    // disband 清行走解散监听器（生产由 runtime service 安装；测试显式装）
    const { installDisbandLifecycleListener } = require("../src/multi/room/disband-listener")
    installDisbandLifecycleListener()
    require("../src/multi/room/manager").disbandRoom(room.room_number)
    assert.equal(getRoomShareRowSync(room.room_number), undefined, "收尾：disband 钩子清行")
    require("../src/multi/room/manager").setRoomDisbandListener(null)
}

// ---- 共享库配置：跳过清扫（多节点无权判他节点行） ----
{
    process.env.MULTI_SOCIAL_DB_PATH = path.join(databaseDirectory, "shared-social.db")
    try {
        seedRows("642103")
        purgeOrphanedSocialRowsForLocalAuthority()
        // 配置共享库后行写入共享文件；清扫必须跳过（行仍在）
        assert.ok(getRoomShareRowSync("642103"), "共享库模式不清扫")
    } finally {
        if (previousSocialDbPath === undefined) delete process.env.MULTI_SOCIAL_DB_PATH
        else process.env.MULTI_SOCIAL_DB_PATH = previousSocialDbPath
    }
}

console.log("startup sweep: all assertions passed")
