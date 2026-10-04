import type { ReactNode } from "react"
import { Alert, Card, Col, Row, Space, Tag, Typography } from "antd"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { apiGet } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface AccountRow {
    id: number
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    playerIds: number[]
}

interface ServerTime {
    servertime: number
    date: string
    isCustom: boolean
}

interface ServerStatus {
    server: {
        uptimeSeconds: number
        nodeVersion: string
        platform: string
        pid: number
        memory: { rss: number; heapUsed: number; heapTotal: number }
        listenHost: string
        listenPort: string
    }
    cdn: {
        baseUrl: string | null
        baseline: {
            mode: string
            source: string
            fullVersion: string
            cnFinalVersion: string
            detectedArchiveVersion: string
            manifestVersion: string
            pinned: boolean
            dataScope: string[]
        }
        extension: {
            mode: string
            status: string
            runtimeEnabled: boolean
            effectiveVersionPreview: string
            enabledPatchCount: number
            totalPatchCount: number
            activePatchArchiveCount: number
            versions: string[]
            note: string
        }
        storage: {
            mode: "local" | "remote" | "client-owned"
            configuredDir: string
            directoryPresent: boolean
            archiveCount: number
            archiveBytes: number
            latestArchiveMtime: string | null
        }
        contentRelease: {
            source: "bundled" | "release"
            assetVersion: string
            generatorVersion: number
            releaseDigest: string | null
            contentDigest: string
            multiBattleContentDigest: string
        }
        gameCalendar: {
            configuredUtcOffsetMinutes: number
            contentUtcOffsetMinutes: number
        }
        configuredDir: string
        directoryPresent: boolean
        archiveCount: number
        archiveBytes: number
        latestArchiveMtime: string | null
        fullVersion: string
        detectedVersion: string
        effectiveVersion: string
        manifestVersion: string
        enabledPatchCount: number
        totalPatchCount: number
        activePatchArchiveCount: number
    }
    multiplayer: {
        mode: "embedded" | "host" | "client"
        state: "ready" | "degraded" | "unavailable"
        coordinator: { kind: "local" | "remote"; available: boolean }
        hub: { available: boolean; endpoint: string | null } | null
        tcp: { available: boolean; endpoint: string | null }
        activeRooms: number | null
        battleFacts: { active: number; finalized: number } | null
        latestCompatibilityRejection: {
            code: "INCOMPATIBLE_ROOM"
            differences: Array<{
                field: string
                different: true
                required?: string
                received?: string
            }>
            timestamp: string
        } | null
    }
}

function formatDuration(seconds: number): string {
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (days > 0) return `${days} 天 ${hours} 小时`
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
    return `${Math.max(1, minutes)} 分钟`
}

function formatBytes(bytes: number): string {
    if (!bytes) return "0 B"
    const units = ["B", "KB", "MB", "GB", "TB"]
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

const cdnScopeLabels: Record<string, string> = {
    items: "道具",
    characters: "角色",
    events: "活动",
    quests: "任务",
    shops: "商店",
}

const multiModeLabels = {
    embedded: "内置模式",
    host: "Hub 主机",
    client: "Hub 客户端",
} as const

const multiStateLabels = {
    ready: "正常",
    degraded: "降级",
    unavailable: "未启动",
} as const

const multiStateBadgeClasses = {
    ready: "admin-badge-ok",
    degraded: "admin-badge-warn",
    // B1：未启动属 停用/未设置 族，用 muted（灰），非信息蓝
    unavailable: "admin-badge-muted",
} as const

/* dashboard: C 图标卡格 — each fact reads as one small elevated tile: centered star-stroke
   icon on top, soft label, prominent value. Geometry mirrors the approved mockup anatomy. */
const featIcons = {
    node: (<><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /></>),
    platform: (<><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /></>),
    listen: (<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>),
    pid: <path d="M12 3v18M5 8l7-5 7 5M3 13l2 8h14l2-8" />,
    link: (<><path d="M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0" /><circle cx="12" cy="19" r="1" /></>),
    shieldCheck: (<><path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" /><path d="M9 12l2 2 4-4" /></>),
    clock: (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></>),
    done: (<><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 5-5" /></>),
    shield: <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />,
    check: <path d="M20 6L9 17l-5-5" />,
    patch: <path d="M12 3v18M5 8l7-5 7 5" />,
    calendar: (<><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></>),
} as const

function FeatTile({ icon, label, value, tick = false }: { icon: ReactNode; label: string; value: ReactNode; tick?: boolean }) {
    return (
        <div className={tick ? "admin-feat admin-stat-tick" : "admin-feat"}>
            <svg className="admin-feat-icon" viewBox="0 0 24 24" aria-hidden="true">{icon}</svg>
            <div className="admin-feat-label">{label}</div>
            <div className="admin-feat-value">{value}</div>
        </div>
    )
}

export default function Dashboard() {
    const qc = useQueryClient()

    const { data: accounts = [], isError: accountsError, isFetching: accountsFetching } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const { data: status, isLoading: statusLoading, isError: statusError, isFetching: statusFetching } = useQuery({
        queryKey: ["serverStatus"],
        queryFn: () => apiGet<ServerStatus>("/api/server/status"),
        refetchInterval: 30_000,
    })

    const { data: serverTime, isLoading: serverTimeLoading, isError: serverTimeError } = useQuery({
        queryKey: ["serverTime"],
        queryFn: () => apiGet<ServerTime>("/api/server/currentTime"),
        refetchInterval: 30_000,
    })

    const accountCount = accounts.length
    const saveCount = accounts.reduce((sum, a) => sum + a.saveCount, 0)

    const refreshOverview = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
        qc.invalidateQueries({ queryKey: ["serverStatus"] })
    }

    const heroClockText = serverTimeLoading
        ? "加载中..."
        : serverTimeError || !serverTime
            ? "接口不可用"
            : serverTime.date.replace("T", " ").slice(0, 19)

    const calendarOffsetMismatch = status != null
        && status.cdn.gameCalendar.configuredUtcOffsetMinutes !== status.cdn.gameCalendar.contentUtcOffsetMinutes

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="服务器总览"
            description="查看服务端运行状态、当前内容快照和账号存档概况。"
            onRefresh={refreshOverview}
            refreshing={accountsFetching || statusFetching}
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <div className="admin-hero">
                    <div className="admin-hero-in">
                        <div className="admin-hero-clock">
                            <span className="admin-hero-clock-label">服务器虚拟时间</span>
                            <span className="admin-hero-clock-value">{heroClockText}</span>
                            <div className="admin-hero-clock-sub">
                                {serverTime && (
                                    <span className={serverTime.isCustom ? "admin-badge-warn" : "admin-badge-info"}>
                                        {serverTime.isCustom ? "自定义模拟" : "跟随系统"}
                                    </span>
                                )}
                                {serverTime && <span>UTC：{serverTime.date.replace("T", " ")}</span>}
                            </div>
                        </div>
                        <div className="admin-hero-chips">
                            {status && <span className="admin-badge-ok">● 服务运行中</span>}
                            {statusError && <span className="admin-badge-warn">状态异常</span>}
                        </div>
                        {(status || !accountsError) && (
                            <div className="admin-stat-band">
                                {status && (
                                    <>
                                        <div className="admin-stat-band-item">
                                            <span className="admin-stat-band-label">运行时间</span>
                                            <span className="admin-stat-band-value">{formatDuration(status.server.uptimeSeconds)}</span>
                                        </div>
                                        <div className="admin-stat-band-item">
                                            <span className="admin-stat-band-label">RSS 内存</span>
                                            <span className="admin-stat-band-value">{formatBytes(status.server.memory.rss)}</span>
                                        </div>
                                        <div className="admin-stat-band-item">
                                            <span className="admin-stat-band-label">活跃房间</span>
                                            <span className="admin-stat-band-value">{status.multiplayer.activeRooms ?? "未知"}</span>
                                        </div>
                                    </>
                                )}
                                {!accountsError && (
                                    <>
                                        <div className="admin-stat-band-item">
                                            <span className="admin-stat-band-label">账号总数</span>
                                            <span className="admin-stat-band-value">{accountCount}</span>
                                        </div>
                                        <div className="admin-stat-band-item">
                                            <span className="admin-stat-band-label">存档总数</span>
                                            <span className="admin-stat-band-value">{saveCount}</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                {accountsError && (
                    <Alert
                        type="error"
                        showIcon
                        message="概览数据加载失败"
                        description="接口 /api/server/accounts 不可用。"
                    />
                )}

                <Row gutter={[16, 16]}>
                    <Col xs={24} md={12}>
                        <Card title="服务端状态" style={{ height: "100%" }} className="admin-dash-card">
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载服务端状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="服务端状态加载失败" description="接口 /api/server/status 不可用。" />
                            ) : (
                                <div className="admin-feats">
                                    <FeatTile icon={featIcons.node} label="Node" value={status.server.nodeVersion} />
                                    <FeatTile icon={featIcons.platform} label="平台" value={status.server.platform} />
                                    <FeatTile
                                        icon={featIcons.listen}
                                        label="监听"
                                        value={<>{status.server.listenHost}:{status.server.listenPort}</>}
                                    />
                                    <FeatTile icon={featIcons.pid} label="PID" value={status.server.pid} />
                                </div>
                            )}
                        </Card>
                    </Col>
                    <Col xs={24} md={12}>
                        <Card
                            title="多人联机状态"
                            style={{ height: "100%" }}
                            className="admin-dash-card"
                            extra={status ? (
                                <Space wrap size={4}>
                                    <span className="admin-badge-info">
                                        {multiModeLabels[status.multiplayer.mode]} · {status.multiplayer.coordinator.kind === "local" ? "本地协调器" : "远程协调器"}
                                    </span>
                                    {/* B2：正常态与卡内 5 砖可用状态重复，标题区不再常驻状态徽章；
                                        仅降级/未启动时示警（未启动=muted，见 multiStateBadgeClasses） */}
                                    {status.multiplayer.state !== "ready" && (
                                        <span className={multiStateBadgeClasses[status.multiplayer.state]}>
                                            {multiStateLabels[status.multiplayer.state]}
                                        </span>
                                    )}
                                </Space>
                            ) : undefined}
                        >
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载多人联机状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="多人联机状态加载失败" />
                            ) : (
                                <div className="admin-dash-sections">
                                    <div className="admin-feats admin-feats-5">
                                        <FeatTile
                                            icon={featIcons.link}
                                            label="控制面连通性"
                                            value={status.multiplayer.hub === null
                                                ? "不适用"
                                                : status.multiplayer.hub.available ? "可用" : "不可用"}
                                        />
                                        <FeatTile
                                            icon={featIcons.link}
                                            label="TCP"
                                            value={status.multiplayer.tcp.available ? "可用" : "不可用"}
                                        />
                                        <FeatTile
                                            icon={featIcons.clock}
                                            label="进行中事实"
                                            value={status.multiplayer.battleFacts?.active ?? "未知"}
                                            tick
                                        />
                                        <FeatTile
                                            icon={featIcons.done}
                                            label="已结束事实"
                                            value={status.multiplayer.battleFacts?.finalized ?? "未知"}
                                            tick
                                        />
                                        <FeatTile
                                            icon={featIcons.shieldCheck}
                                            label="兼容拒绝"
                                            value={status.multiplayer.latestCompatibilityRejection ? "有记录" : "暂无记录"}
                                        />
                                    </div>
                                    {(status.multiplayer.activeRooms === null
                                        || status.multiplayer.battleFacts === null) && (
                                        <Typography.Text type="secondary">
                                            权威统计暂不可用。
                                        </Typography.Text>
                                    )}
                                </div>
                            )}
                        </Card>
                    </Col>
                </Row>

                <Row gutter={[16, 16]}>
                    <Col span={24}>
                        <Card
                            title="CDN 基线 / 补丁 Overlay"
                            style={{ height: "100%" }}
                            className="admin-dash-card"
                            extra={status ? (
                                <Space wrap size={4}>
                                    <span className={calendarOffsetMismatch ? "admin-badge-warn" : "admin-badge-info"}>
                                        配置 {status.cdn.gameCalendar.configuredUtcOffsetMinutes} / 内容 {status.cdn.gameCalendar.contentUtcOffsetMinutes}
                                        {calendarOffsetMismatch ? " · 不一致" : " · 一致"}
                                    </span>
                                    {calendarOffsetMismatch && (
                                        <Tag color="orange">配置与内容 Release 偏移不一致</Tag>
                                    )}
                                </Space>
                            ) : undefined}
                        >
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载 CDN 状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="CDN 信息加载失败" />
                            ) : (
                                <div className="admin-feats">
                                    <FeatTile icon={featIcons.shield} label="国服最终基线" value={status.cdn.baseline.cnFinalVersion} />
                                    <FeatTile icon={featIcons.check} label="当前资源版本" value={status.cdn.extension.effectiveVersionPreview} />
                                    <FeatTile
                                        icon={featIcons.patch}
                                        label="补丁版本"
                                        value={<>{status.cdn.extension.enabledPatchCount}{status.cdn.extension.runtimeEnabled ? null : " · 无补丁"}</>}
                                    />
                                    <FeatTile
                                        icon={featIcons.calendar}
                                        label="游戏日历"
                                        value={<>{status.cdn.gameCalendar.configuredUtcOffsetMinutes}/{status.cdn.gameCalendar.contentUtcOffsetMinutes}</>}
                                    />
                                </div>
                            )}
                        </Card>
                    </Col>
                </Row>

                {status && (
                    <details className="admin-details">
                        <summary className="admin-details-summary">
                            <span className="admin-details-arrow" aria-hidden="true">▶</span>
                            <span className="admin-details-star" aria-hidden="true" />
                            详细信息
                            <span className="admin-details-hint">地址 · 兼容拒绝 · Snapshot 声明 · 内容摘要</span>
                        </summary>
                        <div className="admin-details-body">
                            <div className="admin-details-section">
                                <div className="admin-details-section-title">联机地址</div>
                                <div className="admin-details-row">
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">控制面地址</span>
                                        <Typography.Text code className="admin-mono">
                                            {status.multiplayer.hub?.endpoint ?? "-"}
                                        </Typography.Text>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">TCP 地址</span>
                                        <Typography.Text code className="admin-mono">
                                            {status.multiplayer.tcp.endpoint ?? "-"}
                                        </Typography.Text>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">兼容拒绝记录</span>
                                        {status.multiplayer.latestCompatibilityRejection ? (
                                            <div className="admin-details-item-value">
                                                <div className="admin-dash-section">
                                                    <div className="admin-dash-section-title">最近兼容性拒绝</div>
                                                    <div className="admin-dash-section-body">
                                                        <Typography.Text type="secondary">
                                                            {new Date(status.multiplayer.latestCompatibilityRejection.timestamp).toLocaleString("zh-CN")}
                                                        </Typography.Text>
                                                        <div className="multi-compatibility-differences">
                                                            {status.multiplayer.latestCompatibilityRejection.differences.length === 0 ? (
                                                                <Tag>请求版本信息不完整</Tag>
                                                            ) : status.multiplayer.latestCompatibilityRejection.differences.map((difference, index) => (
                                                                <div
                                                                    key={`${difference.field}-${index}`}
                                                                    className="multi-compatibility-difference"
                                                                >
                                                                    <span className="admin-badge-warn">
                                                                        {difference.field === "contentDigest"
                                                                            ? "多人战斗内容（contentDigest）"
                                                                            : difference.field}
                                                                    </span>
                                                                    <div className="multi-compatibility-values">
                                                                        {difference.required !== undefined
                                                                            && difference.received !== undefined ? (
                                                                            <>
                                                                                <div className="multi-compatibility-value">
                                                                                    <Typography.Text type="secondary">期望</Typography.Text>
                                                                                    <Typography.Text code>{difference.required}</Typography.Text>
                                                                                </div>
                                                                                <div className="multi-compatibility-value">
                                                                                    <Typography.Text type="secondary">实际</Typography.Text>
                                                                                    <Typography.Text code>{difference.received}</Typography.Text>
                                                                                </div>
                                                                            </>
                                                                        ) : (
                                                                            <Typography.Text type="secondary">
                                                                                {difference.field === "contentDigest"
                                                                                    || difference.field === "modeDigest"
                                                                                    ? "摘要值已隐藏"
                                                                                    : "差异值未提供"}
                                                                            </Typography.Text>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        ) : (
                                            <Typography.Text type="secondary">暂无兼容性拒绝记录。</Typography.Text>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="admin-details-section">
                                <div className="admin-details-section-title">内容摘要</div>
                                <div className="admin-details-row">
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">Release</span>
                                        <Typography.Text code className="admin-mono">
                                            {status.cdn.contentRelease.releaseDigest?.slice(0, 23) ?? "bundled"}
                                        </Typography.Text>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">业务内容摘要</span>
                                        <Typography.Text code className="admin-mono" copyable={{ text: status.cdn.contentRelease.contentDigest }}>
                                            {status.cdn.contentRelease.contentDigest.slice(0, 23)}
                                        </Typography.Text>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">多人内容摘要</span>
                                        <Typography.Text code className="admin-mono" copyable={{ text: status.cdn.contentRelease.multiBattleContentDigest }}>
                                            {status.cdn.contentRelease.multiBattleContentDigest.slice(0, 23)}
                                        </Typography.Text>
                                    </div>
                                </div>
                            </div>
                            <div className="admin-details-section">
                                <div className="admin-details-section-title">来源与存储</div>
                                <div className="admin-details-row">
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">资源模式</span>
                                        <span className="admin-details-item-value">{status.cdn.storage.mode}</span>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">CDN 地址</span>
                                        <Typography.Text code className="admin-mono">
                                            {status.cdn.baseUrl ?? "-"}
                                        </Typography.Text>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">数据来源</span>
                                        <span className="admin-details-item-value">{status.cdn.baseline.source}</span>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">Snapshot 声明归档</span>
                                        <Typography.Text code className="admin-mono">
                                            {status.cdn.storage.archiveCount} 个 ZIP / {formatBytes(status.cdn.storage.archiveBytes)}
                                        </Typography.Text>
                                    </div>
                                    <div className="admin-details-item">
                                        <span className="admin-details-item-key">覆盖范围</span>
                                        <Space wrap size={4}>
                                            {status.cdn.baseline.dataScope.map(scope => (
                                                <Tag key={scope}>{cdnScopeLabels[scope] || scope}</Tag>
                                            ))}
                                        </Space>
                                    </div>
                                </div>
                            </div>
                            <div className="admin-details-section">
                                <div className="admin-details-section-title">Snapshot 中已声明补丁</div>
                                <div className="admin-details-row">
                                    <div className="admin-details-item">
                                        <span className={status.cdn.extension.runtimeEnabled ? "admin-badge-ok" : "admin-badge-info"}>
                                            {status.cdn.extension.runtimeEnabled ? "Snapshot 含 Overlay" : "无补丁"}
                                        </span>
                                    </div>
                                    <div className="admin-details-item">
                                        <Tag>归档 {status.cdn.extension.activePatchArchiveCount}</Tag>
                                    </div>
                                    <div className="admin-details-item">
                                        {status.cdn.extension.versions.map(version => (
                                            <Tag key={version} color="blue">{version}</Tag>
                                        ))}
                                    </div>
                                    {!status.cdn.extension.runtimeEnabled && (
                                        <div className="admin-details-item">
                                            <Typography.Text type="secondary">
                                                当前固定 Content Snapshot 未包含补丁。
                                            </Typography.Text>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </details>
                )}
            </Space>
        </AdminPage>
    )
}
