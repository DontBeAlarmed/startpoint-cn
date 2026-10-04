import { useState } from "react"
import { Card, Button, Space, Dropdown, Modal, message, Grid, Typography } from "antd"
import { PlusOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost, apiDownloadFile } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { AccountsMobileView } from "./accounts/AccountsMobileView"
import { FavoriteAvatar, defaultPlayerAvatarId } from "./accounts/FavoriteAvatar"
import type { AccountRow, PlayerBrief } from "./accounts/types"

const { useBreakpoint } = Grid

export default function Accounts() {
    const qc = useQueryClient()
    const navigate = useNavigate()
    const screens = useBreakpoint()
    const isMobile = !screens.md
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
    const [noteEditId, setNoteEditId] = useState<number | null>(null)
    const [noteDraft, setNoteDraft] = useState("")
    const [noteOriginal, setNoteOriginal] = useState("")

    const { data: accounts = [], isLoading, isFetching } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
    }
    // 单开嵌套区: 同一卡头按钮切换展开/收起, 另一张卡切换展开区
    const toggleSavePanel = (accountId: number) => {
        setSelectedAccountId(current => (current === accountId ? null : accountId))
    }
    const showMutationError = (error: Error) => message.error(error.message)

    const activateSave = useMutation({
        mutationFn: (playerId: number) => apiPost("/api/server/activateSave?playerId=" + playerId),
        onSuccess: () => { message.success("已切换生效存档"); refresh() },
        onError: showMutationError,
    })

    const newSave = useMutation({
        mutationFn: (accountId: number) => apiPost("/api/server/newSave?accountId=" + accountId),
        onSuccess: () => { message.success("新存档已创建"); refresh() },
        onError: showMutationError,
    })

    const deleteSave = useMutation({
        mutationFn: (playerId: number) => apiPost("/api/server/deleteSave?playerId=" + playerId),
        onSuccess: () => { message.success("存档已删除"); refresh() },
        onError: showMutationError,
    })

    const deleteAccount = useMutation({
        mutationFn: (id: number) => apiPost("/api/server/deleteAccount?id=" + id),
        onSuccess: () => {
            message.success("账号已删除")
            if (selectedAccountId === (deleteAccount.variables as number)) setSelectedAccountId(null)
            refresh()
        },
        onError: showMutationError,
    })

    const cloneSave = useMutation({
        mutationFn: ({ playerId, accountId }: { playerId: number; accountId: number }) =>
            apiPost(`/api/server/cloneSave?playerId=${playerId}&accountId=${accountId}`),
        onSuccess: () => { message.success("存档已复制"); refresh() },
        onError: showMutationError,
    })

    // 账号备注行内编辑（卡头「点击可修改」）: 复用账号清理接口的备注位,
    // note 空串由服务端归一为 null。onSuccess 只提示+刷新, 关编辑态由 commitNote
    // 按账号守卫(防止保存期间用户已打开另一张卡的编辑态被误关)
    const updateNote = useMutation({
        mutationFn: ({ accountId, note }: { accountId: number; note: string }) =>
            apiPost("/api/server/accountCleanup/account", { accountId, note }),
        onSuccess: () => { message.success("备注已更新"); refresh() },
        onError: showMutationError,
    })

    const exportSave = useMutation({
        mutationFn: (playerId: number) => apiDownloadFile(`/api/player/save?id=${playerId}`, `save_${playerId}.json`),
        onSuccess: () => { message.success("存档已导出") },
        onError: showMutationError,
    })

    // 账号级「…」菜单: 删除账号(原样确认)
    const confirmDeleteAccount = (accountId: number) => {
        Modal.confirm({
            title: `删除账号 ${accountId} 及所有存档？`,
            okText: "确认",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => deleteAccount.mutateAsync(accountId),
        })
    }

    const moreActionsMenu = (accountId: number) => ({
        items: [{ key: "delete-account", danger: true, label: "删除账号" }],
        onClick: ({ key }: { key: string }) => {
            if (key === "delete-account") confirmDeleteAccount(accountId)
        },
    })

    // 存档级「…」菜单: 复制/导出/删除(维护者指定: 收进菜单, 编辑按钮独立)
    const saveMoreMenu = (account: AccountRow, player: PlayerBrief) => ({
        items: [
            { key: "clone", label: "复制" },
            { key: "export", label: "导出" },
            // 单存档账号不可删存档(维护者指定): 只能走显式的删除账号, 破坏性与按钮语义对齐
            {
                key: "delete",
                danger: true,
                label: account.players.length <= 1 ? "删除（账号仅剩这一个存档）" : "删除",
                disabled: account.players.length <= 1,
            },
        ],
        onClick: ({ key }: { key: string }) => {
            if (key === "clone") cloneSave.mutate({ playerId: player.id, accountId: account.id })
            if (key === "export") exportSave.mutate(player.id)
            if (key === "delete") {
                Modal.confirm({
                    title: `删除存档 ${player.id}？`,
                    okText: "确认",
                    cancelText: "取消",
                    okButtonProps: { danger: true },
                    onOk: () => deleteSave.mutateAsync(player.id),
                })
            }
        },
    })

    // 账号备注（卡头灰字, 点击行内修改; 设备码不可修改, 与备注是两个概念）
    // 编辑态规范（维护者指定）: 点击进入编辑态, input 样式与静态灰字完全一致,
    // 失焦保存(无确定/取消按钮), Enter 同保存, Escape 放弃
    const commitNote = (accountId: number) => {
        if (noteDraft === noteOriginal) { setNoteEditId(null); return }
        updateNote.mutate({ accountId, note: noteDraft }, {
            onSuccess: () => setNoteEditId(current => (current === accountId ? null : current)),
        })
    }

    const renderNote = (account: AccountRow) => {
        if (noteEditId !== account.id) {
            return (
                <a
                    className="acc-note acc-note-edit"
                    title="修改账号备注"
                    onClick={() => {
                        setNoteEditId(account.id)
                        setNoteOriginal(account.adminNote ?? "")
                        setNoteDraft(account.adminNote ?? "")
                    }}
                >
                    {account.adminNote ?? "添加备注"}
                </a>
            )
        }
        return (
            <input
                className="acc-note-input"
                value={noteDraft}
                maxLength={64}
                placeholder="账号备注"
                autoFocus
                onChange={event => setNoteDraft(event.target.value)}
                onBlur={() => commitNote(account.id)}
                onKeyDown={event => {
                    if (event.key === "Enter") commitNote(account.id)
                    if (event.key === "Escape") setNoteEditId(null)
                }}
            />
        )
    }

    // 存档子卡: 单行布局 — 头像+名字+#存档id+meta, 右端 当前/切换合体标识 + 编辑 + […]
    // (维护者指定: 行内重命名 pencil 移除, 重命名统一走玩家详情; 复制/导出/删除收进 […] 菜单)
    const renderSaveSub = (account: AccountRow, player: PlayerBrief) => (
        <div
            className="save-sub"
            key={player.id}
            onClick={event => {
                // 仅点卡片本体(空白)进详情; 点内部按钮不触发(target 判定, 防"点击穿透")
                if (event.target !== event.currentTarget) return
                navigate(`/players/${player.id}`)
            }}
        >
            <div className="save-head">
                <FavoriteAvatar characterId={player.favoriteCharacterId} name={player.name} />
                <span className="save-info">
                    <span className="save-name-line">
                        <a className="admin-save-link save-name" title="进入玩家详情(存档页)" onClick={() => navigate(`/players/${player.id}`)}>{player.name}</a>
                        <span className="save-id admin-mono">#存档 {player.id}</span>
                    </span>
                    <span className="save-meta">Lv {player.rank} · {player.characterCount} 角色</span>
                </span>
                {/* 当前存档标识与切换合体: 绿色「当前」常驻标识 / 非当前「切换」按钮 (activateSave 同置账号当前存档与全局活动) */}
                {player.isDefault
                    ? <Button className="save-current-btn" onClick={event => event.stopPropagation()}>当前</Button>
                    : <Button onClick={() => activateSave.mutate(player.id)}>切换</Button>}
                <Button onClick={() => navigate(`/players/${player.id}`)}>编辑</Button>
                <Dropdown menu={saveMoreMenu(account, player)} trigger={["click"]} placement="bottomRight">
                    <Button className="admin-more-btn" aria-label="更多操作">…</Button>
                </Dropdown>
            </div>
        </div>
    )

    // 账号卡: 双层结构 — 标题栏(账号#id+备注+新建存档居右) / 身份行(头像+名称+存档id+设备+存档数+…) / 内嵌存档子卡
    // (标题栏不放当前存档名: 名字在身份行已展示, 三处重复过于冗余 — 维护者指定)
    const renderAccountCard = (account: AccountRow) => {
        const expanded = selectedAccountId === account.id
        return (
            <div
                className="acc-card"
                key={account.id}
                onClick={event => {
                    // 仅点卡片本体(空白)展开存档列表
                    if (event.target !== event.currentTarget) return
                    toggleSavePanel(account.id)
                }}
            >
                <div className="acc-titlebar">
                    <span className="acc-id-chip admin-mono">账号 #{account.id}</span>
                    {renderNote(account)}
                    <span className="acc-actions">
                        <Button type="primary" icon={<PlusOutlined />} onClick={() => newSave.mutate(account.id)}>新建存档</Button>
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
                    <Button
                        className="acc-count-toggle"
                        aria-expanded={expanded}
                        onClick={() => toggleSavePanel(account.id)}
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
                            ? <Typography.Text type="secondary">暂无存档</Typography.Text>
                            : account.players.map(player => renderSaveSub(account, player))}
                    </div>
                )}
            </div>
        )
    }

    return (
        <AdminPage
            eyebrow="SAVES"
            title="账号 / 存档"
            description="查看账号与当前存档关系。账号当前存档决定该账号登录时选用哪个存档；当前活动存档只是管理端最近切换的全局状态。"
            onRefresh={refresh}
            refreshing={isFetching}
        >
        <Space direction="vertical" size="large" className="admin-stack">
            {isMobile ? (
                <Card title="账号管理" className="admin-mobile-list-card">
                    <AccountsMobileView
                        accounts={accounts}
                        selectedAccount={accounts.find(a => a.id === selectedAccountId)}
                        loading={isLoading}
                        onSelectAccount={toggleSavePanel}
                        onOpenPlayer={playerId => navigate(`/players/${playerId}`)}
                        onNewSave={accountId => newSave.mutateAsync(accountId)}
                        onDeleteAccount={accountId => deleteAccount.mutateAsync(accountId)}
                        onActivateSave={playerId => activateSave.mutateAsync(playerId)}
                        onCloneSave={(playerId, accountId) => cloneSave.mutateAsync({ playerId, accountId })}
                        onDeleteSave={playerId => deleteSave.mutateAsync(playerId)}
                        onUpdateNote={(accountId, note) => updateNote.mutateAsync({ accountId, note })}
                    />
                </Card>
            ) : (
                <Card title="账号管理" className="admin-table-card admin-accounts-card">
                    <div className="admin-acc-list">
                        {accounts.map(renderAccountCard)}
                    </div>
                </Card>
            )}
            <div className="admin-page-note admin-page-note-footer">
                <Typography.Text strong>选档状态说明</Typography.Text>
                <Typography.Text type="secondary">
                    新建和复制存档会设为该账号当前存档并切换为当前活动；删除当前存档后，服务端会在该账号剩余存档中回退到第一个可用存档。账号仅剩一个存档时不可删除存档，请使用删除账号。
                </Typography.Text>
            </div>
        </Space>
        </AdminPage>
    )
}
