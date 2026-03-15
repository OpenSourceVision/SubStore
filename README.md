# Sub-Store 节点处理脚本

本项目提供五个用于 Sub-Store 的节点处理脚本，覆盖节点去重、延迟测试、地理重命名（在线与本地版）以及节点名称标准化重命名。

---

## 脚本一览

| 脚本 | 功能 |
|------|------|
| `Deduplication.js` | 多协议精准去重，清理内部属性 |
| `latency_test.js` | 延迟测速，过滤不通节点，保留原名 |
| `geo_rename.js` | 在线 API 地理重命名，支持缓存与自定义模板 |
| `geo_rename_local.js` | 本地 mmdb 数据库地理重命名，无网络依赖 |
| `rename.js` | 按地区关键词标准化节点名称，支持多语言输出 |

---

## Deduplication.js

### 功能说明

对代理节点进行协议感知的精准去重。不同协议使用不同的字段组合生成唯一指纹，保留首次出现的节点，移除后续重复项，并清除节点对象上的内部属性 _geo 与 _entrance。

### 各协议参与去重的字段

| 协议 | 去重字段 |
|------|----------|
| `ss` | server, port, type, password, cipher |
| `ssr` | server, port, type, password, cipher, protocol, obfs |
| `vmess` | server, port, type, uuid, alterId, network, tls, servername, path, host |
| `vless` | server, port, type, uuid, network, tls, servername, path, host, reality-public-key, reality-short-id |
| `trojan` | server, port, type, password, network, tls, servername, path, host |
| `hysteria` | server, port, type, auth-str, protocol, sni |
| `hysteria2` | server, port, type, password, sni, obfs, obfs-password |
| `tuic` | server, port, type, uuid, password, token, sni |
| `wireguard` | server, port, type, private-key, public-key, ip, ipv6, preshared-key |
| `http` / `https` | server, port, type, username, password, tls, sni |
| `socks5` | server, port, type, username, password, tls, sni |
| `anytls` | server, port, type, password, sni |
| 其他（兜底） | server, port, type, password |

### 特意排除的字段

- name：不同订阅来源节点名称不同，不参与比较
- flow：仅影响客户端行为，不影响服务端认证
- up / down：Hysteria 带宽限速参数，非认证参数
- congestion-controller：TUIC 拥塞控制算法，性能参数非认证参数
- protocol-param / obfs-param：SSR 可选辅助参数，来源不稳定
- cipher（仅 vmess）：各来源写法不统一（auto / 空均常见）

**参数：** 无

适合在订阅合并后、地理重命名前后使用。无需额外依赖，轻量高效。

---

## latency_test.js

### 功能说明

将所有节点写入同一份 mihomo 配置，启动单个进程并开启 External Controller，通过 REST API 对所有节点并发发出延迟探测。每个节点默认采样 3 次取最小值，不通的节点直接丢弃，通过的节点保留原名。支持进程级内存缓存，命中缓存的节点跳过重测，失败的节点不写入缓存。

### 前置条件

下载 [mihomo 内核](https://github.com/MetaCubeX/mihomo/releases) 并放置于 Sub-Store 同目录：
- Windows：`mihomo.exe`
- Linux / macOS：`mihomo`

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| mihomo_path | mihomo 二进制绝对路径（可选） | 自动搜索 |
| api_port | External Controller 端口 | 9191 |
| proxy_port | mihomo 混合代理端口 | 14000 |
| test_url | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| test_timeout | 延迟测试超时（毫秒） | 5000 |
| test_count | 每节点采样次数，取最小值 | 3 |
| delay_concurrency | 并发测速节点数 | 10 |
| cache_enabled | 是否启用缓存 | true |
| cache_ttl | 缓存有效期（毫秒） | 3600000（1 小时） |

---

## geo_rename.js

### 功能说明

启动单个 mihomo 进程，串行逐一切换节点，通过节点自身出口调用在线地理 API，按可自定义的命名模板重命名。支持文件持久化缓存、强制刷新，以及查询失败时保留原名或丢弃节点两种策略。

重命名示例：`美国 01 Cloudflare`、`日本 02 NTT`

### 前置条件

同 `latency_test.js`，需要 mihomo 内核。

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 内核路径 | mihomo 二进制绝对路径（可选） | 自动搜索 |
| API端口 | External Controller 端口 | 9292 |
| 代理端口 | mihomo 混合代理端口 | 14000 |
| 查询地址 | 地理查询 API URL | `http://ip-api.com/json/?fields=country,isp,org,city&lang=zh-CN` |
| 查询超时 | 单次查询超时（毫秒） | 8000 |
| 命名模板 | 支持 {country} {seq} {isp} {org} {city} | {country} {seq} {isp} |
| 失败处理 | keep 保留原名 \| remove 丢弃节点 | keep |
| 缓存有效期 | 缓存有效期（小时），0 表示永不过期 | 72 |
| 强制刷新 | 忽略缓存重新查询 | false |
| 缓存键 | 缓存文件名前缀 | geo_cache |

### 缓存机制

缓存以 JSON 文件形式持久化存储于 mihomo 同目录，文件名由 缓存键 参数决定（如 `geo_cache.json`）。节点指纹由 `类型|服务器|端口` 组成。查询成功写入缓存，失败不写入。

---

## geo_rename_local.js

### 功能说明

与 `geo_rename.js` 功能相同，但地理查询不依赖在线 API，改用本地 MaxMind GeoLite2 数据库（mmdb 格式）在毫秒内完成查询，无网络请求，无速率限制。

工作流程分为两个阶段：
1. **延迟测试**：单进程 + mihomo API 并发测速，舍弃不通节点
2. **地理查询**：对存活节点各起独立 mihomo 进程，通过 `checkip.amazonaws.com` 获取出口 IP，再查询本地 mmdb

脚本内置完整的 mmdb 二进制格式解析器，支持 24 / 28 / 32 位 record size 及所有数据类型，无需任何外部 npm 依赖。

### 前置条件

1. **mihomo 内核**（同上）
2. **MaxMind GeoLite2 数据库**，放置于 Sub-Store 同目录下的 `mmdb/` 文件夹：
   - `mmdb/GeoLite2-Country.mmdb`
   - `mmdb/GeoLite2-ASN.mmdb`
   - 下载：[MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data)（免费注册后可获取）

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| mihomo_path | mihomo 二进制绝对路径（可选） | 自动搜索 |
| mmdb_dir | mmdb 目录绝对路径（可选） | `<Sub-Store目录>/mmdb` |
| api_port | External Controller 端口 | 9090 |
| test_url | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| test_timeout | 延迟测试超时（毫秒） | 5000 |
| concurrency | 地理查询并发数 | 5 |
| delay_concurrency | 延迟测试并发数 | 10 |
| ip_timeout | IP 查询超时（毫秒） | 10000 |
| start_port | 本地代理起始端口 | 14000 |
| cache | 启用缓存 | true |

适用于对在线 API 有速率限制顾虑、节点数量大且频繁刷新，或网络环境不稳定的场景。

---

## rename.js

> 本脚本来自 [Keywos/rule](https://github.com/Keywos/rule)，感谢作者的开源贡献。

### 功能说明

通过关键词匹配识别节点所属地区，将节点名称标准化为指定格式（中文、英文缩写、英文全称、国旗），并自动添加序号。支持倍率保留、机场名前缀、自定义分隔符等多项配置。

### 参数说明

#### 输入 / 输出格式

| 参数 | 说明 | 可选值 |
|------|------|--------|
| in | 指定输入节点名的语言类型（不填则自动判断，优先级：中文 → 国旗 → 英文全称 → 英文缩写） | zh / cn、en / us、flag / gq、quan |
| out | 输出节点名格式 | zh / cn（中文）、en / us（英文缩写）、flag / gq（国旗）、quan（英文全称） |

#### 分隔符与序号

| 参数 | 说明 | 默认值 |
|------|------|--------|
| fgf | 各字段之间的分隔符 | 空格 |
| sn | 国家名与序号之间的分隔符 | 空格 |
| one | 清理只有一个节点的地区的 01 后缀 | false |

#### 前缀

| 参数 | 说明 |
|------|------|
| name | 给节点添加机场名称前缀 |
| nf | 将 name 前缀置于最前面（默认在国家名之后） |

#### 保留与过滤

| 参数 | 说明 |
|------|------|
| nm | 保留未匹配到地区的节点（不丢弃） |
| flag | 在节点名前添加国旗 emoji |
| blkey | 保留节点名中的自定义关键词，多个用 + 连接；支持用 > 替换，如 GPT>新名字 |
| blgd | 保留 IPLC、IEPL、家宽、ˣ² 等特殊标识 |
| bl | 正则匹配保留倍率标识（如 0.1x、3×、2倍） |
| blpx | 配合 bl 使用，将保留倍率标识的节点排列到末尾 |
| nx | 过滤掉高倍率节点，仅保留 1 倍率与不显示倍率的 |
| blnx | 仅保留高倍率节点 |
| clear | 清理含套餐、到期、流量等机场信息字样的节点 |
| blockquic | 设置节点的 block-quic 属性：on 阻止 / off 不阻止 |
| key | 仅保留港、美、日、新、韩、土耳其中的特定节点 |
| debug | 调试模式 |

---

## 使用建议

| 场景 | 推荐脚本 |
|------|----------|
| 仅需去重清理 | `Deduplication.js` |
| 仅需过滤不通节点 | `latency_test.js` |
| 节点数较少，追求简单 | `geo_rename.js` |
| 在线 API 不稳定 / 不想依赖外部服务 | `geo_rename_local.js` |
| 需要标准化节点名称 | `rename.js` |
| 完整工作流 | `Deduplication.js` → `latency_test.js` → `geo_rename.js` 或 `geo_rename_local.js` |
