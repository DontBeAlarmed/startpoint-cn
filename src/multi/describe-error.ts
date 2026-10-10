// multi 域日志卫生约定（handshake_lifecycle 静态扫描守护）：console.* 不得
// 直接输出未包装的 caught Error（Error 对象可能携带内网地址/绝对路径等
// 敏感字段）——一律经 describeError 取 message 文本再入日志。
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
