import { Alert, Button, Card, Col, Descriptions, Divider, Popconfirm, Row, Space, Statistic, Tag, Typography, Upload, message } from "antd"
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

const multiStateColors = {
    ready: "green",
    degraded: "orange",
    unavailable: "default",
} as const

export default function Dashboard() {
    const qc = useQueryClient()
    const navigate = useNavigate()

    const { data: accounts = [], isLoading: accountsLoading, isError: accountsError, isFetching: accountsFetching } = useQuery({
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
                <Alert
                    type="info"
                    showIcon
                    message="唯一内置管理后台"
                    description="此管理后台随服务端一同构建，用于统一查看运行状态并执行日常管理操作。"
                />

                    <div className="admin-card-grid">
                    <Card title="服务端状态">
                        {statusLoading && !status ? (
                            <Alert type="info" showIcon message="正在加载服务端状态" />
                        ) : statusError || !status ? (
                            <Alert type="error" showIcon message="服务端状态加载失败" description="接口 /api/server/status 不可用。" />
                        ) : (
                            <>
                                <Row gutter={[16, 16]}>
                                    <Col xs={12} sm={8}>
                                        <Statistic title="运行时间" value={formatDuration(status.server.uptimeSeconds)} />
                                    </Col>
                                    <Col xs={12} sm={8}>
                                        <Statistic title="RSS 内存" value={formatBytes(status.server.memory.rss)} />
                                    </Col>
                                    <Col xs={12} sm={8}>
                                        <Statistic title="PID" value={status.server.pid} />
                                    </Col>
                                </Row>
                                <Divider style={{ margin: "16px 0" }} />
                                <Descriptions size="small" column={1}>
                                    <Descriptions.Item label="Node">{status.server.nodeVersion}</Descriptions.Item>
                                    <Descriptions.Item label="平台">{status.server.platform}</Descriptions.Item>
                                    <Descriptions.Item label="监听">{status.server.listenHost}:{status.server.listenPort}</Descriptions.Item>
                                </Descriptions>
                            </>
                        )}
                        </Card>

                        <Card title="多人联机状态">
                            {statusLoading && !status ? (
                                <Alert type="info" showIcon message="正在加载多人联机状态" />
                            ) : statusError || !status ? (
                                <Alert type="error" showIcon message="多人联机状态加载失败" />
                            ) : (
                                <Space direction="vertical" className="admin-stack">
                                    <Space wrap>
                                        <Tag>{multiModeLabels[status.multiplayer.mode]}</Tag>
                                        <Tag color={multiStateColors[status.multiplayer.state]}>
                                            {multiStateLabels[status.multiplayer.state]}
                                        </Tag>
                                        <Tag color={status.multiplayer.coordinator.available ? "green" : "default"}>
                                            {status.multiplayer.coordinator.kind === "local" ? "本地协调器" : "远程协调器"}
                                        </Tag>
                                    </Space>
                                    <Row gutter={[16, 16]}>
                                        <Col xs={12} sm={8}>
                                            <Statistic title="活跃房间" value={status.multiplayer.activeRooms ?? "未知"} />
                                        </Col>
                                        <Col xs={12} sm={8}>
                                            <Statistic title="进行中事实" value={status.multiplayer.battleFacts?.active ?? "未知"} />
                                        </Col>
                                        <Col xs={12} sm={8}>
                                            <Statistic title="已结束事实" value={status.multiplayer.battleFacts?.finalized ?? "未知"} />
                                        </Col>
                                    </Row>
                                    {(status.multiplayer.activeRooms === null
                                        || status.multiplayer.battleFacts === null) && (
                                        <Typography.Text type="secondary">
                                            权威统计暂不可用。
                                        </Typography.Text>
                                    )}
                                    <Descriptions size="small" column={1}>
                                        <Descriptions.Item label="控制面连通性">
                                            {status.multiplayer.hub === null
                                                ? "不适用"
                                                : status.multiplayer.hub.available ? "可用" : "不可用"}
                                        </Descriptions.Item>
                                        <Descriptions.Item label="控制面地址">
                                            {status.multiplayer.hub?.endpoint ?? "-"}
                                        </Descriptions.Item>
                                        <Descriptions.Item label="TCP 服务">
                                            {status.multiplayer.tcp.available ? "可用" : "不可用"}
                                        </Descriptions.Item>
                                        <Descriptions.Item label="TCP 地址">
                                            {status.multiplayer.tcp.endpoint ?? "-"}
                                        </Descriptions.Item>
                                    </Descriptions>
                                    <Divider style={{ margin: "4px 0" }} />
                                    {status.multiplayer.latestCompatibilityRejection ? (
                                        <Space direction="vertical" size="small" className="admin-stack">
                                            <Typography.Text strong>最近兼容性拒绝</Typography.Text>
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
                                                        <Tag color="orange">{difference.field}</Tag>
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
                                        </Space>
                                    ) : (
                                        <Typography.Text type="secondary">暂无兼容性拒绝记录。</Typography.Text>
                                    )}
                                </Space>
                            )}
                        </Card>

                        <Card title="CDN 基线 / 补丁 Overlay">
                        {statusLoading && !status ? (
                            <Alert type="info" showIcon message="正在加载 CDN 状态" />
                        ) : statusError || !status ? (
                            <Alert type="error" showIcon message="CDN 信息加载失败" />
                        ) : (
                            <Space direction="vertical" className="admin-stack">
                                <Alert
                                    type={status.cdn.extension.runtimeEnabled ? "success" : "info"}
                                    showIcon
                                    message={`当前 Content Snapshot：${status.cdn.extension.effectiveVersionPreview}`}
                                    description={status.cdn.extension.note}
                                />
                                <div className="admin-metric-row">
                                    <Statistic title="国服最终基线" value={status.cdn.baseline.cnFinalVersion} />
                                    <Statistic title="当前资源版本" value={status.cdn.extension.effectiveVersionPreview} />
                                    <Statistic title="补丁版本" value={status.cdn.extension.enabledPatchCount} />
                                </div>
                                <Descriptions size="small" column={1}>
                                    <Descriptions.Item label="资源模式">{status.cdn.storage.mode}</Descriptions.Item>
                                    <Descriptions.Item label="CDN 地址">{status.cdn.baseUrl ?? "客户端自带"}</Descriptions.Item>
                                    <Descriptions.Item label="数据来源">{status.cdn.baseline.source}</Descriptions.Item>
                                    <Descriptions.Item label="覆盖范围">
                                        <Space wrap>
                                            {status.cdn.baseline.dataScope.map(scope => (
                                                <Tag key={scope}>{cdnScopeLabels[scope] || scope}</Tag>
                                            ))}
                                        </Space>
                                    </Descriptions.Item>
                                    <Descriptions.Item label="完整包版本">{status.cdn.baseline.fullVersion}</Descriptions.Item>
                                    <Descriptions.Item label="归档">
                                        {status.cdn.storage.archiveCount} 个 ZIP / {formatBytes(status.cdn.storage.archiveBytes)}
                                    </Descriptions.Item>
                                    <Descriptions.Item label="内容来源">
                                        {status.cdn.contentRelease.source === "release" ? "Content Release" : "内置基线"}
                                    </Descriptions.Item>
                                    <Descriptions.Item label="Release">
                                        <Typography.Text code>
                                            {status.cdn.contentRelease.releaseDigest?.slice(0, 23) ?? "bundled"}
                                        </Typography.Text>
                                    </Descriptions.Item>
                                </Descriptions>
                                <Divider style={{ margin: "4px 0" }} />
                                <Space direction="vertical" size="small" className="admin-stack">
                                    <Typography.Text strong>已加载补丁</Typography.Text>
                                    <Space wrap>
                                        <Tag color={status.cdn.extension.runtimeEnabled ? "green" : "default"}>
                                            {status.cdn.extension.runtimeEnabled ? "Overlay 已启用" : "无补丁"}
                                        </Tag>
                                        <Tag>归档 {status.cdn.extension.activePatchArchiveCount}</Tag>
                                        {status.cdn.extension.versions.map(version => (
                                            <Tag key={version} color="blue">{version}</Tag>
                                        ))}
                                    </Space>
                                    {!status.cdn.extension.runtimeEnabled && (
                                        <Typography.Text type="secondary">
                                            当前固定 Content Snapshot 未包含补丁。
                                        </Typography.Text>
                                    )}
                                </Space>
                            </Space>
                        )}
                    </Card>
                </div>

                <div className="admin-card-grid">
                    <Card title="账号 / 存档概况">
                        {accountsError ? (
                            <Alert
                                type="error"
                                showIcon
                                message="概览数据加载失败"
                                description="接口 /api/server/accounts 不可用。"
                            />
                        ) : (
                            <Row gutter={[16, 16]}>
                                <Col xs={24} sm={12}>
                                    <Statistic title="账号总数" value={accountCount} loading={accountsLoading} />
                                </Col>
                                <Col xs={24} sm={12}>
                                    <Statistic title="存档总数" value={saveCount} loading={accountsLoading} />
                                </Col>
                            </Row>
                        )}
                        <Divider style={{ margin: "16px 0" }} />
                        <Space wrap>
                            <Button icon={<TeamOutlined />} onClick={() => navigate("/accounts")}>账号 / 存档</Button>
                            <Button icon={<MailOutlined />} onClick={() => navigate("/mail")}>邮件</Button>
                            <Button icon={<ExperimentOutlined />} onClick={() => navigate("/seeds")}>动画种子</Button>
                        </Space>
                    </Card>

                    <Card title="默认存档">
                        <Space direction="vertical" className="admin-stack">
                            <Typography.Text type="secondary">
                                上传玩家详情页「导出存档」得到的 JSON。之后任意账户「新建存档」时，将用它替换空存档。
                            </Typography.Text>
                            {defSave?.exists ? (
                                <Space wrap>
                                    <Tag color="green">已设置</Tag>
                                    <Typography.Text>模板玩家：{defSave.playerName || "-"}</Typography.Text>
                                    {defSave.exportedAt && (
                                        <Typography.Text type="secondary">
                                            导出于 {new Date(defSave.exportedAt).toLocaleString("zh-CN")}
                                        </Typography.Text>
                                    )}
                                </Space>
                            ) : (
                                <Tag>未设置（新建存档为空档）</Tag>
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
                        </Space>
                    </Card>
                </div>
            </Space>
        </AdminPage>
    )
}
