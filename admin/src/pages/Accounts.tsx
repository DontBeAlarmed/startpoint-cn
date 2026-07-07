import { useState } from "react"
import { Card, Table, Button, Space, Popconfirm, Input, message, Tag, Divider } from "antd"
import { PlusOutlined, CopyOutlined, DeleteOutlined, SwapOutlined, EditOutlined } from "@ant-design/icons"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiGet, apiPost } from "../api/client"

interface AccountRow {
    id: number
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    playerIds: number[]
}

interface PlayerBrief {
    id: number
    name: string
    lastLoginTime: string
    degreeId: number
}

export default function Accounts() {
    const qc = useQueryClient()
    const navigate = useNavigate()
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
    const [renameId, setRenameId] = useState<number | null>(null)
    const [renameName, setRenameName] = useState("")

    const { data: accounts = [], isLoading } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const selectedAccount = accounts.find(a => a.id === selectedAccountId)
    const playerIds = selectedAccount?.playerIds ?? []

    const { data: allPlayers = [] } = useQuery({
        queryKey: ["players"],
        queryFn: () => apiGet<PlayerBrief[]>("/api/player"),
    })

    const savePlayers = playerIds
        .map(pid => allPlayers.find(p => p.id === pid))
        .filter((p): p is PlayerBrief => !!p)

    const refresh = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
        qc.invalidateQueries({ queryKey: ["players"] })
    }

    const activateSave = useMutation({
        mutationFn: (playerId: number) => apiPost("/api/server/activateSave?playerId=" + playerId),
        onSuccess: () => { message.success("已切换生效存档"); refresh() },
    })

    const newSave = useMutation({
        mutationFn: (accountId: number) => apiPost("/api/server/newSave?accountId=" + accountId),
        onSuccess: () => { message.success("新存档已创建"); refresh() },
    })

    const deleteSave = useMutation({
        mutationFn: (playerId: number) => apiPost("/api/server/deleteSave?playerId=" + playerId),
        onSuccess: () => { message.success("存档已删除"); refresh() },
    })

    const deleteAccount = useMutation({
        mutationFn: (id: number) => apiPost("/api/server/deleteAccount?id=" + id),
        onSuccess: () => {
            message.success("账号已删除")
            if (selectedAccountId === (deleteAccount.variables as number)) setSelectedAccountId(null)
            refresh()
        },
    })

    const renameSave = useMutation({
        mutationFn: ({ playerId, name }: { playerId: number; name: string }) =>
            apiPost("/api/server/renameSave", { playerId, name }),
        onSuccess: () => { message.success("已改名"); setRenameId(null); refresh() },
    })

    const cloneSave = useMutation({
        mutationFn: ({ playerId, accountId }: { playerId: number; accountId: number }) =>
            apiPost(`/api/server/cloneSave?playerId=${playerId}&accountId=${accountId}`),
        onSuccess: () => { message.success("存档已复制"); refresh() },
    })

    const accountColumns = [
        { title: "ID", dataIndex: "id", width: 80 },
        { title: "存档数", dataIndex: "saveCount", width: 80 },
        {
            title: "生效存档", width: 160,
            render: (_: unknown, row: AccountRow) => row.defaultPlayerName ?? <Tag>无</Tag>,
        },
        {
            title: "操作", width: 280,
            render: (_: unknown, row: AccountRow) => (
                <Space size="small">
                    <Button size="small" type="primary" onClick={() => setSelectedAccountId(row.id)}>查看存档</Button>
                    <Button size="small" icon={<PlusOutlined />} onClick={() => newSave.mutate(row.id)}>新建存档</Button>
                    <Popconfirm title={`删除账号 ${row.id} 及所有存档？`} onConfirm={() => deleteAccount.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                </Space>
            ),
        },
    ]

    const saveColumns = [
        { title: "ID", dataIndex: "id", width: 60 },
        {
            title: "名字", width: 180,
            render: (_: unknown, row: PlayerBrief) => renameId === row.id ? (
                <Space.Compact>
                    <Input size="small" value={renameName} onChange={e => setRenameName(e.target.value)} onPressEnter={() => renameSave.mutate({ playerId: row.id, name: renameName })} style={{ width: 100 }} />
                    <Button size="small" type="primary" onClick={() => renameSave.mutate({ playerId: row.id, name: renameName })}>确定</Button>
                    <Button size="small" onClick={() => setRenameId(null)}>取消</Button>
                </Space.Compact>
            ) : (
                <Space>
                    <a onClick={() => navigate(`/players/${row.id}`)}>{row.name}</a>
                    <Button type="text" size="small" icon={<EditOutlined />} onClick={() => { setRenameId(row.id); setRenameName(row.name) }} />
                </Space>
            ),
        },
        { title: "等级", width: 80, render: (_: unknown, row: PlayerBrief) => `Lv.${row.degreeId || 1}` },
        {
            title: "状态", width: 80,
            render: (_: unknown, row: PlayerBrief) =>
                selectedAccount?.defaultPlayerId === row.id ? <Tag color="green">生效中</Tag> : null,
        },
        {
            title: "操作", width: 320,
            render: (_: unknown, row: PlayerBrief) => (
                <Space size="small">
                    <Button size="small" icon={<SwapOutlined />} disabled={selectedAccount?.defaultPlayerId === row.id} onClick={() => activateSave.mutate(row.id)}>
                        切换
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={() => cloneSave.mutate({ playerId: row.id, accountId: selectedAccountId! })}>
                        复制
                    </Button>
                    <Popconfirm title={`删除存档 ${row.id}？`} onConfirm={() => deleteSave.mutate(row.id)} okText="确认" cancelText="取消" okButtonProps={{ danger: true }}>
                        <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
                    </Popconfirm>
                </Space>
            ),
        },
    ]

    return (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Card title="账号管理">
                <Table
                    rowKey="id"
                    columns={accountColumns}
                    dataSource={accounts}
                    loading={isLoading}
                    pagination={false}
                    size="small"
                />
            </Card>

            {selectedAccountId !== null && (
                <Card title={`账号 ${selectedAccountId} 的存档`} extra={<Button size="small" onClick={() => setSelectedAccountId(null)}>关闭</Button>}>
                    <Table
                        rowKey="id"
                        columns={saveColumns}
                        dataSource={savePlayers}
                        pagination={false}
                        size="small"
                        locale={{ emptyText: "暂无存档" }}
                    />
                </Card>
            )}

            <Divider />

            <Card title="全部玩家">
                <Table
                    rowKey="id"
                    columns={[
                        { title: "ID", dataIndex: "id", width: 80 },
                        {
                            title: "名字", dataIndex: "name",
                            render: (name: string, row: PlayerBrief) => <a onClick={() => navigate(`/players/${row.id}`)}>{name}</a>,
                        },
                        {
                            title: "最后登录", dataIndex: "lastLoginTime",
                            render: (t: string) => new Date(t).toLocaleDateString(),
                        },
                    ]}
                    dataSource={allPlayers}
                    pagination={{ pageSize: 20, showSizeChanger: true }}
                    size="small"
                />
            </Card>
        </Space>
    )
}
