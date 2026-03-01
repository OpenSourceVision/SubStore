# Sub-Store 节点处理脚本

本项目包含五个用于 Sub-Store 的节点处理脚本，覆盖去重清理、延迟测试、以及基于在线 API 或本地数据库的出口地理重命名。

---

## 脚本一览

| 脚本 | 功能 |
|------|------|
| `Deduplication.js` | 节点去重与内部属性清理 |
| `latency_test.js` | 仅测速，过滤不通节点，保留原名 |
| `geo_rename_egress.js` | 在线地理重命名（v1，每节点独立进程） |
| `geo_rename_egress_v2.js` | 在线地理重命名（v2，单进程 + API 并发） |
| `geo_rename_local.js` | 本地数据库地理重命名（无网络依赖） |

---

## Deduplication.js — 节点去重与清理

以 `server`、`port`、`type` 三字段的组合为唯一键，保留第一个节点，丢弃其余重复项，并清除节点对象上的内部属性 `_geo`、`_entrance`。

适合在订阅合并后、地理重命名前后使用，无需额外依赖，轻量高效。

**参数：** 无

---

## latency_test.js — 节点延迟测试

将所有节点写入同一份 mihomo 配置，启动单个进程并开启 External Controller，通过 REST API 并发对所有节点发出延迟探测。每个节点默认采样 3 次，取最小值，不通的节点直接舍弃，通过的节点保留原名。

**参数**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mihomo_path` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `api_port` | External Controller 端口 | `9090` |
| `proxy_port` | mihomo 混合代理端口 | `14000` |
| `test_url` | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| `test_timeout` | 延迟测试超时（毫秒） | `5000` |
| `test_count` | 每节点采样次数，取最小值 | `3` |
| `delay_concurrency` | 并发数 | `10` |

---

## geo_rename_egress.js — 在线地理重命名 v1

对每个节点独立启动一个 mihomo 进程，完成两件事：

1. **延迟测试**：不通的节点直接丢弃。
2. **出口地理查询**：通过节点自身出口调用在线 API（默认 ip-api.com），按 `国家 序号 ISP` 格式重命名。

重命名示例：`美国 01 Cloudflare`、`日本 02 NTT`

**前置条件：** 下载 [mihomo 内核](https://github.com/MetaCubeX/mihomo/releases)，放置于 Sub-Store 同目录（Windows：`mihomo.exe`，Linux/macOS：`mihomo`）。

**参数**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mihomo_path` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `test_url` | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| `test_timeout` | 延迟测试超时（毫秒） | `5000` |
| `api` | 地理查询 API | `http://ip-api.com/json?fields=country,isp,org&lang=zh-CN` |
| `concurrency` | 并发节点数 | `5` |
| `geo_timeout` | 地理查询超时（毫秒） | `10000` |
| `start_port` | 本地代理起始端口 | `14000` |
| `cache` | 启用地理查询缓存 | `true` |

**局限：** 每个节点需要单独启动 mihomo 进程，进程启动本身消耗 500ms–2s，节点越多耗时越长，这是 v2 诞生的原因。

---

## geo_rename_egress_v2.js — 在线地理重命名 v2

与 v1 功能相同，但对延迟测试阶段做了根本性重构，速度大幅提升。

### 两阶段流水线

**阶段一：单进程并发测延迟**

将所有节点写入同一份 mihomo 配置，只启动一个进程并开启 External Controller，通过 REST API 让 mihomo 内核在内部真正并发地对所有节点发出探测，全量节点的延迟测试耗时约等于单个节点的最大延迟，而非所有节点延迟之和。

**阶段二：对存活节点并发查地理**

仅对通过延迟测试的节点启动独立 mihomo 进程，通过节点自身出口请求地理 API。由于死节点已在阶段一被过滤，进程数量大幅减少。

### 速度对比

```
v1：N 个节点 × (进程启动时间 + 测速时间 + 地理查询时间)
v2：1 次进程启动 + max(所有节点延迟) + 存活节点地理查询时间
```

节点越多，v2 相对 v1 的提速越显著。

**参数**（在 v1 基础上新增两项，其余相同）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `api_port` | External Controller 端口 | `9090` |
| `proxy_port` | 地理查询阶段临时代理起始端口 | `14000` |
| `delay_concurrency` | 延迟测试并发数 | `10` |
| `test_count` | 每节点采样次数，取最小值 | `3` |

---

## geo_rename_local.js — 本地数据库地理重命名

与 v2 延迟测试逻辑相同，但地理查询不依赖在线 API，改用本地 MaxMind GeoLite2 数据库（mmdb 格式）在毫秒内完成查询，无网络请求、无限速限制。

脚本内置了完整的 mmdb 二进制格式解析器，支持 MaxMind GeoLite2 的 24/28/32 位 record size，以及指针、UTF-8、map、array 等所有数据类型，无需任何外部 npm 依赖。

**前置条件**

1. mihomo 内核（同上）
2. MaxMind GeoLite2 数据库，放置于 Sub-Store 同目录的 `mmdb/` 文件夹：
   - `mmdb/GeoLite2-Country.mmdb`
   - `mmdb/GeoLite2-ASN.mmdb`
   - 下载：[MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)（免费注册后可下载）

**参数**

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mihomo_path` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `mmdb_dir` | mmdb 目录绝对路径（可选） | `<Sub-Store目录>/mmdb` |
| `api_port` | External Controller 端口 | `9090` |
| `test_url` | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| `test_timeout` | 延迟测试超时（毫秒） | `5000` |
| `concurrency` | 地理查询并发数 | `5` |
| `delay_concurrency` | 延迟测试并发数 | `10` |
| `ip_timeout` | IP 查询超时（毫秒） | `10000` |
| `start_port` | 本地代理起始端口 | `14000` |
| `cache` | 启用缓存 | `true` |

**适用场景：** 对 ip-api.com 等在线 API 有速率限制顾虑、节点数量大且频繁刷新、或网络环境不稳定时。

---

## 使用建议

| 场景 | 推荐脚本 |
|------|----------|
| 仅需去重清理 | `Deduplication.js` |
| 仅需过滤不通节点 | `latency_test.js` |
| 节点数较少（< 30），追求简单 | `geo_rename_egress.js`（v1） |
| 节点数较多，追求速度 | `geo_rename_egress_v2.js`（v2） |
| 在线 API 不稳定 / 不想依赖外部服务 | `geo_rename_local.js` |
| 完整工作流 | `Deduplication.js` → `geo_rename_egress_v2.js` 或 `geo_rename_local.js` |
