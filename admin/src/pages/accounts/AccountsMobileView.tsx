import { useState } from "react"
import {
    Button,
    Dropdown,
    Empty,
    Input,
    Modal,
    Typography,
} from "antd"
import { Pencil, Plus } from "lucide-react"

import type { AccountRow } from "./types"
import { FavoriteAvatar, defaultPlayerAvatarId } from "./FavoriteAvatar"

interface AccountsMobileViewProps {
    accounts: readonly AccountRow[]
    selectedAccount: AccountRow | undefined
    loading: boolean
    onSelectAccount: (accountId: number) => void
    onOpenPlayer: (playerId: number) => void
    onNewSave: (accountId: number) => Promise<unknown>
    onDeleteAccount: (accountId: number) => Promise<unknown>
    onActivateSave: (playerId: number) => Promise<unknown>
    onCloneSave: (playerId: number, accountId: number) => Promise<unknown>
    onDeleteSave: (playerId: number) => Promise<unknown>
    onUpdateNote: (accountId: number, note: string) => Promise<unknown>
}

export function AccountsMobileView({
    accounts,
    selectedAccount,
    loading,
    onSelectAccount,
    onOpenPlayer,
    onNewSave,
    onDeleteAccount,
    onActivateSave,
    onCloneSave,
    onDeleteSave,
    onUpdateNote,
}: AccountsMobileViewProps) {
    const [noteEditId, setNoteEditId] = useState<number | null>(null)
    const [noteDraft, setNoteDraft] = useState("")
    const [noteSaving, setNoteSaving] = useState(false)
    const selectedAccountId = selectedAccount?.id ?? null

    const submitNote = async (accountId: number) => {
        if (noteSaving) return
        setNoteSaving(true)
        try {
            await onUpdateNote(accountId, noteDraft)
            setNoteEditId(null)
        } finally {
            setNoteSaving(false)
        }
    }

    // 账号级「…」菜单: 删除账号(原样确认)
    const confirmDeleteAccount = (accountId: number) => {
        Modal.confirm({
            title: `删除账号 ${accountId} 及所有存档？`,
            okText: "确认",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => onDeleteAccount(accountId),
        })
    }

    const moreActionsMenu = (accountId: number) => ({
        items: [{ key: "delete-account", danger: true, label: "删除账号" }],
        onClick: ({ key }: { key: string }) => {
            if (key === "delete-account") confirmDeleteAccount(accountId)
        },
    })

    // 存档级「…」菜单: 复制/删除
    const saveMoreMenu = (account: AccountRow, player: AccountRow["players"][number]) => ({
        items: [
            { key: "clone", label: "复制" },
            { key: "delete", danger: true, label: "删除" },
        ],
        onClick: ({ key }: { key: string }) => {
            if (key === "clone") void onCloneSave(player.id, account.id)
            if (key === "delete") {
                Modal.confirm({
                    title: `删除存档 ${player.id}？`,
                    okText: "确认",
                    cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: () => onDeleteSave(player.id),
                })
            }
        },
    })

    // 账号备注行内编辑（卡头「点击可修改」）: 编辑态为紧凑输入+确定/取消, 流程与桌面一致
    const renderNote = (account: AccountRow) =>
        noteEditId === account.id ? (
            <div className="admin-edit-compact">
                <Input
                    size="small"
                    autoFocus
                    value={noteDraft}
                    maxLength={64}
                    placeholder="账号备注"
                    onChange={event => setNoteDraft(event.target.value)}
                    onPressEnter={() => void submitNote(account.id)}
                    style={{ width: 110 }}
                />
                <Button size="small" type="primary" loading={noteSaving} onClick={() => void submitNote(account.id)}>确定</Button>
                <Button size="small" onClick={() => setNoteEditId(null)}>取消</Button>
            </div>
        ) : (
            <a
                className="acc-note acc-note-edit"
                title="修改账号备注"
                onClick={() => { setNoteEditId(account.id); setNoteDraft(account.adminNote ?? "") }}
            >
                {account.adminNote ?? "添加备注"}
                <Pencil size={12} className="acc-note-pencil" />
            </a>
        )

    // 存档子卡: 头像+名字+#存档id+meta + 右端 当前/切换合体标识; 编辑(占主)+[…](复制/删除)
    const renderSaveSub = (account: AccountRow, player: AccountRow["players"][number]) => (
        <div
            className="save-sub admin-mobile-list-item-clickable"
            key={player.id}
            onClick={event => {
                // 仅点卡片本体(空白)进详情
                if (event.target !== event.currentTarget) return
                onOpenPlayer(player.id)
            }}
        >
            <div className="save-head">
                <FavoriteAvatar characterId={player.favoriteCharacterId} name={player.name} />
                <span className="save-info">
                    <span className="save-name-line">
                        <span className="save-name">{player.name}</span>
                        <span className="save-id admin-mono">#存档 {player.id}</span>
                    </span>
                    <span className="save-meta">Lv {player.rank} · {player.characterCount} 角色</span>
                </span>
            </div>
            <div className="admin-mobile-actions admin-account-actions" onClick={event => event.stopPropagation()}>
                {/* 当前/切换合体标识在编辑按钮前(维护者指定); 当前=按钮同高的绿徽章 */}
                {player.isDefault
                    ? <Button disabled className="save-current-btn">当前</Button>
                    : (
                        <Button
                            aria-label="切换存档"
                            onClick={() => void onActivateSave(player.id)}
                        >切换</Button>
                    )}
                <Button className="act-edit" icon={<Pencil size={15} />} aria-label="编辑存档" onClick={() => onOpenPlayer(player.id)}>编辑</Button>
                <Dropdown menu={saveMoreMenu(account, player)} trigger={["click"]} placement="bottomRight">
                    <Button className="admin-more-btn" aria-label="更多操作">…</Button>
                </Dropdown>
            </div>
        </div>
    )

    // 账号卡（每账号一张真卡片）: 标题行=账号#id+当前存档名+备注+新建存档(右);
    // 内部=当前存档(头像+名) / 绑定设备 / 存档数N+[…]; 展开平铺存档子卡
    return (
        <div className="admin-account-mobile-list">
            {loading ? (
                <Typography.Text type="secondary">加载中...</Typography.Text>
            ) : accounts.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账号" />
            ) : (
                accounts.map(account => {
                    const expanded = selectedAccountId === account.id
                    return (
                        <div
                            className="acc-card"
                            key={account.id}
                            onClick={event => {
                                // 仅点卡片本体(空白)展开存档列表
                                if (event.target !== event.currentTarget) return
                                onSelectAccount(account.id)
                            }}
                        >
                            <div className="acc-titlebar">
                                <span className="acc-id-chip admin-mono">账号 #{account.id}</span>
                                <span className="acc-title-name">{account.defaultPlayerName ?? "无存档"}</span>
                                {renderNote(account)}
                                <span className="acc-actions">
                                    <Button type="primary" icon={<Plus size={14} />} onClick={() => void onNewSave(account.id)}>新建存档</Button>
                                </span>
                            </div>
                            <div className="acc-identity">
                                <FavoriteAvatar
                                    characterId={defaultPlayerAvatarId(account)}
                                    name={account.defaultPlayerName ?? `#${account.id}`}
                                />
                                <span className="acc-identity-info">
                                    <span className="acc-identity-name">{account.defaultPlayerName ?? "无存档"}</span>
                                    <span className="acc-identity-meta">
                                        {account.defaultPlayerId !== null && <span className="admin-mono">#存档 {account.defaultPlayerId} · </span>}
                                        绑定设备 {account.devices.length === 0 ? "无" : account.devices.map(device => device.deviceId).join(", ")}
                                    </span>
                                </span>
                            </div>
                            <div className="acc-bottom-row">
                                <Button
                                    className="acc-count-toggle"
                                    aria-expanded={expanded}
                                    onClick={() => onSelectAccount(account.id)}
                                >
                                    存档数 {account.players.length} {expanded ? "▴" : "▾"}
                                </Button>
                                <Dropdown menu={moreActionsMenu(account.id)} trigger={["click"]} placement="bottomRight">
                                    <Button className="admin-more-btn" aria-label="更多操作">…</Button>
                                </Dropdown>
                            </div>
                            {expanded && (
                                <div className="acc-save-list">
                                    {account.players.length === 0
                                        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无存档" />
                                        : account.players.map(player => renderSaveSub(account, player))}
                                </div>
                            )}
                        </div>
                    )
                })
            )}
        </div>
    )
}
