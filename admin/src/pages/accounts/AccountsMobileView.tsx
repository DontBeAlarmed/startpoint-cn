import { useState } from "react"
import {
    Button,
    Dropdown,
    Empty,
    Input,
    List,
    Modal,
    Popconfirm,
    Typography,
} from "antd"
import { ArrowLeftRight, Copy, Pencil, Plus, Trash2 } from "lucide-react"

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

    // 「…」更多操作菜单（与桌面同构）: 删除收进菜单, 点选仍弹原样确认
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

    // 账号备注行内编辑（mockup 卡头「点击可修改」）: 编辑态为紧凑输入+确定/取消,
    // 流程与桌面 renderNote 一致
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

    // 存档子卡（mockup .save-sub 移动形态）: 第一行 头像+名字+当前存档徽标+右端「切换」,
    // 第二行 meta, 操作行 编辑·复制·删除（icon+文字, 维护者 2026-09-29 第五轮指定）;
    // 整卡可点进玩家详情, 操作区 stopPropagation（照既有移动存档行惯例）
    const renderSaveSub = (account: AccountRow, player: AccountRow["players"][number]) => (
        <div
            className="save-sub admin-mobile-list-item-clickable"
            key={player.id}
            onClick={() => onOpenPlayer(player.id)}
        >
            <div className="save-head">
                <FavoriteAvatar characterId={player.favoriteCharacterId} name={player.name} />
                <span className="save-name">{player.name}</span>
                {player.isDefault && <span className="admin-badge-ok">当前存档</span>}
                <span className="save-ops">
                    {/* activateSave 服务端同时把该存档设为账号的当前存档与全局活动存档，故仅 isDefault 时禁用 */}
                    <Button
                        icon={<ArrowLeftRight size={15} />}
                        aria-label="切换存档"
                        disabled={player.isDefault}
                        onClick={event => {
                            event.stopPropagation()
                            void onActivateSave(player.id)
                        }}
                    >切换</Button>
                </span>
            </div>
            <div className="save-meta">Lv {player.rank} · {player.characterCount} 角色</div>
            <div className="admin-mobile-actions" onClick={event => event.stopPropagation()}>
                <Button icon={<Pencil size={15} />} aria-label="编辑存档" onClick={() => onOpenPlayer(player.id)}>编辑</Button>
                <Button icon={<Copy size={15} />} aria-label="复制存档" onClick={() => void onCloneSave(player.id, account.id)}>复制</Button>
                <Popconfirm
                    title={`删除存档 ${player.id}？`}
                    okText="确认"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => void onDeleteSave(player.id)}
                >
                    <Button danger icon={<Trash2 size={15} />} aria-label={`删除存档 ${player.id}`}>删除</Button>
                </Popconfirm>
            </div>
        </div>
    )

    return (
        <div className="admin-account-mobile-list">
            <List
                loading={loading}
                dataSource={[...accounts]}
                locale={{ emptyText: "暂无账号" }}
                renderItem={account => {
                    const expanded = selectedAccountId === account.id
                    return (
                        <List.Item className="admin-mobile-list-item">
                            <div className="admin-mobile-list-content">
                                <div className="admin-mobile-list-heading">
                                    <span className="admin-mobile-heading-main">
                                        <FavoriteAvatar
                                            characterId={defaultPlayerAvatarId(account)}
                                            name={account.defaultPlayerName ?? `#${account.id}`}
                                        />
                                        <Typography.Text strong className="acc-id">
                                            {account.defaultPlayerName ?? `账号 #${account.id}`}
                                        </Typography.Text>
                                        {renderNote(account)}
                                    </span>
                                    <span className="acc-actions">
                                        <Dropdown menu={moreActionsMenu(account.id)} trigger={["click"]} placement="bottomRight">
                                            <Button className="admin-more-btn" aria-label="更多操作">…</Button>
                                        </Dropdown>
                                    </span>
                                </div>
                                <div className="admin-mobile-detail-list">
                                    <div>
                                        <span>当前存档</span>
                                        <span className="acc-kv-value">
                                            <strong>{account.defaultPlayerName ?? "无"}</strong>
                                        </span>
                                    </div>
                                    <div>
                                        <span>绑定设备</span>
                                        <span className="acc-kv-value acc-devices">
                                            {account.devices.length === 0
                                                ? "无"
                                                : account.devices.map(device => (
                                                    <span className="acc-dev-code" key={device.deviceId}>{device.deviceId}</span>
                                                ))}
                                        </span>
                                    </div>
                                    {/* 存档数切换钮独立整行左右撑满（与桌面同构） */}
                                    <div className="acc-save-row">
                                        <Button block className="acc-save-toggle" aria-expanded={expanded} onClick={() => onSelectAccount(account.id)}>
                                            存档数 {account.players.length} {expanded ? "▴" : "▾"}
                                        </Button>
                                    </div>
                                </div>
                                {expanded && (
                                    <div className="acc-save-list">
                                        {account.players.length === 0
                                            ? <Empty description="暂无存档" />
                                            : account.players.map(player => renderSaveSub(account, player))}
                                        {/* 新建存档垫在列表末尾（与桌面同构） */}
                                        <div className="acc-save-new">
                                            <Button type="primary" icon={<Plus size={15} />} onClick={() => void onNewSave(account.id)}>新建存档</Button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </List.Item>
                    )
                }}
            />
        </div>
    )
}
