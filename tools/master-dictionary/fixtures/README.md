# config_iosbundled 权威 fixture

- 来源：APK `apk/com.leiting.wf.apk` → `assets/bundle.zip` →
  `production/android_bundle/20/18bd1c457a0959dc69057188941aec1a9793b6`（213 字节）。
- 结构：前 4 字节小端长度头 + 两个 zlib 流；第二流解压为**逗号分隔 CSV**（单行 52 值）。
- 列序权威：`wf-cn-client-as3-20261014/scripts/pinball/master/generated/ConfigValues.as`
  构造器的 `param1[N]` 声明顺序（col0=continue_virtual_money … col7=max_star_crumb …）。
- CDN `orderedmap/config/config.json` 为 3 字节空表——客户端运行时以本内置副本为权威，
  CDN 版不覆盖。
- 解码命令参考：`unzip -p com.leiting.wf.apk assets/bundle.zip > bundle.zip` 后按
  体积定位 213B 成员，`zlib.decompress` 扫描全部 `78 xx` 流。
