import { useEffect, useRef, useState } from "react"
import {
    Button,
    Empty,
    Input,
    List,
    Popconfirm,
    Space,
    Typography,
} from "antd"
import { ArrowLeftRight, Copy, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react"

import type { AccountRow, DeviceBinding } from "./types"

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

    // 设备名 pill（含行内改名编辑器）：单设备账号渲染在标题行，多设备账号在下方设备区列出，
    // renameDevice 流程（API/payload/失效）与桌面保持一致
    const renderDevicePill = (device: DeviceBinding) =>
        renamingDeviceId === device.deviceId ? (
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
        )

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
                                    {/* 单设备账号：设备名编辑 pill 上移到标题行（维护者 2026-09-29 指定）；
                                        多设备/无设备时标题行不放 pill，设备区仍在下方列出 */}
                                    {account.devices.length === 1 && renderDevicePill(account.devices[0])}
                                </span>
                                <Typography.Text>{account.saveCount} 个存档</Typography.Text>
                            </div>
                            <div className="admin-mobile-detail-list">
                                <div><span>当前存档</span><strong>{account.defaultPlayerName ?? "无"}</strong></div>
                                <div><span>绑定设备</span><strong>{account.devices.length || "无"}</strong></div>
                            </div>
                            {account.devices.length > 1 && (
                                <Space direction="vertical" size={6} className="admin-mobile-device-list">
                                    {account.devices.map(device => renderDevicePill(device))}
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
                                    <Button danger icon={<Trash2 size={15} />} aria-label={`删除账号 ${account.id}`}>删除</Button>
                                </Popconfirm>
                            </div>
                        </div>
                    </List.Item>
                )}
            />
            {selectedAccount && (
                <div className="admin-mobile-save-panel" ref={savePanelRef}>
                    <div className="admin-mobile-view-toolbar">
                        <span className="admin-mobile-toolbar-main">
                            <Typography.Text strong>账号 {selectedAccount.id}</Typography.Text>
                            {selectedAccount.adminNote && (
                                <Typography.Text type="secondary">{selectedAccount.adminNote}</Typography.Text>
                            )}
                            <Typography.Text>· 存档列表</Typography.Text>
                        </span>
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
                                            </span>
                                            <Typography.Text>Rank {player.rank}</Typography.Text>
                                        </div>
                                        <Typography.Text type="secondary">存档 #{player.id}</Typography.Text>
                                        <div className="admin-mobile-actions" onClick={event => event.stopPropagation()}>
                                            {/* 移动端存档卡操作行 icon+文字（维护者 2026-09-29 第五轮指定）；桌面仍为纯文字按钮 */}
                                            <Button icon={<Pencil size={15} />} aria-label="编辑存档" onClick={() => onOpenPlayer(player.id)}>编辑</Button>
                                            {/* activateSave 服务端同时设置账号默认存档与全局活动存档，故仅 isDefault 时禁用 */}
                                            <Button
                                                icon={<ArrowLeftRight size={15} />}
                                                aria-label="切换存档"
                                                disabled={player.isDefault}
                                                onClick={() => onActivateSave(player.id)}
                                            >切换</Button>
                                            <Button icon={<Copy size={15} />} aria-label="复制存档" onClick={() => onCloneSave(player.id, selectedAccount.id)}>复制</Button>
                                            <Popconfirm
                                                title={`删除存档 ${player.id}？`}
                                                description="删除后无法恢复。"
                                                okText="删除"
                                                cancelText="取消"
                                                okButtonProps={{ danger: true }}
                                                onConfirm={() => onDeleteSave(player.id)}
                                            >
                                                <Button danger icon={<Trash2 size={15} />} aria-label={`删除存档 ${player.id}`}>删除</Button>
                                            </Popconfirm>
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
