// 存档子卡喜爱角色头像（mockup accounts-nested-saves）: 游戏内「收藏编队」主角色立绘,
// 走既有 /api/content/character_avatar/:id 端点（immutable 内容寻址）。
// 立绘覆盖缺失（含收藏编队兜底占位非真实角色 id）时 onError 隐藏图片, 露出底层首字占位 —
// 与 TimeControl 的 admin-char-avatar 既有惯例同构。尺寸: 移动 40×40, 桌面 ≥768 44×44（.av-img）。
export function FavoriteAvatar({ characterId, name }: { characterId: number | null; name: string }) {
    return (
        <span className="av-img" aria-hidden>
            {name.slice(0, 1)}
            {characterId !== null && (
                <img
                    className="av-img-picture"
                    src={`/api/content/character_avatar/${characterId}`}
                    alt=""
                    loading="lazy"
                    onError={event => {
                        event.currentTarget.classList.add("av-img-picture-broken")
                    }}
                />
            )}
        </span>
    )
}
