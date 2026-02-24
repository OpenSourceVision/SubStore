# geo_rename_egress.js

Sub-Store 脚本操作。通过 mihomo 内核将请求从**节点自身**发出，对每个节点依次完成延迟测试和落地地理查询，最终按 `国家 序号 ISP` 格式重命名，并过滤掉不可用节点。

```
美国 01 Cloudflare
美国 02 Zayo Bandwidth
日本 01 NTT
香港 01 PCCW
```

---

## 工作流程

```
每个节点
  ↓
启动独立 mihomo 实例（本地临时端口）
  ↓
延迟测试（通过节点发送请求到 gstatic.com）
  ├─ 超时 / 502 → 节点不通，直接舍弃
  └─ 2xx → 记录延迟，继续
      ↓
地理位置查询（通过节点发送请求到 ip-api.com）
  ├─ 失败 → 保留节点，标记为"未知"
  └─ 成功 → 记录国家 + ISP
      ↓
关闭 mihomo，清理临时文件
```

延迟测试和地理查询都从节点出口发出，因此获取的是**真实落地 IP** 的地理信息，不受域名解析和 CDN 中转影响。

---

## 前置条件

### 下载 mihomo 内核

前往 [MetaCubeX/mihomo Releases](https://github.com/MetaCubeX/mihomo/releases) 下载对应系统架构的二进制文件。

| 系统 | 文件名示例 |
|------|-----------|
| Windows x64 | `mihomo-windows-amd64.exe` |
| Linux x64 | `mihomo-linux-amd64` |
| macOS (Apple Silicon) | `mihomo-darwin-arm64` |

### 放置位置

脚本按以下顺序自动搜索 mihomo，**无需配置参数**：

**Windows**（将文件重命名为 `mihomo.exe`）

```
<Sub-Store 目录>\mihomo.exe        ← 推荐，直接放这里
C:\Users\<用户名>\mihomo.exe
C:\Users\<用户名>\mihomo\mihomo.exe
C:\mihomo\mihomo.exe
```

**Linux / macOS**（将文件重命名为 `mihomo`）

```
<Sub-Store 目录>/mihomo            ← 推荐，直接放这里
~/mihomo
/usr/local/bin/mihomo
~/.local/bin/mihomo
```

> Linux / macOS 脚本会自动设置执行权限，无需手动 `chmod`。

---

## 在 Sub-Store 中使用

1. 打开 Sub-Store，进入订阅编辑页面
2. 在「脚本操作」中添加新操作
3. 填入脚本的 URL 或本地路径
4. 按需填写参数（均为可选）

---

## 参数说明

所有参数均为可选，不填则使用默认值。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `mihomo_path` | 自动搜索 | mihomo 二进制的绝对路径，自动搜索找不到时使用 |
| `test_url` | `http://www.gstatic.com/generate_204` | 延迟测试目标地址 |
| `test_timeout` | `5000` | 延迟测试超时，单位毫秒 |
| `api` | `http://ip-api.com/json?fields=country,isp,org&lang=zh-CN` | 地理位置查询 API |
| `geo_timeout` | `10000` | 地理查询超时，单位毫秒 |
| `concurrency` | `5` | 同时运行的 mihomo 实例数 |
| `start_port` | `14000` | 本地代理起始端口，每个节点占用一个端口 |
| `cache` | `true` | 启用地理信息缓存，相同节点配置下次直接使用缓存 |

### 参数示例

```
# 手动指定 mihomo 路径
mihomo_path=C:\tools\mihomo.exe

# 调高并发（节点多时可加速，但会占用更多端口和内存）
concurrency=10

# 缩短延迟测试超时（更快过滤，但可能误杀高延迟节点）
test_timeout=3000

# 关闭缓存（每次强制重新检测）
cache=false
```

---

## 注意事项

**并发数不宜过高**
每个并发节点会启动一个独立的 mihomo 进程，`concurrency=5` 意味着同时运行 5 个 mihomo 实例。内存或 CPU 有限的环境建议保持默认值 `5`，或降至 `3`。

**端口占用**
脚本使用 `start_port` 起始，为每个节点分配独立端口（最多偏移 900 个端口）。确保 `14000–14900` 范围内没有其他服务占用，或通过 `start_port` 参数更换范围。

**地理查询失败不舍弃节点**
延迟测试通过但地理查询失败的节点会被标记为`未知`保留，不会被舍弃。只有延迟测试不通（超时或返回非 2xx）的节点才会被过滤。

**缓存 key**
地理信息以 `节点server:port:type` 为 key 缓存，节点配置不变则直接命中缓存，不会重新启动 mihomo 和发起网络请求。延迟测试每次都会实时执行，不走缓存。
