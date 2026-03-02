# Sub-Store 节点处理脚本

本项目提供四个用于 Sub-Store 的节点处理脚本，覆盖去重清理、延迟测试，以及基于在线 API 或本地数据库的出口地理重命名。

---

## 脚本一览

| 脚本 | 功能 |
|------|------|
| `Deduplication.js` | 节点去重与内部属性清理 |
| `latency_test.js` | 延迟测速，过滤不通节点，保留原名 |
| `geo_rename.js` | 在线地理重命名（串行，支持缓存与命名模板） |
| `geo_rename_local.js` | 本地数据库地理重命名（无网络依赖） |

---

## Deduplication.js

以 `server`、`port`、`type` 三字段的组合为唯一键，保留首个出现的节点，丢弃其余重复项，并清除节点对象上的内部属性 `_geo` 与 `_entrance`。

适合在订阅合并后、地理重命名前后使用。无需额外依赖，轻量高效。

**参数：** 无

---

## latency_test.js

将所有节点写入同一份 mihomo 配置，启动单个进程并开启 External Controller，通过 REST API 并发对所有节点发出延迟探测。每个节点默认采样 3 次并取最小值，不通的节点直接丢弃，通过的节点保留原名。支持进程级缓存，命中缓存的节点跳过重测。

**前置条件：** 下载 [mihomo 内核](https://github.com/MetaCubeX/mihomo/releases)，放置于 Sub-Store 同目录（Windows：`mihomo.exe`，Linux/macOS：`mihomo`）。

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `mihomo_path` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `api_port` | External Controller 端口 | `9090` |
| `proxy_port` | mihomo 混合代理端口 | `14000` |
| `test_url` | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| `test_timeout` | 延迟测试超时（毫秒） | `5000` |
| `test_count` | 每节点采样次数，取最小值 | `3` |
| `delay_concurrency` | 并发数 | `10` |
| `cache_enabled` | 是否启用缓存 | `true` |
| `cache_ttl` | 缓存有效期（毫秒） | `3600000`（1 小时） |

---

## geo_rename.js

启动单个 mihomo 进程，串行逐一切换节点，通过节点自身出口调用在线地理 API，并按可自定义的命名模板重命名。支持文件持久化缓存、强制刷新，以及查询失败时保留原名或丢弃节点。

重命名示例：`美国 01 Cloudflare`、`日本 02 NTT`

**前置条件：** 同 `latency_test.js`，需要 mihomo 内核。

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `内核路径` | mihomo 二进制绝对路径（可选） | 自动搜索 |
| `API端口` | External Controller 端口 | `9090` |
| `代理端口` | mihomo 混合代理端口 | `14000` |
| `查询地址` | 地理查询 API URL | `http://ip-api.com/json/?fields=country,isp,org,city&lang=zh-CN` |
| `查询超时` | 单次查询超时（毫秒） | `8000` |
| `命名模板` | 支持 `{country}` `{seq}` `{isp}` `{org}` `{city}` | `{country} {seq} {isp}` |
| `失败处理` | `keep` 保留原名 \| `remove` 丢弃节点 | `keep` |
| `缓存有效期` | 缓存有效期（小时），`0` 表示永不过期 | `72` |
| `强制刷新` | 忽略缓存重新查询 | `false` |
| `缓存键` | 缓存文件名前缀 | `geo_cache` |

---

## geo_rename_local.js

与 `geo_rename.js` 功能相同，但地理查询不依赖在线 API，改用本地 MaxMind GeoLite2 数据库（mmdb 格式）在毫秒内完成查询，无网络请求，无速率限制。延迟测试阶段采用单进程并发方式，速度更快。

脚本内置完整的 mmdb 二进制格式解析器，支持 24/28/32 位 record size 及所有数据类型，无需任何外部 npm 依赖。

**前置条件**

1. mihomo 内核（同上）
2. MaxMind GeoLite2 数据库，放置于 Sub-Store 同目录的 `mmdb/` 文件夹：
   - `mmdb/GeoLite2-Country.mmdb`
   - `mmdb/GeoLite2-ASN.mmdb`
   - 下载：[MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)（免费注册后可获取）

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

适用于对在线 API 有速率限制顾虑、节点数量大且频繁刷新，或网络环境不稳定的场景。

---

## 使用建议

| 场景 | 推荐脚本 |
|------|----------|
| 仅需去重清理 | `Deduplication.js` |
| 仅需过滤不通节点 | `latency_test.js` |
| 节点数较少，追求简单 | `geo_rename.js` |
| 在线 API 不稳定 / 不想依赖外部服务 | `geo_rename_local.js` |
| 完整工作流 | `Deduplication.js` → `geo_rename.js` 或 `geo_rename_local.js` |
