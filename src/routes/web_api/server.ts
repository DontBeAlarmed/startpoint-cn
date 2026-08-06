import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getServerDate } from "../../utils";
import { ServerTimeService, ServerTimeServiceError } from "../../runtime/server-time/service";
import { validateServerTimePackage } from "../../runtime/server-time/store";
import type { ServerTimePackage, ServerTimeSnapshot } from "../../runtime/server-time/types";
import { deleteAccountSync, getAccountPlayersSync, getAllAccountsSync } from "../../data/domains/account"
import { deletePlayerSync, getPlayerSync, insertDefaultPlayerSync, updatePlayerSync } from "../../data/domains/player"
import { getAllDeviceBindingsSync, updateDeviceBindingNameSync } from "../../data/domains/session"
import { getPlayerCharactersSync } from "../../data/domains/character"
import { getActivePlayerId, setActivePlayerId, saveAccountDefaultPlayer, getAccountDefaultPlayer } from "../../data/activeAccount";
import { saveDefaultSaveTemplate, loadDefaultSaveTemplate, clearDefaultSaveTemplate, getDefaultSaveMeta } from "../../data/defaultSave";
import { getEffectiveVersion } from "../../lib/version";
import { buildShortUpCharacterGachaTimeline } from "../../lib/admin-clairvoyance";
import { buildAdminContentStatus } from "../../lib/admin-content-status";
import { parseAssetProviderConfig } from "../../content/cdn/asset-mode";
import { getContentSnapshot } from "../../content/runtime/content-snapshot";
import { wantsJson } from "./http";
import {
    buildAdminMultiStatus,
    type AdminMultiStatus,
} from "../../lib/admin-multi-status";
import { unavailableMultiRuntimeStatus } from "../../multi/runtime/status";
import { requireLoopback } from "../../multi/management/loopback";
import {
    applyPlayerSaveTemplateSync,
    clonePlayerSaveV2Sync,
    exportPlayerSaveV2Sync,
    validatePlayerSaveTemplateSync,
} from "../../data/player-save";

interface TimeQuery {
    time: string | undefined
}

export interface ServerRoutesOptions {
    readonly getMultiStatus?: () => Promise<AdminMultiStatus> | AdminMultiStatus
    readonly serverTimeService?: ServerTimeService
}

function httpTimePackage(snapshot: ServerTimeSnapshot): ServerTimePackage {
    return {
        mode: snapshot.mode,
        offsetMs: snapshot.offsetMs,
        generatedAt: snapshot.generatedAt,
    }
}

function legacyTimeResponse(
    snapshot: ServerTimeSnapshot,
    isCustom: boolean = snapshot.mode === "offset",
) {
    return {
        servertime: Math.floor(snapshot.serverTimeMs / 1000),
        date: new Date(snapshot.serverTimeMs).toISOString(),
        isCustom,
    }
}

const routes = async (fastify: FastifyInstance, options: ServerRoutesOptions) => {
    const serverTimeService = options.serverTimeService ?? new ServerTimeService()

    fastify.get("/status", async (_request: FastifyRequest, reply: FastifyReply) => {
        const root = process.cwd()
        const cdnDir = process.env.CDN_DIR || ".cdn"
        const cdnStatus = buildAdminContentStatus({
            snapshot: getContentSnapshot(),
            assetProvider: parseAssetProviderConfig({ projectRoot: root, env: process.env }),
            configuredCdnDir: cdnDir,
        })
        let multiplayer: AdminMultiStatus
        try {
            multiplayer = options.getMultiStatus
                ? await options.getMultiStatus()
                : buildAdminMultiStatus({
                    runtime: unavailableMultiRuntimeStatus(),
                    authority: null,
                    latestCompatibilityRejection: null,
                })
        } catch {
            multiplayer = buildAdminMultiStatus({
                runtime: unavailableMultiRuntimeStatus(),
                authority: null,
                latestCompatibilityRejection: null,
            })
        }

        reply.status(200).send({
            server: {
                uptimeSeconds: Math.floor(process.uptime()),
                nodeVersion: process.version,
                platform: `${process.platform}/${process.arch}`,
                pid: process.pid,
                memory: process.memoryUsage(),
                listenHost: process.env.CN_LISTEN_HOST || "localhost",
                listenPort: process.env.CN_LISTEN_PORT || "8001",
            },
            cdn: cdnStatus,
            multiplayer,
        })
    })

    fastify.get("/currentTime", async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.status(200).send(legacyTimeResponse(serverTimeService.getState()))
    })

    fastify.get("/time-package", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(200).send(httpTimePackage(serverTimeService.exportPackage()))
    })

    fastify.put("/time-package", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!requireLoopback(request, reply)) return
        try {
            validateServerTimePackage(request.body)
        } catch (error) {
            return reply.status(400).send({
                error: "Bad Request",
                message: error instanceof Error ? error.message : "INVALID_SERVER_TIME_STATE",
            })
        }

        try {
            return reply.status(200).send(serverTimeService.importPackage(request.body))
        } catch (error) {
            if (error instanceof ServerTimeServiceError) {
                return reply.status(400).send({ error: "Bad Request", message: error.message })
            }
            return reply.status(500).send({
                error: "Internal Server Error",
                message: error instanceof Error ? error.message : "Unknown error",
            })
        }
    })

    fastify.get("/resetTime", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!requireLoopback(request, reply)) return
        reply.status(200).send(legacyTimeResponse(
            serverTimeService.setSystemTime(),
            false,
        ))
    })

    fastify.get("/time", async (request: FastifyRequest, reply: FastifyReply) => {
        if (!requireLoopback(request, reply)) return
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
            reply.status(200).send(legacyTimeResponse(
                serverTimeService.setAbsoluteTime(time.getTime()),
                true,
            ))
        } catch (error: any) {
            return reply.status(500).send({
                "error": "Internal Server Error",
                "message": error?.message ?? "Unknown error"
            })
        }
    })

    fastify.get("/clairvoyance/gacha", async (_request: FastifyRequest, reply: FastifyReply) => {
        return reply.status(200).send({
            cdnVersion: getEffectiveVersion(),
            baseline: "fixed-cn-final",
            ...buildShortUpCharacterGachaTimeline(getServerDate()),
        })
    })

    // === Account list (JSON, for admin SPA) ===

    fastify.get("/accounts", async (_request: FastifyRequest, reply: FastifyReply) => {
        const accounts = getAllAccountsSync()
        const activePlayerId = getActivePlayerId()
        const devicesByAccount = new Map<number, Array<{ deviceId: number; name: string | null }>>()
        for (const binding of getAllDeviceBindingsSync()) {
            const devices = devicesByAccount.get(binding.account_id) ?? []
            devices.push({ deviceId: binding.device_id, name: binding.name })
            devicesByAccount.set(binding.account_id, devices)
        }
        const result = accounts.map(acc => {
            const playerIds = getAccountPlayersSync(acc.id)
            const savedDefaultPid = getAccountDefaultPlayer(acc.id)
            const defaultPid = savedDefaultPid && playerIds.includes(savedDefaultPid)
                ? savedDefaultPid
                : (playerIds[0] ?? null)
            const defaultPlayer = defaultPid ? getPlayerSync(defaultPid) : null
            return {
                id: acc.id,
                saveCount: playerIds.length,
                defaultPlayerId: defaultPid,
                defaultPlayerName: defaultPlayer?.name ?? null,
                activePlayerId,
                devices: devicesByAccount.get(acc.id) ?? [],
                players: playerIds.map(pid => {
                    const player = getPlayerSync(pid)
                    return {
                        id: pid,
                        accountId: acc.id,
                        name: player?.name ?? `存档 #${pid}`,
                        degreeId: player?.degreeId ?? 0,
                        isDefault: defaultPid === pid,
                        isActive: activePlayerId === pid,
                    }
                }),
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
            try {
                validatePlayerSaveTemplateSync(parsed)
            } catch (error: any) {
                return reply.status(400).send({ error: `存档校验失败：${error?.message ?? error}` })
            }
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
            if (template) {
                applyPlayerSaveTemplateSync(template, player.id)
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
            const remainingPlayerIds = getAccountPlayersSync(accountId)
            if (getAccountDefaultPlayer(accountId) === pid && remainingPlayerIds.length > 0) {
                saveAccountDefaultPlayer(accountId, remainingPlayerIds[0])
            }
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

        if (getPlayerSync(playerId) === null) {
            if (wantsJson(request)) return reply.status(404).send({ error: "Source player not found" })
            return reply.redirect('/player')
        }

        let snapshot
        try {
            snapshot = exportPlayerSaveV2Sync(playerId)
        } catch (error: any) {
            const message = `存档导出失败：${error?.message ?? error}`
            if (wantsJson(request)) return reply.status(500).send({ error: message })
            return reply.redirect(`/player/${playerId}?error=${encodeURIComponent(message)}`)
        }

        const cloned = clonePlayerSaveV2Sync(snapshot, accountId)
        setActivePlayerId(cloned.playerId)

        saveAccountDefaultPlayer(accountId, cloned.playerId)
        if (wantsJson(request)) return reply.send({ ok: true, newPlayerId: cloned.playerId })
        return reply.redirect('/player')
    })

    // Device binding rename
    fastify.post("/device/rename", async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { deviceId?: unknown; name?: unknown }
        const deviceId = body.deviceId
        if (!Number.isSafeInteger(deviceId) || (deviceId as number) <= 0) {
            return reply.status(400).send({ error: "Invalid deviceId" })
        }
        if (body.name !== undefined && typeof body.name !== "string") {
            return reply.status(400).send({ error: "Invalid device name" })
        }
        const name = typeof body.name === "string" && body.name.trim() !== ""
            ? body.name.trim()
            : null
        if (name !== null && name.length > 64) {
            return reply.status(400).send({ error: "Device name must not exceed 64 characters" })
        }
        if (!updateDeviceBindingNameSync(deviceId as number, name)) {
            return reply.status(404).send({ error: "Device binding not found" })
        }
        return reply.status(200).send({ ok: true, deviceId, name })
    })
}

export default routes;
