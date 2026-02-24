# geo_rename_local.js

Sub-Store 脚本操作（本地数据库版）。通过 mihomo 内核将请求从**节点自身**发出，完成延迟测试和落地地理查询，最终按 `国家 序号 ISP` 格式重命名并过滤不可用节点。

地理查询完全离线，查询 MaxMind GeoLite2 本地 mmdb 数据库，无网络请求、无限速、毫秒级响应。

```
美国 01 Cloudflare, Inc.
美国 02 Zayo Bandwidth
日本 01 NTT Communications Corporation
香港 01 PCCW Limited
```

---

## 与在线版的区别

| | geo_rename_egress.js（在线版） | geo_rename_local.js（本地版） |
|---|---|---|
| IP 来源 | ip-api.com（一次请求同时返回 IP + 地理信息） | checkip.amazonaws.com（纯文本 IP） |
| 地理查询 | 网络请求 ip-api.com | 本地 mmdb 文件，离线查询 |
| 限速 | 无（每个请求出口 IP 不同） | 无 |
| 额外依赖 | 无 | 需要两个 mmdb 数据库文件 |
| 查询速度 | 受网络延迟影响 | 毫秒级 |

---

## 工作流程

```
每个节点
  ↓
启动独立 mihomo 实例（本地临时端口）
  ↓
延迟测试（通过节点请求 gstatic.com/generate_204）
  ├─ 超时 / 非 2xx → 节点不通，直接舍弃
  └─ 2xx → 记录延迟，继续
      ↓
获取真实出口 IP（通过节点请求 checkip.amazonaws.com）
  ├─ 失败 → 保留节点，标记为"未知"
  └─ 成功 → 得到真实 IP（非域名/CDN）
      ↓
本地 mmdb 查询（纯内存，毫秒级）
  GeoLite2-Country.mmdb → 中文国家名
  GeoLite2-ASN.mmdb     → ISP / 组织名
      ↓
关闭 mihomo，清理临时文件
```

---

## 前置条件

### 1. mihomo 内核

前往 [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) 下载对应系统的二进制。

**Windows**：重命名为 `mihomo.exe`，放在 Sub-Store 同目录
**Linux / macOS**：重命名为 `mihomo`，放在 Sub-Store 同目录

脚本按以下顺序自动搜索，无需配置参数：

```
<Sub-Store 目录>/mihomo.exe   （Windows）
<Sub-Store 目录>/mihomo       （Linux/macOS）
~/mihomo
/usr/local/bin/mihomo          （Linux/macOS）
C:\mihomo\mihomo.exe           （Windows）
```

### 2. MaxMind GeoLite2 数据库

前往 [MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) 免费注册并下载：

- `GeoLite2-Country.mmdb`
- `GeoLite2-ASN.mmdb`

在 Sub-Store 同目录下新建 `mmdb` 文件夹，将两个文件放入：

```
<Sub-Store 目录>/
├── mihomo.exe          （或 mihomo）
├── mmdb/
│   ├── GeoLite2-Country.mmdb
│   └── GeoLite2-ASN.mmdb
└── geo_rename_local.js
```

---

## 在 Sub-Store 中使用

1. 打开 Sub-Store，进入订阅编辑页面
2. 在「脚本操作」中添加新操作
3. 填入脚本的 URL 或本地路径
4. 按需填写参数（均为可选）

---

## 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `mihomo_path` | 自动搜索 | mihomo 二进制的绝对路径 |
| `mmdb_dir` | `<Sub-Store目录>/mmdb` | mmdb 数据库目录的绝对路径 |
| `test_url` | `http://www.gstatic.com/generate_204` | 延迟测试目标地址 |
| `test_timeout` | `5000` | 延迟测试超时，单位毫秒 |
| `ip_timeout` | `10000` | 出口 IP 获取超时，单位毫秒 |
| `concurrency` | `5` | 同时运行的 mihomo 实例数 |
| `start_port` | `14000` | 本地代理起始端口 |
| `cache` | `true` | 启用地理信息缓存 |

### 参数示例

```
# 手动指定路径（路径含空格时使用）
mihomo_path=C:\Program Files\mihomo\mihomo.exe
mmdb_dir=D:\mmdb

# 提高并发
concurrency=8

# 延长超时（节点延迟普遍较高时）
test_timeout=8000
ip_timeout=15000
```

---

## 注意事项

**mmdb 数据库来源**
脚本针对 MaxMind 官方 GeoLite2 格式编写。国家名优先使用 `zh-CN`（简体中文），没有中文时回退到英文。ISP 字段来自 ASN 数据库的 `autonomous_system_organization` 字段。

**延迟测试与地理查询的取舍逻辑**
- 延迟测试不通（超时或节点返回非 2xx）→ 节点直接舍弃，不出现在结果中
- 延迟测试通过但 IP/地理查询失败 → 节点保留，名称显示为 `未知 01`
- 只有延迟测试结果不走缓存，每次都实时测

**缓存机制**
地理信息以 `节点server:port:type` 为 key 缓存。同一节点配置下次运行直接命中缓存，不会再启动 mihomo 做地理查询（但延迟测试依然执行）。

**并发数建议**
每个并发节点启动一个独立 mihomo 进程。内存或 CPU 有限时建议保持默认 `5`，节点数量很多时可适当提高到 `8~10`。

**数据库更新**
MaxMind 每周更新一次 GeoLite2 数据库。建议定期下载最新版本替换 mmdb 目录下的文件，以保持地理信息准确。
