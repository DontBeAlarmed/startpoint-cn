// 存档子卡喜爱角色头像（mockup accounts-nested-saves）: 游戏内「收藏编队」主角色立绘,
// 走既有 /api/content/character_avatar/:id 端点（immutable 内容寻址）。
// 回退链（mockup 规格第 5 条）: 收藏编队角色 → 默认角色 alk(id 1) → onError 隐藏图片露首字占位。
// 与 TimeControl 的 admin-char-avatar 既有惯例同构。尺寸: 移动 40×40, 桌面 ≥768 44×44（.av-img）。
import type { AccountRow } from "./types"

// 默认角色 alk 的角色 id（无收藏编队时的头像回退）
const DEFAULT_AVATAR_CHARACTER_ID = 1

export function FavoriteAvatar({ characterId, name }: { characterId: number | null; name: string }) {
    return (
        <span className="av-img" aria-hidden>
            {name.slice(0, 1)}
            <img
                className="av-img-picture"
                src={`/api/content/character_avatar/${characterId ?? DEFAULT_AVATAR_CHARACTER_ID}`}
                alt=""
                loading="lazy"
                onError={event => {
                    event.currentTarget.classList.add("av-img-picture-broken")
                }}
            />
        </span>
    )
}

// 账号卡头像口径（mockup 规格第 5 条）: 当前存档的喜爱角色; 无当前存档或投影缺失时 null = 首字占位
export function defaultPlayerAvatarId(account: AccountRow): number | null {
    return account.players.find(player => player.id === account.defaultPlayerId)?.favoriteCharacterId ?? null
}
