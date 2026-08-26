import { useState } from "react"
import {
    Button,
    Dropdown,
    Empty,
    Input,
    List,
    Modal,
    Popconfirm,
    Space,
    Tag,
    Typography,
} from "antd"
import { ArrowLeft, Ellipsis, Pencil, Plus, Trash2 } from "lucide-react"

import type { AccountRow, PlayerBrief } from "./types"

interface AccountsMobileViewProps {
    accounts: readonly AccountRow[]
    selectedAccount: AccountRow | undefined
    loading: boolean
    renamePending: boolean
    onSelectAccount: (accountId: number) => void
    onBack: () => void
    onOpenPlayer: (playerId: number) => void
    onNewSave: (accountId: number) => Promise<unknown>
    onDeleteAccount: (accountId: number) => Promise<unknown>
    onActivateSave: (playerId: number) => Promise<unknown>
    onCloneSave: (playerId: number, accountId: number) => Promise<unknown>
    onDeleteSave: (playerId: number) => Promise<unknown>
    onRenameSave: (playerId: number, name: string) => Promise<unknown>
    onRenameDevice: (deviceId: number, name: string) => Promise<unknown>
}

export function AccountsMobileView({
    accounts,
    selectedAccount,
    loading,
    renamePending,
    onSelectAccount,
    onBack,
    onOpenPlayer,
    onNewSave,
    onDeleteAccount,
    onActivateSave,
    onCloneSave,
    onDeleteSave,
    onRenameSave,
    onRenameDevice,
}: AccountsMobileViewProps) {
    const [renamingSaveId, setRenamingSaveId] = useState<number | null>(null)
    const [saveName, setSaveName] = useState("")
    const [renamingDeviceId, setRenamingDeviceId] = useState<number | null>(null)
    const [deviceName, setDeviceName] = useState("")

    const submitSaveName = async (playerId: number) => {
        await onRenameSave(playerId, saveName)
        setRenamingSaveId(null)
    }
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

    if (selectedAccount) {
        return (
            <div className="admin-account-mobile-list">
                <div className="admin-mobile-view-toolbar">
                    <Button icon={<ArrowLeft size={16} />} onClick={onBack}>返回账号列表</Button>
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
                                    {renamingSaveId === player.id ? (
                                        <div
                                            className="admin-mobile-inline-editor"
                                            onClick={event => event.stopPropagation()}
                                            onKeyDown={event => event.stopPropagation()}
                                        >
                                            <Input
                                                value={saveName}
                                                maxLength={64}
                                                onChange={event => setSaveName(event.target.value)}
                                                onPressEnter={() => submitSaveName(player.id)}
                                            />
                                            <Button type="primary" loading={renamePending} onClick={() => submitSaveName(player.id)}>确定</Button>
                                            <Button onClick={() => setRenamingSaveId(null)}>取消</Button>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="admin-mobile-list-heading">
                                                <Typography.Text strong>{player.name}</Typography.Text>
                                                <Typography.Text>Rank {player.rank}</Typography.Text>
                                            </div>
                                            <Typography.Text type="secondary">存档 #{player.id}</Typography.Text>
                                            <div className="admin-mobile-tags">
                                                {player.isDefault && <Tag color="blue">账号默认</Tag>}
                                                {player.isActive && <Tag color="green">当前活动</Tag>}
                                            </div>
                                            <div className="admin-mobile-actions" onClick={event => event.stopPropagation()}>
                                                <Button type="primary" icon={<Pencil size={15} />} onClick={() => onOpenPlayer(player.id)}>
                                                    编辑存档
                                                </Button>
                                                <Dropdown
                                                    trigger={["click"]}
                                                    menu={{
                                                        items: [
                                                            { key: "activate", label: "设为默认并切换", disabled: player.isDefault && player.isActive },
                                                            { key: "rename", label: "重命名" },
                                                            { key: "clone", label: "复制" },
                                                            { key: "delete", label: "删除", danger: true },
                                                        ],
                                                        onClick: ({ key, domEvent }) => {
                                                            domEvent.stopPropagation()
                                                            if (key === "activate") void onActivateSave(player.id)
                                                            if (key === "rename") {
                                                                setRenamingSaveId(player.id)
                                                                setSaveName(player.name)
                                                            }
                                                            if (key === "clone") void onCloneSave(player.id, selectedAccount.id)
                                                            if (key === "delete") confirmDeleteSave(player)
                                                        },
                                                    }}
                                                >
                                                    <Button icon={<Ellipsis size={16} />} aria-label={`存档 ${player.name} 的更多操作`} />
                                                </Dropdown>
                                            </div>
                                        </>
                                    )}
                                </div>
                            </List.Item>
                        )}
                    />
                )}
            </div>
        )
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
                                <Typography.Text strong>账号 #{account.id}</Typography.Text>
                                <Typography.Text>{account.saveCount} 个存档</Typography.Text>
                            </div>
                            <div className="admin-mobile-detail-list">
                                <div><span>默认存档</span><strong>{account.defaultPlayerName ?? "无"}</strong></div>
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
                                        <div className="admin-mobile-device" key={device.deviceId}>
                                            <Tag>{device.name ?? `设备 ${device.deviceId}`}</Tag>
                                            <Button
                                                type="text"
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
                                <Button type="primary" onClick={() => onSelectAccount(account.id)}>管理存档</Button>
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
        </div>
    )
}
