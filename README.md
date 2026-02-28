# Sub-Store 节点处理脚本说明

## 脚本概览

本项目包含三个用于 Sub-Store 的节点处理脚本，分别负责去重清理、基于在线 API 的出口地理重命名、以及基于本地数据库的出口地理重命名。

---

## 1. Deduplication.js — 节点去重与清理

### 功能

对代理节点数组进行去重，并清除节点对象上残留的内部属性（如 `_geo`、`_entrance`）。

### 去重逻辑

以 `server`、`port`、`type` 三个字段的组合作为唯一键，当多个节点具有相同的服务器地址、端口号和协议类型时，只保留第一个，其余丢弃。

### 适用场景

在订阅合并后、地理重命名前后，用于清理重复节点。无需额外依赖，轻量高效。

### 参数

无。

---

## 2. geo_rename_egress.js — 在线地理重命名（v1，单进程版）

### 功能

通过 mihomo 内核将请求从**节点自身**发出，完成两件事：

- **延迟测试**：不通的节点直接丢弃。
- **出口地理查询**：调用在线 API（默认 ip-api.com）查询节点落地的真实 IP 归属，按 `国家 序号 ISP` 格式重命名。

最终效果示例：`美国 01 Cloudflare`、`日本 02 NTT`

### 工作原理

对每个节点，脚本独立启动一个 mihomo 进程，监听不同端口。通过该端口发出延迟探测请求，再发出地理查询请求，最后关闭进程。多个节点按 `concurrency` 并发执行。

### 前置条件

- 下载 [mihomo 内核](https://github.com/MetaCubeX/mihomo/releases)，放置于 Sub-Store 同目录（Windows 为 `mihomo.exe`，Linux/macOS 为 `mihomo`）。

### 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mihomo_path` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `test_url` | 延迟测试目标 URL | `http://www.gstatic.com/generate_204` |
| `test_timeout` | 延迟测试超时（毫秒） | `5000` |
| `api` | 地理查询 API | `http://ip-api.com/json?fields=country,isp,org&lang=zh-CN` |
| `concurrency` | 并发节点数 | `5` |
| `geo_timeout` | 地理查询超时（毫秒） | `10000` |
| `start_port` | 本地代理起始端口 | `14000` |
| `cache` | 启用地理查询缓存 | `true` |

### 性能特点与局限

每个节点需要单独启动 mihomo 进程，进程启动本身消耗 500ms~2s，节点越多耗时越长。这是 v2 版本诞生的原因。

---

## 3. geo_rename_egress_v2.js — 在线地理重命名（v2，单进程 + API 并发版）

### 功能

与 v1 相同，但对延迟测试阶段做了根本性重构，速度大幅提升。

### 架构改进：两阶段流水线

**阶段一：单进程并发测延迟**

将所有节点写入同一份 mihomo 配置，只启动**一个** mihomo 进程，并开启 External Controller（REST API）。通过调用：

```
GET /proxies/{name}/delay?url=xxx&timeout=xxx
```

mihomo 内核在内部真正并发地对所有节点发出探测，全量节点的延迟测试几乎在同一时间完成，耗时约等于**单个节点的最大延迟**，而非所有节点延迟之和。

**阶段二：对存活节点并发查地理**

仅对通过延迟测试的节点启动独立 mihomo 进程，通过节点自身出口请求地理 API。由于死节点已在阶段一被过滤，进程数量大幅减少。

### 与 v1 的速度对比

```
v1: N 个节点 × (进程启动时间 + 测速时间 + 地理查询时间)
v2: 1 次进程启动 + max(所有节点延迟) + 存活节点地理查询时间
```

节点越多，v2 相对 v1 的提速越显著。

### 参数

在 v1 基础上新增两个参数，其余相同：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `api_port` | External Controller 端口（注意不要与本机已有 clash/mihomo 冲突） | `9090` |
| `proxy_port` | 地理查询阶段临时代理起始端口（原 `start_port`） | `14000` |

---

## 4. geo_rename_local.js — 本地数据库地理重命名

### 功能

与 v1 相同的延迟测试与出口地理重命名，但地理查询不依赖在线 API，改用本地 MaxMind GeoLite2 数据库（mmdb 格式）在毫秒内完成查询，**无网络请求、无限速限制**。

### 工作原理

1. 延迟测试与 v1 相同：每个节点独立启动 mihomo 进程进行探测。
2. 通过节点代理请求 `checkip.amazonaws.com` 获取真实出口 IP 地址。
3. 在本地用纯 JS 解析的 mmdb 阅读器查询 IP 的国家和 ASN 信息，**无需任何外部 npm 依赖**。

脚本内置了完整的 mmdb 二进制格式解析器，支持 MaxMind GeoLite2 的 24/28/32 位 record size，以及指针、UTF-8、map、array 等所有数据类型。

### 前置条件

1. mihomo 内核（同上）
2. MaxMind GeoLite2 数据库，放置于 Sub-Store 同目录下的 `mmdb/` 文件夹：
   - `mmdb/GeoLite2-Country.mmdb`
   - `mmdb/GeoLite2-ASN.mmdb`
   - 下载地址：[MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)（免费注册后可下载）

### 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mihomo_path` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `mmdb_dir` | mmdb 目录绝对路径（可选） | `<Sub-Store目录>/mmdb` |
| `test_url` | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| `test_timeout` | 延迟测试超时（毫秒） | `5000` |
| `concurrency` | 并发节点数 | `5` |
| `ip_timeout` | IP 查询超时（毫秒） | `10000` |
| `start_port` | 本地代理起始端口 | `14000` |
| `cache` | 启用地理查询缓存 | `true` |

### 适用场景

- 对 ip-api.com 等在线 API 有速率限制顾虑。
- 节点数量大、频繁刷新，在线 API 容易触发封禁。
- 网络环境特殊，在线地理查询不稳定。

---

## 脚本选择建议

| 场景 | 推荐脚本 |
|------|----------|
| 仅需去重清理 | `Deduplication.js` |
| 节点数较少（< 30），追求简单 | `geo_rename_egress.js`（v1） |
| 节点数较多，追求速度 | `geo_rename_egress_v2.js`（v2） |
| 在线 API 不稳定 / 不想依赖外部服务 | `geo_rename_local.js` |
| 完整工作流 | `Deduplication.js` → `geo_rename_egress_v2.js` 或 `geo_rename_local.js` |
