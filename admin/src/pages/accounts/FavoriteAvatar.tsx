// 存档子卡喜爱角色头像（mockup accounts-nested-saves）: 游戏内「收藏编队」主角色立绘,
// 走既有 /api/content/character_avatar/:id 端点（immutable 内容寻址）。
// 回退链（mockup 规格第 5 条 + 维护者补充）: 收藏编队角色 → 立绘 404（含非空失效角色 id,
// 如已删除角色/占位位）时重试默认角色 alk(id 1) → 仍失败才 onError 隐藏图片露首字占位。
// 与 TimeControl 的 admin-char-avatar 既有惯例同构。尺寸: 移动 40×40, 桌面 ≥768 44×44（.av-img）。
import type { AccountRow } from "./types"

// 默认角色 alk 的角色 id（无收藏编队或收藏立绘缺失时的头像回退）
const DEFAULT_AVATAR_CHARACTER_ID = 1

export function FavoriteAvatar({ characterId, name }: { characterId: number | null; name: string }) {
    return (
        <span className="av-img" aria-hidden>
            {name.slice(0, 1)}
            <img
                className="av-img-picture"
                // ?v=2: 一次性击穿浏览器缓存的旧坏响应(源归档 zlib 流修复前的 max-age=86400 缓存)
                        src={`/api/content/character_avatar/${characterId ?? DEFAULT_AVATAR_CHARACTER_ID}?v=2`}
                alt=""
                loading="lazy"
                onError={event => {
                    const img = event.currentTarget
                    const fallback = `/api/content/character_avatar/${DEFAULT_AVATAR_CHARACTER_ID}`
                    if (img.getAttribute("src") !== fallback) {
                        img.src = fallback
                        return
                    }
                    img.classList.add("av-img-picture-broken")
                }}
            />
        </span>
    )
}

// 账号卡头像口径（mockup 规格第 5 条）: 当前存档的喜爱角色; 无当前存档或投影缺失时 null = 首字占位
export function defaultPlayerAvatarId(account: AccountRow): number | null {
    return account.players.find(player => player.id === account.defaultPlayerId)?.favoriteCharacterId ?? null
}
