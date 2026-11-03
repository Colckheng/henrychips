# 在服务器上部署中继服务

你的服务器是 Firecracker 微虚拟机：它提供虚拟化但不含容器运行时，所以**不要用 Docker**，直接跑 Node 进程 + systemd。下面是完整步骤。

## 1. 准备 Node

Firecracker 里的 Debian 13 需要 Node 22.13 以上（工作站与中继同版本最省事）：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
```

## 2. 部署中继

```bash
sudo mkdir -p /opt/henry/relay/data
sudo useradd --system --home /opt/henry/relay henry
# 把 relay 目录、dist 与 node_modules 复制到 /opt/henry/relay
cd /opt/henry/relay
sudo chown -R henry:henry /opt/henry/relay
```

生成配置（`pairCode` 是手机和桌面端配对用的口令，`deviceToken` 是所有设备都要带的共享令牌）：

```bash
node -e 'const c=require("crypto");console.log(JSON.stringify({
  address:"http://<服务器公网IP>:4319", port:4319,
  pairCode:c.randomBytes(3).toString("hex"),
  dataDirectory:"/opt/henry/relay/data",
  deviceToken:c.randomBytes(24).toString("base64url")},null,2))' > relay.config.json
sudo chmod 600 relay.config.json
```

## 3. 开机自启

```bash
sudo cp deploy/henry-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now henry-relay
sudo systemctl status henry-relay
```

## 4. 放行端口

```bash
sudo ufw allow 4319/tcp
```

若用 nftables/firewalld 请按你的系统放行。

## 5. 没有域名怎么办

- 客户端访问：`http://<服务器IP>:4319`，HTTP 明文。配对码和令牌在传输中可见，**只在自己的局域网或可信网络里这样用**。
- 想加密：给中继套一层 TLS。最省事的做法是让 Caddy 用 IP 签证书（Let's Encrypt 已支持 IP 证书）：

  ```bash
  # /etc/caddy/Caddyfile
  http://<服务器IP>:4319 {
    reverse_proxy 127.0.0.1:4319
  }
  ```

  这样外部仍是 4319 端口，内部中继只监听回环地址，更安全。

## 6. 在工作台配对

在**每台设备**上执行：

```bash
npm run relay:pair -- http://<服务器IP>:4319 <配对码> <设备名> --token <deviceToken>
```

凭据写入 `workstation.config.json` 的 `relay` 段。然后在这台设备上启动节点连接器：

```bash
npm run relay:node
```

## 7. 桌面端（Electron）

桌面版自带运行时，安装后不需要另外装 Node：

```bash
npm run desktop          # 直接启动桌面外壳
npm run desktop:dist     # 打包成 Windows 安装包（输出到 release/）
```

安装包第一次启动时会在 `%APPDATA%/personal-workstation/` 下建立自己的配置与工作区：

| 文件 | 用途 |
| --- | --- |
| `workstation.config.json` | 本机端口、目录与限额 |
| `sandbox/` | 可读的工作区文件 |
| `sandbox/downloads/` | 工具产物的输出目录 |
| `state/runs/` | 运行摘要 |

托盘菜单里有「打开工作台」「打开输出文件夹」「开机自动启动」和「退出」。关掉窗口只是隐藏窗口，进程留在托盘里继续提供服务；要真正结束请点「退出」。

中继凭据在桌面端同样通过 `workstation.config.json` 的 `relay` 段读取。命令行配对会改写项目目录里的配置文件；桌面端要连服务器，请把同样的 `relay` 段加到 `%APPDATA%/personal-workstation/workstation.config.json` 里。

## 8. 手机端怎么用

手机浏览器打开 `http://<服务器IP>:4319` 之后调用中继接口：

```bash
# 看有哪些设备
curl -H "Authorization: Bearer <deviceToken>" http://<服务器IP>:4319/relay/devices

# 给某台设备派任务
curl -X POST -H "Authorization: Bearer <deviceToken>" -H "Content-Type: application/json" \
  -d '{"deviceId":"<设备ID>","tool":"csv_summary","input":{"path":"samples/sales.csv"}}' \
  http://<服务器IP>:4319/relay/tasks

# 查任务结果
curl -H "Authorization: Bearer <deviceToken>" "http://<服务器IP>:4319/relay/tasks?deviceId=<设备ID>"
```

## 注意事项

- 中继**不执行工具**，只做登记、路由与结果中转；工具永远在设备本地跑，产物也留在设备本地。
- `node:sqlite` 是 Node 22 的内置实验特性，Node 22.13 起可用；如果服务器上更早的 Node，请改用 `better-sqlite3`。
- 设备令牌泄露等于任何人都能派任务给你的设备，务必只发给可信设备，并定期更换。
