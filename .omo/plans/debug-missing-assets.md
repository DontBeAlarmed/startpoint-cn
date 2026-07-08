# 调试缺失资产文件

## 背景
客户端弹窗"数据不足"但未显示具体缺失文件路径。需要在服务端添加文件请求日志来定位。

## 计划

### 步骤1：修改 cn-server.ts 添加日志
文件：`src/cn-server.ts`，行 520-527

修改 `/patch/cn/dummy/download/production/upload/:prefix/:hash` 路由：
- 请求命中时：记录 `[PATCH-SERVE] 200 {prefix}/{hash}`
- 请求未命中（404）时：记录 `[PATCH-MISS] 404 {prefix}/{hash}`

### 步骤2：编译重启
```bash
cd starpoint-cn
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --incremental false
pkill -f "cn-server"; sleep 1
nohup node --env-file=.env out/cn-server.js > /tmp/cn-server.log 2>&1 &
```

### 步骤3：用户操作客户端触发弹窗
用户打开客户端，弹窗出现后点OK，循环一两次。

### 步骤4：分析日志
```bash
grep 'PATCH-MISS' /tmp/cn-server.log
```
从 404 列表中定位缺失文件。

### 步骤5：补全缺失文件并更新补丁
