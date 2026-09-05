import type { ReactNode } from "react"
import { Alert, Button, Card, Col, Popconfirm, Row, Space, Statistic, Tag, Typography, Upload, message } from "antd"
import { DeleteOutlined, ExperimentOutlined, MailOutlined, ReloadOutlined, TeamOutlined, UploadOutlined } from "@ant-design/icons"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "react-router-dom"
import { apiDelete, apiGet, apiUpload } from "../api/client"
import { AdminPage } from "../components/AdminPage"

interface AccountRow {
    id: number
    saveCount: number
    defaultPlayerId: number | null
    defaultPlayerName: string | null
    playerIds: number[]
}

interface DefaultSaveMeta {
    exists: boolean
    playerName?: string | null
    exportedAt?: string | null
    sourcePlayerId?: number | null
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
    unavailable: "admin-badge-info",
} as const

function DashKvItem({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="admin-dash-kv-item">
            <span className="admin-dash-kv-label">{label}</span>
            <span className="admin-dash-kv-value">{children}</span>
        </div>
    )
}

export default function Dashboard() {
    const qc = useQueryClient()
    const navigate = useNavigate()

    const { data: accounts = [], isError: accountsError, isFetching: accountsFetching } = useQuery({
        queryKey: ["accounts"],
        queryFn: () => apiGet<AccountRow[]>("/api/server/accounts"),
    })

    const { data: status, isLoading: statusLoading, isError: statusError, isFetching: statusFetching } = useQuery({
        queryKey: ["serverStatus"],
        queryFn: () => apiGet<ServerStatus>("/api/server/status"),
        refetchInterval: 30_000,
    })

    const accountCount = accounts.length
    const saveCount = accounts.reduce((sum, a) => sum + a.saveCount, 0)

    const { data: defSave } = useQuery({
        queryKey: ["defaultSave"],
        queryFn: () => apiGet<DefaultSaveMeta>("/api/server/defaultSave"),
    })

    const uploadDefault = useMutation({
        mutationFn: (file: File) => apiUpload("/api/server/defaultSave", file),
        onSuccess: () => { message.success("默认存档已设置"); qc.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const clearDefault = useMutation({
        mutationFn: () => apiDelete("/api/server/defaultSave"),
        onSuccess: () => { message.success("默认存档已清除"); qc.invalidateQueries({ queryKey: ["defaultSave"] }) },
        onError: (e: Error) => message.error(e.message),
    })

    const refreshOverview = () => {
        qc.invalidateQueries({ queryKey: ["accounts"] })
        qc.invalidateQueries({ queryKey: ["serverStatus"] })
    }

    return (
        <AdminPage
            eyebrow="OPERATIONS"
            title="服务器总览"
            description="查看服务端运行状态、当前内容快照和账号存档概况。"
            actions={
                <Button
                    icon={<ReloadOutlined />}
                    loading={accountsFetching || statusFetching}
                    onClick={refreshOverview}
                >
                    刷新总览
                </Button>
            }
        >
            <Space direction="vertical" size="large" className="admin-stack">
                <div className="admin-page-note">
                    <Typography.Text strong>唯一内置管理后台</Typography.Text>
                    <Typography.Text type="secondary">此管理后台随服务端一同构建，用于统一查看运行状态并执行日常管理操作。</Typography.Text>
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

                <Row gutter={[16, 16]}>
                    <Col xs={24} md={8}>
                        <Card title="服务端状态" style={{ height: "100%" }} className="admin-dash-card">
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载服务端状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="服务端状态加载失败" description="接口 /api/server/status 不可用。" />
                            ) : (
                                <div className="admin-dash-sections">
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">运行环境</div>
                                        <div className="admin-dash-kv">
                                            <DashKvItem label="Node">{status.server.nodeVersion}</DashKvItem>
                                            <DashKvItem label="平台">{status.server.platform}</DashKvItem>
                                            <DashKvItem label="监听">{status.server.listenHost}:{status.server.listenPort}</DashKvItem>
                                            <DashKvItem label="PID">{status.server.pid}</DashKvItem>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </Card>
                    </Col>
                    <Col xs={24} md={16}>
                        <Card title="多人联机状态" style={{ height: "100%" }} className="admin-dash-card">
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载多人联机状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="多人联机状态加载失败" />
                            ) : (
                                <div className="admin-dash-sections">
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">联机概览</div>
                                        <div className="admin-dash-section-body">
                                            <Space wrap>
                                                <Tag>{multiModeLabels[status.multiplayer.mode]}</Tag>
                                                <span className={multiStateBadgeClasses[status.multiplayer.state]}>
                                                    {multiStateLabels[status.multiplayer.state]}
                                                </span>
                                                <span className={status.multiplayer.coordinator.available ? "admin-badge-ok" : "admin-badge-info"}>
                                                    {status.multiplayer.coordinator.kind === "local" ? "本地协调器" : "远程协调器"}
                                                </span>
                                            </Space>
                                            <div className="admin-metric-row">
                                                <Statistic className="admin-stat-tick" title="进行中事实" value={status.multiplayer.battleFacts?.active ?? "未知"} />
                                                <Statistic className="admin-stat-tick" title="已结束事实" value={status.multiplayer.battleFacts?.finalized ?? "未知"} />
                                            </div>
                                            {(status.multiplayer.activeRooms === null
                                                || status.multiplayer.battleFacts === null) && (
                                                <Typography.Text type="secondary">
                                                    权威统计暂不可用。
                                                </Typography.Text>
                                            )}
                                        </div>
                                    </div>
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">链路状态</div>
                                        <div className="admin-dash-kv">
                                            <DashKvItem label="控制面连通性">
                                                {status.multiplayer.hub === null
                                                    ? "不适用"
                                                    : status.multiplayer.hub.available ? "可用" : "不可用"}
                                            </DashKvItem>
                                            <DashKvItem label="控制面地址">{status.multiplayer.hub?.endpoint ?? "-"}</DashKvItem>
                                            <DashKvItem label="TCP 服务">
                                                {status.multiplayer.tcp.available ? "可用" : "不可用"}
                                            </DashKvItem>
                                            <DashKvItem label="TCP 地址"><span className="admin-mono">{status.multiplayer.tcp.endpoint ?? "-"}</span></DashKvItem>
                                        </div>
                                    </div>
                                    {status.multiplayer.latestCompatibilityRejection ? (
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
                                    ) : (
                                        <Typography.Text type="secondary">暂无兼容性拒绝记录。</Typography.Text>
                                    )}
                                </div>
                            )}
                        </Card>
                    </Col>
                </Row>

                <Row gutter={[16, 16]}>
                    <Col span={24}>
                        <Card title="CDN 基线 / 补丁 Overlay" style={{ height: "100%" }} className="admin-dash-card">
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载 CDN 状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="CDN 信息加载失败" />
                            ) : (
                                <div className="admin-dash-cols">
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">版本</div>
                                        <div className="admin-dash-section-body">
                                            <div className="admin-metric-row">
                                                <Statistic className="admin-stat-tick" title="国服最终基线" value={status.cdn.baseline.cnFinalVersion} />
                                                <Statistic className="admin-stat-tick" title="当前资源版本" value={status.cdn.extension.effectiveVersionPreview} />
                                                <Statistic className="admin-stat-tick" title="补丁版本" value={status.cdn.extension.enabledPatchCount} />
                                            </div>
                                            <div className="admin-page-note">
                                                <Typography.Text strong>当前 Content Snapshot：{status.cdn.extension.effectiveVersionPreview}</Typography.Text>
                                                <Typography.Text type="secondary">{status.cdn.extension.note}</Typography.Text>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">来源与存储</div>
                                        <div className="admin-dash-kv">
                                            <DashKvItem label="资源模式">{status.cdn.storage.mode}</DashKvItem>
                                            <DashKvItem label="CDN 地址"><span className="admin-mono">{status.cdn.baseUrl ?? "客户端自带"}</span></DashKvItem>
                                            <DashKvItem label="数据来源">{status.cdn.baseline.source}</DashKvItem>
                                            <DashKvItem label="完整包版本">{status.cdn.baseline.fullVersion}</DashKvItem>
                                            <DashKvItem label="Snapshot 声明归档">
                                                {status.cdn.storage.archiveCount} 个 ZIP / {formatBytes(status.cdn.storage.archiveBytes)}
                                            </DashKvItem>
                                            <DashKvItem label="内容来源">
                                                {status.cdn.contentRelease.source === "release" ? "Content Release" : "内置基线"}
                                            </DashKvItem>
                                        </div>
                                    </div>
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">覆盖范围</div>
                                        <Space wrap>
                                            {status.cdn.baseline.dataScope.map(scope => (
                                                <Tag key={scope}>{cdnScopeLabels[scope] || scope}</Tag>
                                            ))}
                                        </Space>
                                    </div>
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">内容摘要</div>
                                        <div className="admin-dash-digest">
                                            <div className="admin-dash-digest-row">
                                                <span className="admin-dash-kv-label">Release</span>
                                                <Typography.Text code className="admin-mono">
                                                    {status.cdn.contentRelease.releaseDigest?.slice(0, 23) ?? "bundled"}
                                                </Typography.Text>
                                            </div>
                                            <div className="admin-dash-digest-row">
                                                <span className="admin-dash-kv-label">业务内容摘要</span>
                                                <Typography.Text code className="admin-mono" copyable={{ text: status.cdn.contentRelease.contentDigest }}>
                                                    {status.cdn.contentRelease.contentDigest.slice(0, 23)}
                                                </Typography.Text>
                                            </div>
                                            <div className="admin-dash-digest-row">
                                                <span className="admin-dash-kv-label">多人内容摘要</span>
                                                <Typography.Text code className="admin-mono" copyable={{ text: status.cdn.contentRelease.multiBattleContentDigest }}>
                                                    {status.cdn.contentRelease.multiBattleContentDigest.slice(0, 23)}
                                                </Typography.Text>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">Snapshot 中已声明补丁</div>
                                        <div className="admin-page-note">
                                            <span className={status.cdn.extension.runtimeEnabled ? "admin-badge-ok" : "admin-badge-info"}>
                                                {status.cdn.extension.runtimeEnabled ? "Snapshot 含 Overlay" : "无补丁"}
                                            </span>
                                            <Tag>归档 {status.cdn.extension.activePatchArchiveCount}</Tag>
                                            {status.cdn.extension.versions.map(version => (
                                                <Tag key={version} color="blue">{version}</Tag>
                                            ))}
                                            {!status.cdn.extension.runtimeEnabled && (
                                                <Typography.Text type="secondary">
                                                    当前固定 Content Snapshot 未包含补丁。
                                                </Typography.Text>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </Card>
                    </Col>
                </Row>

                <Row gutter={[16, 16]}>
                    <Col xs={24} md={12}>
                        <Card title="账号 / 存档概况" style={{ height: "100%" }} className="admin-dash-card">
                            <div className="admin-dash-sections">
                                <div className="admin-dash-section">
                                    <div className="admin-dash-section-title">快捷入口</div>
                                    <div className="admin-dash-section-body">
                                        <Space wrap>
                                            <Button icon={<TeamOutlined />} onClick={() => navigate("/accounts")}>账号 / 存档</Button>
                                            <Button icon={<MailOutlined />} onClick={() => navigate("/mail")}>邮件</Button>
                                            <Button icon={<ExperimentOutlined />} onClick={() => navigate("/seeds")}>动画种子</Button>
                                        </Space>
                                    </div>
                                </div>
                                {accountsError ? (
                                    <div className="admin-dash-section">
                                        <div className="admin-dash-section-title">账号与存档</div>
                                        <div className="admin-dash-section-body">
                                            <Alert
                                                type="error"
                                                showIcon
                                                message="概览数据加载失败"
                                                description="接口 /api/server/accounts 不可用。"
                                            />
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        </Card>
                    </Col>
                    <Col xs={24} md={12}>
                        <Card title="默认存档" style={{ height: "100%" }} className="admin-dash-card">
                            <div className="admin-dash-sections">
                                <div className="admin-dash-section">
                                    <div className="admin-dash-section-title">默认存档说明</div>
                                    <div className="admin-dash-section-body">
                                        <Typography.Text type="secondary">
                                            上传玩家详情页「导出存档」得到的 JSON。之后任意账户「新建存档」时，将用它替换空存档。
                                        </Typography.Text>
                                    </div>
                                </div>
                                <div className="admin-dash-section">
                                    <div className="admin-dash-section-title">上传操作</div>
                                    <div className="admin-dash-section-body">
                                        {defSave?.exists ? (
                                            <Space wrap>
                                                <span className="admin-badge-ok">已设置</span>
                                                <Typography.Text>模板玩家：{defSave.playerName || "-"}</Typography.Text>
                                                {defSave.exportedAt && (
                                                    <Typography.Text type="secondary">
                                                        导出于 {new Date(defSave.exportedAt).toLocaleString("zh-CN")}
                                                    </Typography.Text>
                                                )}
                                            </Space>
                                        ) : (
                                            <span className="admin-badge-info">未设置（新建存档为空档）</span>
                                        )}
                                        <Space wrap>
                                            <Upload
                                                showUploadList={false}
                                                accept=".json"
                                                beforeUpload={(file) => { uploadDefault.mutate(file as File); return false }}
                                            >
                                                <Button icon={<UploadOutlined />} loading={uploadDefault.isPending}>
                                                    {defSave?.exists ? "替换默认存档" : "上传默认存档"}
                                                </Button>
                                            </Upload>
                                            {defSave?.exists && (
                                                <Popconfirm
                                                    title="清除默认存档？之后新建存档将为空档。"
                                                    onConfirm={() => clearDefault.mutate()}
                                                    okText="确认" cancelText="取消" okButtonProps={{ danger: true }}
                                                >
                                                    <Button danger icon={<DeleteOutlined />} loading={clearDefault.isPending}>清除</Button>
                                                </Popconfirm>
                                            )}
                                        </Space>
                                    </div>
                                </div>
                            </div>
                        </Card>
                    </Col>
                </Row>
            </Space>
        </AdminPage>
    )
}
