import { useState } from "react"
import { Card, Button, Space, Popconfirm, Input, Dropdown, Modal, message, Grid, Typography } from "antd"
import { PlusOutlined, EditOutlined, ReloadOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost, apiDownloadFile } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { AccountsMobileView } from "./accounts/AccountsMobileView"
import { FavoriteAvatar, defaultPlayerAvatarId } from "./accounts/FavoriteAvatar"
import type { AccountRow, DeviceBinding, PlayerBrief } from "./accounts/types"

const { useBreakpoint } = Grid

export default function Accounts() {
    const qc = useQueryClient()
    const navigate = useNavigate()
    const screens = useBreakpoint()
    const isMobile = !screens.md
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
    const [renameId, setRenameId] = useState<number | null>(null)
    const [renameName, setRenameName] = useState("")
    const [noteEditId, setNoteEditId] = useState<number | null>(null)
    const [noteDraft, setNoteDraft] = useState("")

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

    // 「…」更多操作菜单（mockup .more-btn）: 删除收进菜单, 点选仍弹原样确认
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

    const renameSave = useMutation({
        mutationFn: ({ playerId, name }: { playerId: number; name: string }) =>
            apiPost("/api/server/renameSave", { playerId, name }),
        onSuccess: () => { message.success("已改名"); setRenameId(null); refresh() },
        onError: showMutationError,
    })

    const cloneSave = useMutation({
        mutationFn: ({ playerId, accountId }: { playerId: number; accountId: number }) =>
            apiPost(`/api/server/cloneSave?playerId=${playerId}&accountId=${accountId}`),
        onSuccess: () => { message.success("存档已复制"); refresh() },
        onError: showMutationError,
    })

    // 账号备注行内编辑（mockup 卡头「点击可修改」）: 复用账号清理接口的备注位,
    // note 空串由服务端归一为 null
    const updateNote = useMutation({
        mutationFn: ({ accountId, note }: { accountId: number; note: string }) =>
            apiPost("/api/server/accountCleanup/account", { accountId, note }),
        onSuccess: () => { message.success("备注已更新"); setNoteEditId(null); refresh() },
        onError: showMutationError,
    })

    const exportSave = useMutation({
        mutationFn: (playerId: number) => apiDownloadFile(`/api/player/save?id=${playerId}`, `save_${playerId}.json`),
        onSuccess: () => { message.success("存档已导出") },
        onError: showMutationError,
    })

    // 账号备注（mockup 卡头灰字, 点击行内修改; 设备码不可修改, 与备注是两个概念）
    const renderNote = (account: AccountRow) =>
        noteEditId === account.id ? (
            <div
                className="admin-edit-compact"
                onClick={event => event.stopPropagation()}
                onKeyDown={event => event.stopPropagation()}
            >
                <Input
                    size="small"
                    value={noteDraft}
                    maxLength={64}
                    placeholder="账号备注"
                    onChange={event => setNoteDraft(event.target.value)}
                    onPressEnter={() => updateNote.mutate({ accountId: account.id, note: noteDraft })}
                    style={{ width: 120 }}
                />
                <Button
                    size="small"
                    type="primary"
                    loading={updateNote.isPending}
                    onClick={() => updateNote.mutate({ accountId: account.id, note: noteDraft })}
                >确定</Button>
                <Button size="small" onClick={() => setNoteEditId(null)}>取消</Button>
            </div>
        ) : (
            <a
                className="acc-note acc-note-edit"
                title="修改账号备注"
                onClick={() => { setNoteEditId(account.id); setNoteDraft(account.adminNote ?? "") }}
            >
                {account.adminNote ?? "添加备注"}
                <EditOutlined className="acc-note-pencil" />
            </a>
        )

    // 绑定设备: 真实设备码 mono 只读展示（mockup 规格: 不可修改, 与账号备注是两个概念）
    const renderDevices = (devices: DeviceBinding[]) =>
        devices.length === 0
            ? "无"
            : devices.map(device => <span className="acc-dev-code" key={device.deviceId}>{device.deviceId}</span>)

    // 存档子卡（mockup .save-sub）: 第一行 头像+名字+当前存档徽标+meta+右端「切换」,
    // 第二行 编辑·复制·导出·删除（左对齐; mockup .save-ops2）
    const renderSaveSub = (account: AccountRow, player: PlayerBrief) => (
        <div className="save-sub" key={player.id}>
            <div className="save-head">
                <FavoriteAvatar characterId={player.favoriteCharacterId} name={player.name} />
                {renameId === player.id ? (
                    <div
                        className="admin-edit-compact"
                        onClick={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}
                    >
                        <Input size="small" value={renameName} onChange={e => setRenameName(e.target.value)} onPressEnter={() => renameSave.mutate({ playerId: player.id, name: renameName })} style={{ width: 100 }} />
                        <Button size="small" type="primary" onClick={() => renameSave.mutate({ playerId: player.id, name: renameName })}>确定</Button>
                        <Button size="small" onClick={() => setRenameId(null)}>取消</Button>
                    </div>
                ) : (
                    <>
                        <a className="admin-save-link save-name" title="进入玩家详情(存档页)" onClick={() => navigate(`/players/${player.id}`)}>{player.name}</a>
                        <Button
                            type="text"
                            size="small"
                            title="重命名存档"
                            icon={<EditOutlined />}
                            onClick={() => { setRenameId(player.id); setRenameName(player.name) }}
                        />
                    </>
                )}
                {player.isDefault && <span className="admin-badge-ok">当前存档</span>}
                <span className="save-meta">Lv {player.rank} · {player.characterCount} 角色</span>
                <span className="save-ops">
                    {/* activateSave 服务端同时把该存档设为账号的当前存档与全局活动存档，故仅 isDefault 时禁用 */}
                    <Button disabled={player.isDefault} onClick={() => activateSave.mutate(player.id)}>
                        切换
                    </Button>
                </span>
            </div>
            <div className="save-ops2">
                <Button icon={<EditOutlined />} onClick={() => navigate(`/players/${player.id}`)}>
                    编辑
                </Button>
                <Button onClick={() => cloneSave.mutate({ playerId: player.id, accountId: account.id })}>
                    复制
                </Button>
                <Button
                    loading={exportSave.isPending && exportSave.variables === player.id}
                    onClick={() => exportSave.mutate(player.id)}
                >
                    导出
                </Button>
                <Popconfirm title={`删除存档 ${player.id}？`} onConfirm={() => deleteSave.mutate(player.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                    <Button type="text" danger>删除</Button>
                </Popconfirm>
            </div>
        </div>
    )

    // 账号卡（mockup .acc-card）: 卡头(头像+存档名作卡名+备注+存档列表▾/…)+ kv 行 + 内嵌存档子卡区
    const renderAccountCard = (account: AccountRow) => {
        const expanded = selectedAccountId === account.id
        return (
            <div className="acc-card" key={account.id}>
                <div className="acc-top">
                    <FavoriteAvatar
                        characterId={defaultPlayerAvatarId(account)}
                        name={account.defaultPlayerName ?? `#${account.id}`}
                    />
                    <span className="acc-id">{account.defaultPlayerName ?? `账号 #${account.id}`}</span>
                    {renderNote(account)}
                    <span className="acc-actions">
                        <Dropdown menu={moreActionsMenu(account.id)} trigger={["click"]} placement="bottomRight">
                            <Button className="admin-more-btn" aria-label="更多操作">…</Button>
                        </Dropdown>
                    </span>
                </div>
                <div className="acc-kv">
                    <span className="acc-k">当前存档</span>
                    <span className="acc-v">
                        {account.defaultPlayerId ? (
                            <span className="acc-kv-name">{account.defaultPlayerName ?? `#${account.defaultPlayerId}`}</span>
                        ) : "无"}
                    </span>
                    <span className="acc-k">绑定设备</span>
                    {/* 存档数切换钮挂最下一排行尾（维护者指定）: 卡头长备注折行不再挤压它 */}
                    <span className="acc-v acc-devices">
                        {renderDevices(account.devices)}
                        <Button className="acc-save-toggle" aria-expanded={expanded} onClick={() => toggleSavePanel(account.id)}>
                            存档数 {account.players.length} {expanded ? "▴" : "▾"}
                        </Button>
                    </span>
                </div>
                {expanded && (
                    <div className="acc-save-list">
                        {account.players.length === 0
                            ? <Typography.Text type="secondary">暂无存档</Typography.Text>
                            : account.players.map(player => renderSaveSub(account, player))}
                        {/* 新建存档垫在列表末尾（维护者指定）: 「N 个存档」徽标与存档数表达重复, 已删 */}
                        <div className="acc-save-new">
                            <Button icon={<PlusOutlined />} onClick={() => newSave.mutate(account.id)}>新建存档</Button>
                        </div>
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
            actions={
                <Button icon={<ReloadOutlined />} loading={isFetching} onClick={refresh}>
                    刷新
                </Button>
            }
        >
        <Space direction="vertical" size="large" className="admin-stack">
            <div className="admin-page-note">
                <Typography.Text strong>选档状态说明</Typography.Text>
                <Typography.Text type="secondary">
                    新建和复制存档会设为该账号当前存档并切换为当前活动；删除当前存档后，服务端会在该账号剩余存档中回退到第一个可用存档。删除最后一个存档会同时删除账号。
                </Typography.Text>
            </div>
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
        </Space>
        </AdminPage>
    )
}
