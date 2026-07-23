# 旧版部署兼容工具

本目录来自上游 StarPoint 的旧版部署与启动工具，供兼容既有脚本引用。它不属于 StarPoint CN 当前受支持的启动流程，也不作为公网部署指南维护。

目录中可能保留 Nginx、systemd、DNS、自签名证书和旧安装脚本等上游文件。这些文件没有按当前 CN 服务端、管理后台、Content Runtime 或安全边界完成持续验证；存在不代表项目承诺其可用性、兼容性或公网安全。

CN 服务端唯一受支持的前台入口是：

```bash
bash scripts/start-cn.sh
```

本项目只支持本机和受信任的局域网运行。公网暴露、反向代理、TLS、防火墙、域名和云平台操作均由部署者自行负责，不在项目支持范围。当前网络变量与安全边界见[网络支持边界](../docs/getting-started/network-boundary.md)。
