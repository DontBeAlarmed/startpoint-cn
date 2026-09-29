import { useEffect, useRef, useState } from "react"
import {
    Button,
    Empty,
    Input,
    List,
    Modal,
    Popconfirm,
    Space,
    Typography,
} from "antd"
import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react"

import type { AccountRow, PlayerBrief } from "./types"

interface AccountsMobileViewProps {
    accounts: readonly AccountRow[]
    selectedAccount: AccountRow | undefined
    loading: boolean
    renamePending: boolean
    onSelectAccount: (accountId: number) => void
    onOpenPlayer: (playerId: number) => void
    onNewSave: (accountId: number) => Promise<unknown>
    onDeleteAccount: (accountId: number) => Promise<unknown>
    onActivateSave: (playerId: number) => Promise<unknown>
    onCloneSave: (playerId: number, accountId: number) => Promise<unknown>
    onDeleteSave: (playerId: number) => Promise<unknown>
    onRenameDevice: (deviceId: number, name: string) => Promise<unknown>
}

export function AccountsMobileView({
    accounts,
    selectedAccount,
    loading,
    renamePending,
    onSelectAccount,
    onOpenPlayer,
    onNewSave,
    onDeleteAccount,
    onActivateSave,
    onCloneSave,
    onDeleteSave,
    onRenameDevice,
}: AccountsMobileViewProps) {
    const [renamingDeviceId, setRenamingDeviceId] = useState<number | null>(null)
    const [deviceName, setDeviceName] = useState("")
    const savePanelRef = useRef<HTMLDivElement | null>(null)
    const selectedAccountId = selectedAccount?.id ?? null

    // same inline-panel semantics as desktop: open/switch scrolls the save section into view
    useEffect(() => {
        if (selectedAccountId !== null) savePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, [selectedAccountId])

    const submitDeviceName = async (deviceId: number) => {
        await onRenameDevice(deviceId, deviceName)
        setRenamingDeviceId(null)
    }
    const confirmDeleteSave = (player: PlayerBrief) => {
        Modal.confirm({
            title: `删除存档 ${player.id}？`,
            content: "删除后无法恢复。",
            okText: "删除",
            cancelText: "取消",
            okButtonProps: { danger: true },
            onOk: () => onDeleteSave(player.id),
        })
    }

    return (
        <div className="admin-account-mobile-list">
            <List
                loading={loading}
                dataSource={[...accounts]}
                locale={{ emptyText: "暂无账号" }}
                renderItem={account => (
                    <List.Item className="admin-mobile-list-item">
                        <div className="admin-mobile-list-content">
                            <div className="admin-mobile-list-heading">
                                <span className="admin-mobile-heading-main">
                                    <Typography.Text strong>账号 #{account.id}</Typography.Text>
                                    {account.adminNote && (
                                        <Typography.Text type="secondary">{account.adminNote}</Typography.Text>
                                    )}
                                </span>
                                <Typography.Text>{account.saveCount} 个存档</Typography.Text>
                            </div>
                            <div className="admin-mobile-detail-list">
                                <div><span>当前存档</span><strong>{account.defaultPlayerName ?? "无"}</strong></div>
                                <div><span>绑定设备</span><strong>{account.devices.length || "无"}</strong></div>
                            </div>
                            {account.devices.length > 0 && (
                                <Space direction="vertical" size={6} className="admin-mobile-device-list">
                                    {account.devices.map(device => renamingDeviceId === device.deviceId ? (
                                        <div className="admin-mobile-inline-editor" key={device.deviceId}>
                                            <Input
                                                value={deviceName}
                                                maxLength={64}
                                                placeholder={`设备 ${device.deviceId}`}
                                                onChange={event => setDeviceName(event.target.value)}
                                                onPressEnter={() => submitDeviceName(device.deviceId)}
                                            />
                                            <Button type="primary" loading={renamePending} onClick={() => submitDeviceName(device.deviceId)}>确定</Button>
                                            <Button onClick={() => setRenamingDeviceId(null)}>取消</Button>
                                        </div>
                                    ) : (
                                        <div className="admin-dev-edit" key={device.deviceId}>
                                            <span className="admin-dev-edit-name">{device.name ?? `设备 ${device.deviceId}`}</span>
                                            <Button
                                                type="text"
                                                size="small"
                                                icon={<Pencil size={14} />}
                                                aria-label="修改设备名称"
                                                onClick={() => {
                                                    setRenamingDeviceId(device.deviceId)
                                                    setDeviceName(device.name ?? "")
                                                }}
                                            />
                                        </div>
                                    ))}
                                </Space>
                            )}
                            <div className="admin-mobile-actions">
                                <Button type="primary" icon={<FolderOpen size={15} />} onClick={() => onSelectAccount(account.id)}>存档列表</Button>
                                <Button icon={<Plus size={15} />} onClick={() => onNewSave(account.id)}>新建存档</Button>
                                <Popconfirm
                                    title={`删除账号 ${account.id} 及所有存档？`}
                                    okText="删除"
                                    cancelText="取消"
                                    okButtonProps={{ danger: true }}
                                    onConfirm={() => onDeleteAccount(account.id)}
                                >
                                    <Button danger icon={<Trash2 size={15} />} aria-label={`删除账号 ${account.id}`} />
                                </Popconfirm>
                            </div>
                        </div>
                    </List.Item>
                )}
            />
            {selectedAccount && (
                <div className="admin-mobile-save-panel" ref={savePanelRef}>
                    <div className="admin-mobile-view-toolbar">
                        <Typography.Text strong>账号 {selectedAccount.id} · 存档列表</Typography.Text>
                        <Button type="primary" icon={<Plus size={16} />} onClick={() => onNewSave(selectedAccount.id)}>
                            新建存档
                        </Button>
                    </div>
                    {selectedAccount.players.length === 0 ? <Empty description="暂无存档" /> : (
                        <List
                            dataSource={selectedAccount.players}
                            renderItem={player => (
                                <List.Item
                                    className="admin-mobile-list-item admin-mobile-list-item-clickable"
                                    onClick={() => onOpenPlayer(player.id)}
                                >
                                    <div className="admin-mobile-list-content">
                                        <div className="admin-mobile-list-heading">
                                            <span className="admin-mobile-heading-main">
                                                {player.isDefault && <span className="admin-badge-info">当前存档</span>}
                                                <Typography.Text strong>{player.name}</Typography.Text>
                                                {player.isActive && <span className="admin-badge-ok">当前活动</span>}
                                            </span>
                                            <Typography.Text>Rank {player.rank}</Typography.Text>
                                        </div>
                                        <Typography.Text type="secondary">存档 #{player.id}</Typography.Text>
                                        <div className="admin-mobile-actions" onClick={event => event.stopPropagation()}>
                                            <Button type="primary" icon={<Pencil size={15} />} onClick={() => onOpenPlayer(player.id)}>
                                                编辑存档
                                            </Button>
                                            <Button disabled={player.isDefault && player.isActive} onClick={() => onActivateSave(player.id)}>
                                                切换存档
                                            </Button>
                                            <Button onClick={() => onCloneSave(player.id, selectedAccount.id)}>复制</Button>
                                            <Button danger type="text" onClick={() => confirmDeleteSave(player)}>删除</Button>
                                        </div>
                                    </div>
                                </List.Item>
                            )}
                        />
                    )}
                </div>
            )}
        </div>
    )
}
