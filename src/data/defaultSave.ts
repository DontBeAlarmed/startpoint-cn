/**
 * 默认存档模板：管理员上传一份存档快照，作为「账户新建存档」时的初始内容。
 * 持久化到运行时数据目录的 state/default_save.json（与 active_account.json 同目录）。
 * 快照格式与 GET /api/player/save 导出一致。v2 是完整快照，v1 仅保留兼容读取。
 */
import * as fs from "fs";
import { prepareDataVolume } from "../runtime/data-paths";
import { getPlayerRankLevel } from "../lib/player-rank-content";
import { LegacyPlayerSaveV1Snapshot, PlayerSaveV2Snapshot } from "./player-save/types";

export type DefaultSaveSnapshot = LegacyPlayerSaveV1Snapshot | PlayerSaveV2Snapshot;

/** 模板存档自身统计（只读解析自快照 JSON；等级由 rank_point 经 Rank 内容表换算）。 */
export interface DefaultSaveStats {
    rank?: number;
    characterCount?: number;
    equipmentCount?: number;
}

export interface DefaultSaveMeta {
    exists: boolean;
    playerName?: string | null;
    exportedAt?: string | null;
    sourcePlayerId?: number | null;
    formatVersion?: number;
    legacyPartial?: boolean;
    stats?: DefaultSaveStats;
}

export function saveDefaultSaveTemplate(snapshot: DefaultSaveSnapshot): void {
    const file = prepareDataVolume().defaultSaveFile;
    fs.writeFileSync(file, JSON.stringify(snapshot), "utf-8");
}

export function loadDefaultSaveTemplate(): DefaultSaveSnapshot | null {
    const file = prepareDataVolume().defaultSaveFile;
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, "utf-8")) as DefaultSaveSnapshot;
    } catch {
        return null;
    }
}

export function clearDefaultSaveTemplate(): boolean {
    const file = prepareDataVolume().defaultSaveFile;
    try {
        if (fs.existsSync(file)) { fs.unlinkSync(file); return true; }
    } catch { /* ignore */ }
    return false;
}

/**
 * 只读解析模板存档 JSON 的自身统计：角色数（players_characters 行数）、
 * 装备数（players_equipment 行数）、等级（players.rank_point 经
 * getPlayerRankLevel 按 Rank 内容表换算）。零写入；任何字段不可解析时
 * 降级为仅返回可获得的子集。legacy v1 快照没有 domains 结构，返回空统计。
 */
function getTemplateStats(snapshot: DefaultSaveSnapshot): DefaultSaveStats {
    const formatVersion = "formatVersion" in snapshot ? snapshot.formatVersion : snapshot.version;
    if (formatVersion !== 2) return {};
    const tables = (snapshot as PlayerSaveV2Snapshot).domains?.core?.tables;
    if (!tables) return {};
    const stats: DefaultSaveStats = {};
    if (Array.isArray(tables.players_characters)) {
        stats.characterCount = tables.players_characters.length;
    }
    if (Array.isArray(tables.players_equipment)) {
        stats.equipmentCount = tables.players_equipment.length;
    }
    const player = Array.isArray(tables.players) ? tables.players[0] : undefined;
    const rankPoint = player !== undefined && typeof player.rank_point === "number"
        ? player.rank_point
        : Number.NaN;
    if (Number.isSafeInteger(rankPoint) && rankPoint >= 0) {
        try {
            stats.rank = getPlayerRankLevel(rankPoint);
        } catch {
            // Rank 内容表不可用时降级：不展示等级
        }
    }
    return stats;
}

export function getDefaultSaveMeta(): DefaultSaveMeta {
    const t = loadDefaultSaveTemplate();
    if (!t) return { exists: false };
    const formatVersion = "formatVersion" in t ? t.formatVersion : t.version;
    const playerName = formatVersion === 2
        ? (t as PlayerSaveV2Snapshot).domains?.core?.tables?.players?.[0]?.name
        : (t as LegacyPlayerSaveV1Snapshot).data?.player?.name;
    return {
        exists: true,
        playerName: typeof playerName === "string" ? playerName : null,
        exportedAt: t.exportedAt ?? null,
        sourcePlayerId: t.playerId ?? null,
        formatVersion,
        legacyPartial: formatVersion === 1,
        stats: getTemplateStats(t),
    };
}
