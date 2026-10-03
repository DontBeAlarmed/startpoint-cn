import { useEffect, useRef, useState } from "react"
import { Card, Button, Space, Popconfirm, Input, message, Grid, Typography } from "antd"
import { PlusOutlined, EditOutlined, ReloadOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost, apiDownloadFile } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { AccountsMobileView } from "./accounts/AccountsMobileView"
import { FavoriteAvatar } from "./accounts/FavoriteAvatar"
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
    const [renameDeviceId, setRenameDeviceId] = useState<number | null>(null)
    const [renameDeviceName, setRenameDeviceName] = useState("")
    const savePanelRef = useRef<HTMLDivElement | null>(null)

    // 存档子卡嵌在账号卡内部展开（mockup accounts-nested-saves）: 展开/切换滚动嵌套区到位, 收起不动
    useEffect(() => {
        if (selectedAccountId !== null) savePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, [selectedAccountId])

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

    // 移动端备注区域 2026-09-29 经维护者指示移除（H2，与设备名 pill 功能重叠）；
    // updateNote mutation 原样保留（复用账号清理接口的备注位，note 空串由服务端归一为 null），桌面未来可接 UI
    const updateNote = useMutation({
        mutationFn: ({ accountId, note }: { accountId: number; note: string }) =>
            apiPost("/api/server/accountCleanup/account", { accountId, note }),
        onSuccess: () => { message.success("备注已更新"); refresh() },
        onError: showMutationError,
    })
    // 保留读取以满足 noUnusedLocals：备注 UI 已移除但 mutation 需留存（见上注释）
    void updateNote

    const renameDevice = useMutation({
        mutationFn: ({ deviceId, name }: { deviceId: number; name: string }) =>
            apiPost<{ ok: boolean; deviceId: number; name: string | null }>(
                "/api/server/device/rename",
                { deviceId, name },
            ),
        onSuccess: ({ name }) => {
            message.success(name === null ? "设备名称已清除" : "设备名称已更新")
            setRenameDeviceId(null)
            refresh()
        },
        onError: showMutationError,
    })

    const exportSave = useMutation({
        mutationFn: (playerId: number) => apiDownloadFile(`/api/player/save?id=${playerId}`, `save_${playerId}.json`),
        onSuccess: () => { message.success("存档已导出") },
        onError: showMutationError,
    })

    // 绑定设备 pill（含行内改名编辑器）：桌面在账号卡 kv 行内联展开，流程与移动端一致
    const renderDeviceEditor = (device: DeviceBinding) =>
        renameDeviceId === device.deviceId ? (
            <div className="admin-edit-compact" key={device.deviceId}>
                <Input
                    size="small"
                    value={renameDeviceName}
                    maxLength={64}
                    placeholder={`设备 ${device.deviceId}`}
                    onChange={event => setRenameDeviceName(event.target.value)}
                    onPressEnter={() => renameDevice.mutate({
                        deviceId: device.deviceId,
                        name: renameDeviceName,
                    })}
                    style={{ width: 120 }}
                />
                <Button
                    size="small"
                    type="primary"
                    loading={renameDevice.isPending}
                    onClick={() => renameDevice.mutate({
                        deviceId: device.deviceId,
                        name: renameDeviceName,
                    })}
                >确定</Button>
                <Button size="small" onClick={() => setRenameDeviceId(null)}>取消</Button>
            </div>
        ) : (
            <span className="admin-dev-edit" key={device.deviceId}>
                <span className="admin-dev-edit-name">{device.name ?? `设备 ${device.deviceId}`}</span>
                <Button
                    type="text"
                    size="small"
                    title="修改设备名称"
                    icon={<EditOutlined />}
                    onClick={() => {
                        setRenameDeviceId(device.deviceId)
                        setRenameDeviceName(device.name ?? "")
                    }}
                />
            </span>
        )

    // 存档子卡（mockup .save-sub）: 喜爱角色头像 + 存档名 + 当前存档徽章 + Lv/角色数 + 右侧操作
    const renderSaveSub = (player: PlayerBrief) => (
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
                    <Button size="small" disabled={player.isDefault} onClick={() => activateSave.mutate(player.id)}>
                        切换
                    </Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/players/${player.id}`)}>
                        编辑
                    </Button>
                    <Button
                        size="small"
                        loading={exportSave.isPending && exportSave.variables === player.id}
                        onClick={() => exportSave.mutate(player.id)}
                    >
                        导出
                    </Button>
                    <Popconfirm title={`删除存档 ${player.id}？`} onConfirm={() => deleteSave.mutate(player.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" type="text" danger>删除</Button>
                    </Popconfirm>
                </span>
            </div>
        </div>
    )

    // 账号卡（mockup .acc-card）: 卡头 + kv 行 + 内嵌存档子卡区
    const renderAccountCard = (account: AccountRow) => {
        const expanded = selectedAccountId === account.id
        return (
            <div className="acc-card" key={account.id}>
                <div className="acc-top">
                    <span className="acc-id">账号 #{account.id}</span>
                    {account.adminNote && <span className="acc-note">{account.adminNote}</span>}
                    <span className="acc-actions">
                        <Button size="small" aria-expanded={expanded} onClick={() => toggleSavePanel(account.id)}>
                            存档列表 {expanded ? "▴" : "▾"}
                        </Button>
                        <Popconfirm title={`删除账号 ${account.id} 及所有存档？`} onConfirm={() => deleteAccount.mutate(account.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                            <Button size="small" type="text" danger>删除</Button>
                        </Popconfirm>
                    </span>
                </div>
                <div className="acc-kv">
                    <span className="acc-k">当前存档</span>
                    <span className="acc-v">
                        {account.defaultPlayerId ? (
                            <>
                                <span className="acc-kv-name">{account.defaultPlayerName ?? `#${account.defaultPlayerId}`}</span>
                                <span className="admin-badge-ok">当前存档</span>
                            </>
                        ) : "无"}
                    </span>
                    <span className="acc-k">绑定设备</span>
                    <span className="acc-v acc-devices">
                        {account.devices.length === 0 ? "无" : account.devices.map(renderDeviceEditor)}
                    </span>
                </div>
                {expanded && (
                    <div className="acc-save-list" ref={savePanelRef}>
                        <div className="acc-save-toolbar">
                            <span className="admin-badge-info">{account.players.length} 个存档</span>
                            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => newSave.mutate(account.id)}>新建存档</Button>
                        </div>
                        {account.players.length === 0
                            ? <Typography.Text type="secondary">暂无存档</Typography.Text>
                            : account.players.map(renderSaveSub)}
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
                        onRenameDevice={(deviceId, name) => renameDevice.mutateAsync({ deviceId, name })}
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
