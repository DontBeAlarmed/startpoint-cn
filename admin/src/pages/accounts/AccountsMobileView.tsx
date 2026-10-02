import { useEffect, useRef, useState } from "react"
import {
    Button,
    Empty,
    Input,
    List,
    Popconfirm,
    Typography,
} from "antd"
import { ArrowLeftRight, Copy, Pencil, Plus, Trash2 } from "lucide-react"

import type { AccountRow, DeviceBinding } from "./types"
import { FavoriteAvatar } from "./FavoriteAvatar"

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
    onRenameDevice: (deviceId: number, name: string) => Promise<unknown>
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
    onRenameDevice,
}: AccountsMobileViewProps) {
    const [renamingDeviceId, setRenamingDeviceId] = useState<number | null>(null)
    const [deviceName, setDeviceName] = useState("")
    const savePanelRef = useRef<HTMLDivElement | null>(null)
    // Esc 取消时置位, 让随后的失焦跳过保存
    const deviceEditCancelledRef = useRef(false)
    const selectedAccountId = selectedAccount?.id ?? null

    // 存档子卡嵌在账号卡内部展开（与桌面同构）: 展开/切换滚动嵌套区到位, 收起不动
    useEffect(() => {
        if (selectedAccountId !== null) savePanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, [selectedAccountId])

    const submitDeviceName = async (deviceId: number) => {
        if (renamingDeviceId !== deviceId) return
        await onRenameDevice(deviceId, deviceName)
        setRenamingDeviceId(null)
    }

    // 设备名 pill（含行内改名编辑器）：渲染在账号卡 kv 行的绑定设备值内，
    // renameDevice 流程（API/payload/失效）与桌面保持一致。
    // 编辑态保持 pill 原结构（维护者 2026-09-29）：单击进入, 失焦/回车保存, Esc 取消, 无确定/取消按钮
    const renderDevicePill = (device: DeviceBinding) =>
        renamingDeviceId === device.deviceId ? (
            <div className="admin-dev-edit admin-dev-edit-editing" key={device.deviceId}>
                <Input
                    size="small"
                    variant="borderless"
                    autoFocus
                    value={deviceName}
                    maxLength={64}
                    placeholder={`设备 ${device.deviceId}`}
                    onChange={event => setDeviceName(event.target.value)}
                    onPressEnter={() => submitDeviceName(device.deviceId)}
                    onBlur={() => {
                        if (deviceEditCancelledRef.current) {
                            deviceEditCancelledRef.current = false
                            return
                        }
                        void submitDeviceName(device.deviceId)
                    }}
                    onKeyDown={event => {
                        if (event.key === "Escape") {
                            deviceEditCancelledRef.current = true
                            setRenamingDeviceId(null)
                        }
                    }}
                />
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

    // 存档子卡（mockup .save-sub 移动形态）: 头像 40×40 在存档名前 + 当前存档徽章 + meta + 操作行 icon+文字；
    // 整卡可点进玩家详情, 操作行 stopPropagation（照既有移动存档行惯例）
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
            </div>
            <div className="save-meta">Lv {player.rank} · {player.characterCount} 角色</div>
            <div className="admin-mobile-actions" onClick={event => event.stopPropagation()}>
                {/* 移动端存档卡操作行 icon+文字（维护者 2026-09-29 第五轮指定）；桌面同操作集为纯文字按钮 */}
                <Button icon={<Pencil size={15} />} aria-label="编辑存档" onClick={() => onOpenPlayer(player.id)}>编辑</Button>
                {/* activateSave 服务端同时把该存档设为账号的当前存档与全局活动存档，故仅 isDefault 时禁用 */}
                <Button
                    icon={<ArrowLeftRight size={15} />}
                    aria-label="切换存档"
                    disabled={player.isDefault}
                    onClick={() => onActivateSave(player.id)}
                >切换</Button>
                <Button icon={<Copy size={15} />} aria-label="复制存档" onClick={() => onCloneSave(player.id, account.id)}>复制</Button>
                <Popconfirm
                    title={`删除存档 ${player.id}？`}
                    okText="确认"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onDeleteSave(player.id)}
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
                                        <Typography.Text strong>账号 #{account.id}</Typography.Text>
                                        {account.adminNote && (
                                            <Typography.Text type="secondary" className="acc-note">{account.adminNote}</Typography.Text>
                                        )}
                                    </span>
                                    <span className="acc-actions">
                                        <Button size="small" aria-expanded={expanded} onClick={() => onSelectAccount(account.id)}>
                                            存档列表 {expanded ? "▴" : "▾"}
                                        </Button>
                                        <Popconfirm
                                            title={`删除账号 ${account.id} 及所有存档？`}
                                            okText="确认"
                                            cancelText="取消"
                                            okButtonProps={{ danger: true }}
                                            onConfirm={() => onDeleteAccount(account.id)}
                                        >
                                            <Button danger icon={<Trash2 size={15} />} aria-label={`删除账号 ${account.id}`}>删除</Button>
                                        </Popconfirm>
                                    </span>
                                </div>
                                <div className="admin-mobile-detail-list">
                                    <div>
                                        <span>当前存档</span>
                                        <span className="acc-kv-value">
                                            <strong>{account.defaultPlayerName ?? "无"}</strong>
                                            {account.defaultPlayerId !== null && <span className="admin-badge-ok">当前</span>}
                                        </span>
                                    </div>
                                    <div>
                                        <span>绑定设备</span>
                                        <span className="acc-kv-value acc-devices">
                                            {account.devices.length === 0 ? "无" : account.devices.map(renderDevicePill)}
                                        </span>
                                    </div>
                                </div>
                                {expanded && (
                                    <div className="acc-save-list" ref={savePanelRef}>
                                        <div className="acc-save-toolbar">
                                            <span className="admin-badge-info">{account.players.length} 个存档</span>
                                            <Button size="small" type="primary" icon={<Plus size={15} />} onClick={() => onNewSave(account.id)}>新建存档</Button>
                                        </div>
                                        {account.players.length === 0
                                            ? <Empty description="暂无存档" />
                                            : account.players.map(player => renderSaveSub(account, player))}
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
