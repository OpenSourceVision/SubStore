# 🧩 Sub-Store 节点处理脚本

本项目提供四个用于 Sub-Store 的节点处理脚本：节点去重、延迟测速、按出口 IP 的地理重命名、节点名称标准化。

文件名前缀就是执行顺序：`1 → 2 → 3 → 4`。脚本"远程链接"填本地路径时写成 `/sub-store/Plug-in/1-Deduplication.js` 这样——开头的单个 `/` 指"当前磁盘根目录"，Sub-Store 后端从项目根目录（含 `sub-store.bundle.js` 的那层）启动，所以它正好指向本目录。

---

## 📋 脚本一览

| 脚本 | 功能 |
|------|------|
| `1-Deduplication.js` | 🔍 多协议精准去重，清理内部属性 |
| `2-latency_test.js` | ⚡ 延迟测速，过滤不通节点，保留原名 |
| `3-geo_rename.js` | 🌐 在线 API 地理重命名，多实例并发，支持缓存与自定义模板 |
| `4-rename.js` | ✏️ 按地区关键词标准化节点名称，支持多语言输出 |

---

## 🔍 1-Deduplication.js

### 功能说明

对代理节点进行协议感知的精准去重。不同协议使用不同的字段组合生成唯一指纹，保留首次出现的节点，移除后续重复项，并清除节点对象上的内部属性 _geo 与 _entrance。

适合在订阅合并后、地理重命名前后使用。无需额外依赖，轻量高效。

> **参数：** 无

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

### ⚠️ 特意排除的字段

- name：不同订阅来源节点名称不同，不参与比较
- flow：仅影响客户端行为，不影响服务端认证
- up / down：Hysteria 带宽限速参数，非认证参数
- congestion-controller：TUIC 拥塞控制算法，性能参数非认证参数
- protocol-param / obfs-param：SSR 可选辅助参数，来源不稳定
- cipher（仅 vmess）：各来源写法不统一（auto / 空均常见）

---

## ⚡ 2-latency_test.js

### 功能说明

将所有节点写入同一份 mihomo 配置，启动单个进程并开启 External Controller，通过 REST API 对所有节点并发发出延迟探测。每个节点最多采样 3 次并取最小值，**只要有一次成功就判定可用**（单次探测失败不等于节点不通），全部采样失败才丢弃；通过的节点保留原名。支持进程级内存缓存，命中缓存的节点跳过重测，失败的节点不写入缓存。

无法开始测速时（内核缺失、端口被别的程序占住、API 上应答的是别人的实例）一律保留全部未测节点并报错，不会根据"根本没跑起来的测速"丢弃任何节点。

### 🔧 前置条件

下载 [mihomo 内核](https://github.com/MetaCubeX/mihomo/releases) 并放置于 Sub-Store 同目录：
- 🪟 Windows：`mihomo.exe`
- 🐧 Linux / 🍎 macOS：`mihomo`

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| mihomo_path | mihomo 二进制绝对路径（可选） | 自动搜索 |
| api_port | External Controller 首选端口，被占用时自动改用系统分配的空闲端口 | 9191 |
| proxy_port | mihomo 混合代理首选端口，同上 | 14000 |
| test_url | 延迟测试 URL | `http://www.gstatic.com/generate_204` |
| test_timeout | 延迟测试超时（毫秒） | 5000 |
| test_count | 每节点采样次数，取最小值；有一次成功即判定可用 | 3 |
| delay_concurrency | 并发测速节点数 | 10 |
| cache_enabled | 是否启用缓存 | true |
| cache_ttl | 缓存有效期（毫秒） | 3600000（1 小时） |

---

## 🌐 3-geo_rename.js

### 功能说明

按 `i % 并发数` 把待查节点平均分片，每片各起一个独立 mihomo 实例，片内串行 `切换节点 → 请求地理 API → 取数据`，整体速度约为单实例的 N 倍。每个实例都会先核对自己的分组节点表再采信结果，实例身份校验不过只影响所在分片（该片节点按查询失败处理），其它分片照常。

支持文件持久化缓存与强制刷新。查询失败、切换失败或内核不可用时不会把节点改成"未知 01"这类假结果，默认保留原名（`失败处理=remove` 则丢弃）。分组序号一律按 `proxies` 原顺序统计，因此 `美国 01 / 02` 的编号与并发数无关。

重命名示例：`美国 01 Cloudflare`、`日本 02 NTT`

### 🔧 前置条件

同 `2-latency_test.js`，需要 mihomo 内核。

### 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 内核路径 | mihomo 二进制绝对路径（可选） | 自动搜索 |
| API端口 | External Controller 首选端口，被占用时自动改用系统分配的空闲端口（每个实例各自取号，取号过程串行化） | 9292 |
| 代理端口 | mihomo 混合代理首选端口，同上 | 14000 |
| 并发数 | 同时运行的 mihomo 实例数量（1–16） | 4 |
| 查询地址 | 地理查询 API URL，必须为 `http://`（经 mihomo 转发，不支持 https 隧道） | `http://ip-api.com/json/?fields=country,isp,org,city&lang=zh-CN` |
| 查询超时 | 单次查询超时（毫秒） | 8000 |
| 命名模板 | 支持 {country} {seq} {isp} {org} {city} | {country} {seq} {isp} |
| 失败处理 | keep 保留原名 \| remove 丢弃节点 | keep |
| 缓存有效期 | 缓存有效期（小时），0 表示永不过期 | 24 |
| 强制刷新 | 忽略缓存重新查询（只影响命中判断，不清空其它条目） | false |
| 缓存键 | 缓存文件名前缀（非法字符自动替换为 `_`） | geo_cache |

> ⚠️ 用默认的 ip-api 时注意：免费档约 45 次/分钟，并发数 >1 会显著提高触发 HTTP 429 的概率（脚本会在开跑前提示）。被限流时按查询失败处理、不写缓存，节点保留原名。要么把 并发数 调到 2 左右，要么把 查询地址 换成自建/不限流的地理服务。

### 💾 缓存机制

缓存以 JSON 文件形式持久化存储于 mihomo 同目录，文件名由 缓存键 参数决定（如 `geo_cache.json`）。节点指纹由 `类型|服务器|端口` 组成。查询成功写入缓存，失败不写入。

写入前会与磁盘上的现有内容合并，再原子替换文件：同一目录被多个订阅共用时不会互相抹掉条目，中途崩溃也不会留下半个 JSON。

---

## ✏️ 4-rename.js

> 本脚本来自 [Keywos/rule](https://github.com/Keywos/rule)，感谢作者的开源贡献。

### 功能说明

通过关键词匹配识别节点所属地区，将节点名称标准化为指定格式（中文、英文缩写、英文全称、国旗），并自动添加序号。支持倍率保留、机场名前缀、自定义分隔符等多项配置。

### 参数说明

#### 🔤 输入 / 输出格式

| 参数 | 说明 | 可选值 |
|------|------|--------|
| in | 指定输入节点名的语言类型（不填则自动判断，优先级：中文 → 国旗 → 英文全称 → 英文缩写） | zh / cn、en / us、flag / gq、quan |
| out | 输出节点名格式 | zh / cn（中文）、en / us（英文缩写）、flag / gq（国旗）、quan（英文全称） |

#### 🔣 分隔符与序号

| 参数 | 说明 | 默认值 |
|------|------|--------|
| fgf | 各字段之间的分隔符 | 空格 |
| sn | 国家名与序号之间的分隔符 | 空格 |
| one | 清理只有一个节点的地区的 01 后缀 | false |

#### 🏷️ 前缀

| 参数 | 说明 |
|------|------|
| name | 给节点添加机场名称前缀 |
| nf | 将 name 前缀置于最前面（默认在国家名之后） |

#### 🔧 保留与过滤

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

## 💡 使用建议

| 场景 | 推荐脚本 |
|------|----------|
| 仅需去重清理 | `1-Deduplication.js` |
| 仅需过滤不通节点 | `2-latency_test.js` |
| 按出口 IP 重命名 | `3-geo_rename.js`（节点多时把 并发数 调到 2–4） |
| 只想按地区关键词标准化名称、不查出口 IP | `4-rename.js` |
| 完整工作流 | `1-Deduplication.js` → `2-latency_test.js` → `3-geo_rename.js` → `4-rename.js` |
