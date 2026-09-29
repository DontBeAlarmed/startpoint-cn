import { useEffect, useRef, useState } from "react"
import { Card, Table, Button, Space, Popconfirm, Input, message, Tag, Grid, Tooltip, Typography } from "antd"
import { PlusOutlined, EditOutlined, InfoCircleOutlined, ReloadOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost, apiDownloadFile } from "../api/client"
import { AdminPage } from "../components/AdminPage"
import { AccountsMobileView } from "./accounts/AccountsMobileView"
import type { AccountRow, PlayerBrief } from "./accounts/types"

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

    // inline save panel (mockup accounts-v2-review): the account table stays visible and the
    // panel expands below it — open/switch scrolls the panel into view, collapse does not
    useEffect(() => {
        if (selectedAccountId !== null) savePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, [selectedAccountId])

    const { data: accounts = [], isLoading, isFetching } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const selectedAccount = accounts.find(a => a.id === selectedAccountId)
    const savePlayers = selectedAccount?.players ?? []

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
    }
    // single-open inline panel: same row button toggles, another row switches the panel
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

    const accountColumns = [
        {
            title: (
                <Space size={4}>
                    ID
                    <Tooltip title="账号 ID:账号表主键,一个账号可包含多个存档">
                        <InfoCircleOutlined style={{ color: "var(--ink-soft)" }} />
                    </Tooltip>
                </Space>
            ),
            dataIndex: "id", width: "8%", align: "center" as const,
        },
        { title: "存档数", dataIndex: "saveCount", width: "10%", align: "center" as const },
        {
            title: "默认存档", width: "32%", align: "center" as const,
            render: (_: unknown, row: AccountRow) => {
                if (!row.defaultPlayerId) return <Tag>无</Tag>
                return <span>{row.defaultPlayerName ?? `#${row.defaultPlayerId}`}</span>
            },
        },
        {
            title: (
                <Space size={4}>
                    绑定设备
                    <Tooltip title="设备绑定:登录设备与账号的自动绑定关系;显示设备识别名,点击铅笔图标可修改设备备注名">
                        <InfoCircleOutlined style={{ color: "var(--ink-soft)" }} />
                    </Tooltip>
                </Space>
            ),
            width: "26%", align: "center" as const,
            render: (_: unknown, row: AccountRow) => row.devices.length === 0 ? <Tag>无</Tag> : (
                <Space direction="vertical" size={4}>
                    {row.devices.map(device => renameDeviceId === device.deviceId ? (
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
                    ))}
                </Space>
            ),
        },
        {
            title: "操作", width: "24%", align: "center" as const,
            render: (_: unknown, row: AccountRow) => (
                <div className="admin-action-row">
                    <Button size="small" type="primary" onClick={() => toggleSavePanel(row.id)}>存档列表</Button>
                    <Popconfirm title={`删除账号 ${row.id} 及所有存档？`} onConfirm={() => deleteAccount.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" type="text" danger>删除</Button>
                    </Popconfirm>
                </div>
            ),
        },
    ]

    const saveColumns = [
        { title: "存档 ID", dataIndex: "id", width: "8%", align: "center" as const },
        {
            title: "存档名", width: "30%", align: "center" as const,
            render: (_: unknown, row: PlayerBrief) => renameId === row.id ? (
                <div
                    className="admin-edit-compact"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                >
                    <Input size="small" value={renameName} onChange={e => setRenameName(e.target.value)} onPressEnter={() => renameSave.mutate({ playerId: row.id, name: renameName })} style={{ width: 100 }} />
                    <Button size="small" type="primary" onClick={() => renameSave.mutate({ playerId: row.id, name: renameName })}>确定</Button>
                    <Button size="small" onClick={() => setRenameId(null)}>取消</Button>
                </div>
            ) : (
                <Space size={4} onClick={event => event.stopPropagation()}>
                    <a className="admin-save-link" title="进入玩家详情(存档页)" onClick={() => navigate(`/players/${row.id}`)}>{row.name}</a>
                    <Button
                        type="text"
                        size="small"
                        title="重命名存档"
                        icon={<EditOutlined />}
                        onClick={() => { setRenameId(row.id); setRenameName(row.name) }}
                    />
                    {row.isActive && <span className="admin-badge-ok">当前活动</span>}
                </Space>
            ),
        },
        { title: "等级", width: "8%", align: "center" as const, render: (_: unknown, row: PlayerBrief) => row.rank },
        { title: "角色数", width: "10%", align: "center" as const, render: (_: unknown, row: PlayerBrief) => row.characterCount ?? "—" },
        { title: "最后登录", width: "22%", align: "center" as const, render: (_: unknown, row: PlayerBrief) => row.lastLoginTime ? row.lastLoginTime.replace("T", " ").slice(0, 16) : "—" },
        {
            title: "操作", width: "22%", align: "center" as const,
            render: (_: unknown, row: PlayerBrief) => (
                <div className="admin-action-row" onClick={event => event.stopPropagation()}>
                    <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/players/${row.id}`)}>
                        编辑
                    </Button>
                    <Button size="small" disabled={row.isDefault && row.isActive} onClick={() => activateSave.mutate(row.id)}>
                        切换
                    </Button>
                    <Button
                        size="small"
                        loading={exportSave.isPending && exportSave.variables === row.id}
                        onClick={() => exportSave.mutate(row.id)}
                    >
                        导出
                    </Button>
                    <Popconfirm title={`删除存档 ${row.id}？`} onConfirm={() => deleteSave.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" type="text" danger>删除</Button>
                    </Popconfirm>
                </div>
            ),
        },
    ]

    return (
        <AdminPage
            eyebrow="SAVES"
            title="账号 / 存档"
            description="查看账号与默认存档关系。账号默认存档决定该账号登录时选用哪个存档；当前活动存档只是管理端最近切换的全局状态。"
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
                    新建和复制存档会设为该账号默认并切换为当前活动；删除默认存档后，服务端会在该账号剩余存档中回退到第一个可用存档。删除最后一个存档会同时删除账号。
                </Typography.Text>
            </div>
            {isMobile && (
                <Card title="账号管理" className="admin-mobile-list-card">
                    <AccountsMobileView
                        accounts={accounts}
                        selectedAccount={selectedAccount}
                        loading={isLoading}
                        renamePending={renameSave.isPending || renameDevice.isPending}
                        onSelectAccount={toggleSavePanel}
                        onOpenPlayer={playerId => navigate(`/players/${playerId}`)}
                        onNewSave={accountId => newSave.mutateAsync(accountId)}
                        onDeleteAccount={accountId => deleteAccount.mutateAsync(accountId)}
                        onActivateSave={playerId => activateSave.mutateAsync(playerId)}
                        onCloneSave={(playerId, accountId) => cloneSave.mutateAsync({ playerId, accountId })}
                        onDeleteSave={playerId => deleteSave.mutateAsync(playerId)}
                        onRenameSave={(playerId, name) => renameSave.mutateAsync({ playerId, name })}
                        onRenameDevice={(deviceId, name) => renameDevice.mutateAsync({ deviceId, name })}
                    />
                </Card>
            )}
            {!isMobile && (
                <Card title="账号管理" className="admin-table-card admin-accounts-card">
                    <Table
                        rowKey="id"
                        columns={accountColumns}
                        dataSource={accounts}
                        loading={isLoading}
                        pagination={false}
                        size="small"
                        scroll={{ x: 900 }}
                        className="admin-accounts-table"
                    />
                </Card>
            )}
            {!isMobile && selectedAccount && (
                <div ref={savePanelRef}>
                    <Card
                        title={`账号 ${selectedAccount.id} · 存档列表`}
                        className="admin-table-card admin-accounts-card"
                        extra={(
                            <Space wrap size={8}>
                                <span className="admin-badge-info">{savePlayers.length} 个存档</span>
                                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => newSave.mutate(selectedAccount.id)}>新建存档</Button>
                            </Space>
                        )}
                    >
                        <Table
                            rowKey="id"
                            columns={saveColumns}
                            dataSource={savePlayers}
                            pagination={false}
                            size="small"
                            scroll={{ x: 860 }}
                            className="admin-accounts-table"
                            locale={{ emptyText: "暂无存档" }}
                            onRow={row => ({
                                className: "admin-clickable-table-row",
                                onClick: () => navigate(`/players/${row.id}`),
                            })}
                        />
                    </Card>
                </div>
            )}

        </Space>
        </AdminPage>
    )
}
