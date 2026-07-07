import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getServerTime, getServerDate, setServerTime, getTimeOffset } from "../../utils";
import { deleteAccountSync, getAccountPlayersSync, getAllAccountsSync } from "../../data/domains/account"
import { deletePlayerSync, getPlayerSync, insertDefaultPlayerSync, replacePlayerDataSync, updatePlayerSync } from "../../data/domains/player"
import { getAllDeviceBindingsSync, updateDeviceBindingNameSync } from "../../data/domains/session"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getClientSerializedData, deserializePlayerData, reviveMergedPlayerDates } from "../../data/utils";
import { getActivePlayerId, setActivePlayerId, getSelectedAccountId, setSelectedAccountId, saveTimeOffset, saveAccountDefaultPlayer, getAccountDefaultPlayer } from "../../data/activeAccount";
import { saveDefaultSaveTemplate, loadDefaultSaveTemplate, clearDefaultSaveTemplate, getDefaultSaveMeta } from "../../data/defaultSave";
import { wantsJson } from "./http";

interface TimeQuery {
    time: string | undefined
}

const routes = async (fastify: FastifyInstance) => {

    fastify.get("/currentTime", async (_request: FastifyRequest, reply: FastifyReply) => {
        const date = getServerDate()
        reply.status(200).send({
            servertime: getServerTime(),
            date: date.toISOString(),
            isCustom: date.getTime() !== Date.now()
        })
    })

    fastify.get("/resetTime", async (_request: FastifyRequest, reply: FastifyReply) => {
        setServerTime(null)
        saveTimeOffset(null)
        reply.status(200).send({
            servertime: getServerTime(),
            date: getServerDate().toISOString(),
            isCustom: false
        })
    })

    fastify.get("/time", async (request: FastifyRequest, reply: FastifyReply) => {
        const newTime = (request.query as TimeQuery).time
        if (!newTime) return reply.status(400).send({
            "error": "Bad Request",
            "message": "Missing 'time' parameter. Use format: 2025-06-01T12:00:00"
        })

        try {
            let dateStr = newTime
            if (!dateStr.includes('T')) {
                dateStr = dateStr + 'T00:00:00'
            }
            if (!dateStr.includes('Z') && !dateStr.includes('+') && !dateStr.includes('-', 10)) {
                dateStr = dateStr + 'Z'
            }
            const time = new Date(dateStr)
            if (isNaN(time.getTime())) {
                return reply.status(400).send({
                    "error": "Bad Request",
                    "message": `Invalid time format: "${newTime}". Use ISO format.`
                })
            }
            setServerTime(time)
            saveTimeOffset(getTimeOffset())
            reply.status(200).send({
                servertime: getServerTime(),
                date: getServerDate().toISOString(),
                isCustom: true
            })
        } catch (error: any) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": error?.message ?? "Unknown error"
            })
        }
    })

    // === Account list (JSON, for admin SPA) ===

    fastify.get("/accounts", async (_request: FastifyRequest, reply: FastifyReply) => {
        const accounts = getAllAccountsSync()
        const result = accounts.map(acc => {
            const playerIds = getAccountPlayersSync(acc.id)
            const defaultPid = getAccountDefaultPlayer(acc.id)
            const defaultPlayer = defaultPid ? getPlayerSync(defaultPid) : null
            return {
                id: acc.id,
                saveCount: playerIds.length,
                defaultPlayerId: defaultPid,
                defaultPlayerName: defaultPlayer?.name ?? null,
                playerIds
            }
        })
        return reply.send(result)
    })

    // === Default save template (admin-uploaded, applied when a new save is created) ===

    // 查询当前默认存档模板信息
    fastify.get("/defaultSave", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.send(getDefaultSaveMeta())
    })

    // 上传默认存档模板（multipart，快照格式同 GET /api/player/save 导出）
    fastify.post("/defaultSave", async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            const file = await (request as any).file()
            if (!file) return reply.status(400).send({ error: "未选择文件" })
            const text = (await file.toBuffer()).toString("utf-8")
            let parsed: any
            try { parsed = JSON.parse(text) } catch { return reply.status(400).send({ error: "文件不是有效的 JSON" }) }
            if (!parsed || typeof parsed !== "object" || parsed.schema !== "starpoint-cn-save")
                return reply.status(400).send({ error: "不是有效的存档快照（请使用本面板导出的存档）" })
            if (parsed.version !== 1)
                return reply.status(400).send({ error: `不支持的存档版本：${parsed.version}` })
            if (!parsed.data || typeof parsed.data !== "object" || !parsed.data.player)
                return reply.status(400).send({ error: "存档数据缺失 player 字段" })
            saveDefaultSaveTemplate(parsed)
            return reply.send({ ok: true, ...getDefaultSaveMeta() })
        } catch (e: any) {
            return reply.status(500).send({ error: e?.message ?? "上传失败" })
        }
    })

    // 清除默认存档模板
    fastify.delete("/defaultSave", async (_request: FastifyRequest, reply: FastifyReply) => {
        const removed = clearDefaultSaveTemplate()
        return reply.send({ ok: true, removed })
    })

    // === Account & Save management (device-binding based) ===

    // Select account to view saves
    fastify.post("/selectAccount", async (request: FastifyRequest, reply: FastifyReply) => {
        const { accountId } = (request.query || {}) as any
        const aid = parseInt(accountId)
        if (isNaN(aid)) {
            if (wantsJson(request)) return reply.status(400).send({ error: "Invalid accountId" })
            return reply.redirect('/player')
        }
        setSelectedAccountId(aid)
        if (wantsJson(request)) return reply.send({ ok: true, accountId: aid })
        return reply.redirect('/player')
    })

    // Switch active save
    fastify.post("/activateSave", async (request: FastifyRequest, reply: FastifyReply) => {
        const { playerId } = (request.query || {}) as any
        const pid = parseInt(playerId)
        if (isNaN(pid)) {
            if (wantsJson(request)) return reply.status(400).send({ error: "Invalid playerId" })
            return reply.redirect('/player')
        }
        setActivePlayerId(pid)
        const allAccounts = getAllAccountsSync()
        for (const a of allAccounts) {
            if (getAccountPlayersSync(a.id).includes(pid)) {
                saveAccountDefaultPlayer(a.id, pid)
                break
            }
        }
        if (wantsJson(request)) return reply.send({ ok: true, playerId: pid })
        return reply.redirect('/player')
    })

    // Create new empty save under the given account
    fastify.post("/newSave", async (request: FastifyRequest, reply: FastifyReply) => {
        const { accountId: aid } = (request.query || {}) as any
        const accId = parseInt(aid)
        if (isNaN(accId)) {
            if (wantsJson(request)) return reply.status(400).send({ error: "Invalid accountId" })
            return reply.redirect('/player')
        }
        const player = insertDefaultPlayerSync(accId)
        // 若管理员配置了默认存档模板，用它替换新建的空存档
        let appliedTemplate = false
        try {
            const template = loadDefaultSaveTemplate()
            if (template?.data?.player) {
                const data = reviveMergedPlayerDates(template.data)
                data.player.id = player.id
                replacePlayerDataSync(data)
                appliedTemplate = true
            }
        } catch (_) { /* 模板损坏则退回空存档 */ }
        setActivePlayerId(player.id)
        saveAccountDefaultPlayer(accId, player.id)
        if (wantsJson(request)) return reply.send({ ok: true, playerId: player.id, appliedTemplate })
        return reply.redirect('/player')
    })

    // Delete a save
    fastify.post("/deleteSave", async (request: FastifyRequest, reply: FastifyReply) => {
        const { playerId } = (request.query || {}) as any
        const pid = parseInt(playerId)
        if (isNaN(pid)) {
            if (wantsJson(request)) return reply.status(400).send({ error: "Invalid playerId" })
            return reply.redirect('/player')
        }
        const allAccounts = getAllAccountsSync()
        let accountId = 0
        for (const a of allAccounts) {
            if (getAccountPlayersSync(a.id).includes(pid)) { accountId = a.id; break }
        }
        if (accountId && getAccountPlayersSync(accountId).length <= 1) {
            deletePlayerSync(pid)
            deleteAccountSync(accountId)
            try {
                const db = require("../../data/db").getDb()
                db.prepare(`DELETE FROM device_bindings WHERE account_id = ?`).run(accountId)
            } catch (_) {}
            try {
                const { readState, writeState } = require("../../data/activeAccount")
                const state = readState()
                delete state.defaultPlayers[accountId]
                writeState(state)
            } catch (_) {}
        } else {
            deletePlayerSync(pid)
        }
        const accountAlsoDeleted = accountId && getAccountPlayersSync(accountId).length === 0
        if (getActivePlayerId() === pid) setActivePlayerId(null)
        if (wantsJson(request)) return reply.send({ ok: true, deleted: pid, accountAlsoDeleted: !!accountAlsoDeleted })
        return reply.redirect('/player')
    })

    // Delete entire account + all saves + device binding
    fastify.post("/deleteAccount", async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = (request.query || {}) as any
        const accountId = parseInt(id)
        if (isNaN(accountId)) return reply.status(400).send({ error: "Missing or invalid 'id'" })
        const playerIds = getAccountPlayersSync(accountId)
        for (const pid of playerIds) {
            deletePlayerSync(pid)
        }
        // Remove device bindings pointing to this account
        const db = require("../../data/db").getDb()
        db.prepare(`DELETE FROM device_bindings WHERE account_id = ?`).run(accountId)
        deleteAccountSync(accountId)
        try {
            const { readState, writeState } = require("../../data/activeAccount")
            const state = readState()
            delete state.defaultPlayers[accountId]
            writeState(state)
        } catch (_) {}
        if (wantsJson(request)) return reply.send({ ok: true, accountId, deletedSaves: playerIds.length })
        return reply.redirect('/player')
    })

    // Rename a save
    fastify.post("/renameSave", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as Record<string, any> || {}
        const playerId = parseInt(body.playerId)
        const name = body.name
        if (isNaN(playerId) || !name) return reply.status(400).send({ error: "Missing params" })
        updatePlayerSync({ id: playerId, name: String(name) })
        if (wantsJson(request)) return reply.send({ ok: true, playerId, name: String(name) })
        return reply.redirect('/player')
    })

    // Clone a save to another account
    fastify.post("/cloneSave", async (request: FastifyRequest, reply: FastifyReply) => {
        const { playerId: pid, accountId: aid } = (request.query || {}) as any
        const playerId = parseInt(pid)
        const accountId = parseInt(aid)
        if (isNaN(playerId) || isNaN(accountId)) {
            if (wantsJson(request)) return reply.status(400).send({ error: "Invalid playerId or accountId" })
            return reply.redirect('/player')
        }

        const serialized = getClientSerializedData(playerId, { viewerId: 0 })
        if (!serialized) {
            if (wantsJson(request)) return reply.status(404).send({ error: "Source player not found" })
            return reply.redirect('/player')
        }

        const newPlayer = insertDefaultPlayerSync(accountId)
        setActivePlayerId(newPlayer.id)

        const mergedData = deserializePlayerData(newPlayer.id, serialized)
        replacePlayerDataSync(mergedData)

        saveAccountDefaultPlayer(accountId, newPlayer.id)
        if (wantsJson(request)) return reply.send({ ok: true, newPlayerId: newPlayer.id })
        return reply.redirect('/player')
    })

    // Device binding rename
    fastify.post("/device/rename", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { device_id: number; name: string }
        const deviceId = body.device_id
        if (!deviceId) return reply.status(400).send({ error: "Missing device_id" })

        updateDeviceBindingNameSync(deviceId, body.name || null)
        return reply.status(200).send({ ok: true })
    })
}

export default routes;
