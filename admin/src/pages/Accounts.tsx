import { useState } from "react"
import { Alert, Card, Table, Button, Space, Popconfirm, Input, message, Tag, Grid } from "antd"
import { PlusOutlined, CopyOutlined, DeleteOutlined, SwapOutlined, EditOutlined, LeftOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost } from "../api/client"
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

    const { data: accounts = [], isLoading } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const selectedAccount = accounts.find(a => a.id === selectedAccountId)
    const savePlayers = selectedAccount?.players ?? []

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
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

    const accountColumns = [
        { title: "ID", dataIndex: "id", width: 64 },
        { title: "存档数", dataIndex: "saveCount", width: 80, responsive: ["sm"] as any },
        {
            title: "默认存档", width: 180, responsive: ["md"] as any,
            render: (_: unknown, row: AccountRow) => {
                if (!row.defaultPlayerId) return <Tag>无</Tag>
                const isActive = row.activePlayerId === row.defaultPlayerId
                return (
                    <Space size={6} wrap>
                        <span>{row.defaultPlayerName ?? `#${row.defaultPlayerId}`}</span>
                        <Tag color={isActive ? "green" : "blue"}>{isActive ? "当前活动" : "账号默认"}</Tag>
                    </Space>
                )
            },
        },
        {
            title: "绑定设备", width: 230,
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
                        <Space size={4} key={device.deviceId}>
                            <Tag>{device.name ?? `设备 ${device.deviceId}`}</Tag>
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
                        </Space>
                    ))}
                </Space>
            ),
        },
        {
            title: "操作", width: 250,
            render: (_: unknown, row: AccountRow) => (
                <div className="admin-action-row">
                    <Button size="small" type="primary" onClick={() => setSelectedAccountId(row.id)}>管理存档</Button>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => newSave.mutate(row.id)}>新建存档</Button>
                    <Popconfirm title={`删除账号 ${row.id} 及所有存档？`} onConfirm={() => deleteAccount.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                </div>
            ),
        },
    ]

    const saveColumns = [
        { title: "ID", dataIndex: "id", width: 60, responsive: ["sm"] as any },
        {
            title: "名字", width: 150,
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
                <Space onClick={event => event.stopPropagation()}>
                    <a onClick={() => navigate(`/players/${row.id}`)}>{row.name}</a>
                    <Button
                        type="text"
                        size="small"
                        title="重命名存档"
                        icon={<EditOutlined />}
                        onClick={() => { setRenameId(row.id); setRenameName(row.name) }}
                    />
                </Space>
            ),
        },
        { title: "Rank", width: 80, render: (_: unknown, row: PlayerBrief) => `Rank ${row.rank}` },
        {
            title: "状态", width: 80, responsive: ["sm"] as any,
            render: (_: unknown, row: PlayerBrief) => (
                <Space size={4} wrap>
                    {row.isDefault && <Tag color="blue">账号默认</Tag>}
                    {row.isActive && <Tag color="green">当前活动</Tag>}
                </Space>
            ),
        },
        {
            title: "操作", width: 320,
            render: (_: unknown, row: PlayerBrief) => (
                <div className="admin-action-row" onClick={event => event.stopPropagation()}>
                    <Button size="small" type="primary" icon={<EditOutlined />} onClick={() => navigate(`/players/${row.id}`)}>
                        编辑存档
                    </Button>
                    <Button size="small" icon={<SwapOutlined />} disabled={row.isDefault && row.isActive} onClick={() => activateSave.mutate(row.id)}>
                        设为默认并切换
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => cloneSave.mutate({ playerId: row.id, accountId: selectedAccountId! })}>
                        复制
                    </Button>
                    <Popconfirm title={`删除存档 ${row.id}？`} onConfirm={() => deleteSave.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
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
        >
        <Space direction="vertical" size="large" className="admin-stack">
            <Alert
                type="info"
                showIcon
                message="选档状态说明"
                description="新建和复制存档会设为该账号默认并切换为当前活动；删除默认存档后，服务端会在该账号剩余存档中回退到第一个可用存档。删除最后一个存档会同时删除账号。"
            />
            {isMobile ? (
                <Card
                    title={selectedAccount ? `账号 ${selectedAccount.id} 的存档` : "账号管理"}
                    className="admin-mobile-list-card"
                >
                    <AccountsMobileView
                        accounts={accounts}
                        selectedAccount={selectedAccount}
                        loading={isLoading}
                        renamePending={renameSave.isPending || renameDevice.isPending}
                        onSelectAccount={setSelectedAccountId}
                        onBack={() => setSelectedAccountId(null)}
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
            ) : selectedAccount ? (
                <Card
                    title={`账号 ${selectedAccount.id} 的存档`}
                    className="admin-table-card"
                    extra={(
                        <Space wrap>
                            <Button size="small" icon={<LeftOutlined />} onClick={() => setSelectedAccountId(null)}>返回账号列表</Button>
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
                        locale={{ emptyText: "暂无存档" }}
                        onRow={row => ({
                            className: "admin-clickable-table-row",
                            onClick: () => navigate(`/players/${row.id}`),
                        })}
                    />
                </Card>
            ) : (
                <Card title="账号管理" className="admin-table-card">
                    <Table
                        rowKey="id"
                        columns={accountColumns}
                        dataSource={accounts}
                        loading={isLoading}
                        pagination={false}
                        size="small"
                    />
                </Card>
            )}

        </Space>
        </AdminPage>
    )
}
