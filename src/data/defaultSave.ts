/**
 * 默认存档模板：管理员上传一份存档快照，作为「账户新建存档」时的初始内容。
 * 持久化到 .database/default_save.json（与 active_account.json 同目录，均 gitignored）。
 * 快照格式与 GET /api/player/save 导出一致：{ schema:"starpoint-cn-save", version:1, exportedAt, playerId, data }。
 */
import * as fs from "fs";
import * as path from "path";

const FILE = path.join(__dirname, "..", "..", ".database", "default_save.json");

export interface DefaultSaveSnapshot {
    schema: string;
    version: number;
    exportedAt?: string;
    playerId?: number;
    data: any;
}

export interface DefaultSaveMeta {
    exists: boolean;
    playerName?: string | null;
    exportedAt?: string | null;
    sourcePlayerId?: number | null;
}

export function saveDefaultSaveTemplate(snapshot: DefaultSaveSnapshot): void {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(snapshot), "utf-8");
}

export function loadDefaultSaveTemplate(): DefaultSaveSnapshot | null {
    try {
        if (!fs.existsSync(FILE)) return null;
        return JSON.parse(fs.readFileSync(FILE, "utf-8")) as DefaultSaveSnapshot;
    } catch {
        return null;
    }
}

export function clearDefaultSaveTemplate(): boolean {
    try {
        if (fs.existsSync(FILE)) { fs.unlinkSync(FILE); return true; }
    } catch { /* ignore */ }
    return false;
}

export function getDefaultSaveMeta(): DefaultSaveMeta {
    const t = loadDefaultSaveTemplate();
    if (!t) return { exists: false };
    return {
        exists: true,
        playerName: t.data?.player?.name ?? null,
        exportedAt: t.exportedAt ?? null,
        sourcePlayerId: t.playerId ?? null,
    };
}
