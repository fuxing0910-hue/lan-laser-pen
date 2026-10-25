# 局域网网页激光笔

手机与电脑连接同一局域网，电脑生成二维码，手机扫码后通过触控或设备姿态控制红色激光点，并遥控上下翻页。Windows 透明叠加层可以覆盖 Canva 等应用的全屏演示。

项目基于 [SilentTiger/laser-pen](https://github.com/SilentTiger/laser-pen) 改造，保留上游绘图核心与 [MIT 许可](LICENSE)。本仓库已包含局域网版本的完整代码，直接拉取即可使用。

## 功能与适用范围

- 局域网 HTTPS 与加密 WebSocket（WSS），无云端中转、登录或付费环节；网页不依赖外部 CDN、字体或脚本。
- 手机触控定位、一键校准、灵敏度调节、左右/上下反转、上下翻页。
- 按接口能力检测设备方向事件、绝对方向事件、RelativeOrientationSensor 和 Motion 重力数据；有效来源切换时归零。
- 80ms 时间常数的一阶低通与小死区减少抖动；约 500ms 短轨迹在停手后自然淡出。
- Windows 原生透明、置顶、点击穿透、不抢焦点的激光层，支持选择显示器。
- 手机与电脑均可查看传感器状态；断连后可查看最近诊断。

电脑端推荐 **Windows 10/11、Windows PowerShell 5.1、Git、Node.js 22 或更高版本**，建议使用 Node.js 24。手机无需安装本项目应用或 Node.js。

| 手机范围 | 已知情况 |
| --- | --- |
| iPhone | 有用户反馈可用，未提供具体型号、系统及浏览器版本，不代表所有 iPhone 均已验证。 |
| Mate X5 自带华为浏览器 | 有用户反馈陀螺仪控制可用。 |
| Pura X 自带华为浏览器 | 已验证触控定位可用；Relative 传感器实际请求返回 `NotAllowedError`，陀螺仪尚未恢复。 |
| 其他鸿蒙、Android、iPad 等设备 | 使用能力检测及触控备用，仍需在对应系统和浏览器版本上验证。 |

硬件带有陀螺仪不代表浏览器会向网页开放数据。项目不会伪造传感器数据，也不承诺兼容所有鸿蒙版本。

**跨应用透明叠加由 Windows 本地辅助层实现。** 普通网页的透明 CSS 不能使浏览器跨应用置顶。其他桌面系统可运行网页服务，但本仓库的跨应用叠加与系统翻页辅助脚本仅面向 Windows。

## 1. 首次安装

### 1.1 拉取代码与安装依赖

安装 Git 与 Node.js 后，重新打开 PowerShell，在希望保存项目的位置执行：

```powershell
git clone https://github.com/fuxing0910-hue/lan-laser-pen.git
Set-Location lan-laser-pen
npm ci --no-audit --no-fund
```

本地版使用 `package-lock.json` 和 npm。安装依赖及首次下载证书工具需要联网；准备完成后，激光笔本身只在局域网通信。Canva 等演示应用自身的联网需求与本项目无关。

后续命令均从仓库根目录执行。

### 1.2 生成 HTTPS 证书并信任本机 CA

先让电脑连接要与手机共用的局域网，再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-https.ps1 -InstallTrust
```

脚本会：

1. 优先使用已安装的 `mkcert.exe`；没有时从 mkcert 官方 GitHub 发布下载固定的 1.4.4 版本，并校验 SHA-256。自动下载支持 Windows x64 与 ARM64；其他架构需自行安装 mkcert，并用 `-MkcertPath` 指定路径。
2. 检测活动网卡的私网 IPv4，为这些地址及 `localhost`、`127.0.0.1`、`::1` 签发服务器证书。
3. 写入 `certs/lan.pem`、`certs/lan-key.pem`，并导出 DER 格式的公开 CA 证书 `certs/rootCA.cer`。
4. 使用 `-InstallTrust` 时，将公开 CA 导入**当前 Windows 用户**的受信任根证书存储。出现 Windows 证书确认时，需要你手动确认；此步骤不修改全机根证书存储，不要求管理员权限。

省略 `-InstallTrust` 只生成证书，不改变 Windows 信任。也可以手动指定当前电脑的私网 IPv4：

```powershell
$lanIp = Read-Host '输入电脑当前局域网 IPv4'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-https.ps1 -LanIP $lanIp -InstallTrust
```

### 1.3 在手机安装并信任公开 CA

通过 USB 或其他可信的本地传输方式，将 **`certs/rootCA.cer`** 复制到手机并安装为 CA 证书。

- **HarmonyOS / Android：**在系统设置中搜索“安装证书”“CA 证书”或“凭据”，按系统提示安装。不同系统、设备管理策略及浏览器对用户 CA 的信任规则可能不同。
- **iPhone / iPad：**安装 CA 描述文件后，还需进入“设置 → 通用 → 关于本机 → 证书信任设置”，为该 CA 开启完全信任。参考 [Apple 官方说明](https://support.apple.com/zh-cn/102390)。

安装后重新打开手机浏览器，确认局域网 HTTPS 页面没有证书警告，并在页面诊断中显示安全上下文正常。仅点击“继续访问”跳过证书警告，不能代替正常信任。

**只向手机复制公开的 `rootCA.cer`。** `lan-key.pem` 是服务器私钥；mkcert 的 `rootCA-key.pem` 是 CA 私钥，位于项目外的 mkcert CA 目录。两者均不应上传仓库、分享或复制到手机。项目网页服务不提供证书文件下载。

同一 CA 通常只需安装一次。电脑换网或 IP 改变时，应重新签发服务器证书并重启服务；使用下述启动器会自动检查并处理。若换了 CA，则手机也需重新安装对应公开 CA。

## 2. 日常启动、演示与停止

### 推荐：使用启动器

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Start
```

也可在资源管理器中双击仓库里的 **`Start-LaserPen.vbs`**。若系统未启用 VBScript，请使用上面的 PowerShell 命令。

启动器会检查 Node.js、在缺少依赖时执行 `npm ci`、检查当前 IP 对应的证书、在网页构建缺失或过时时重建，然后启动局域网服务和透明激光层，最后打开电脑二维码页。首次缺少证书时会运行证书脚本；若当前 Windows 用户尚未信任 CA，还会尝试导入并可能出现系统确认。因此首次启动仍可能需要联网和人工确认。

重复启动会复用启动器管理的进程。更新源码后再次启动，可按需重建或重启；若端口已被手动启动的其他服务占用，启动器会报错，不会直接终止不属于它的进程。

开始演示：

1. 手机和电脑连接同一 Wi-Fi 或允许设备互访的热点。
2. 在电脑二维码页选择与手机同网的实际局域网地址，手机扫码后用独立系统浏览器打开。不要把电脑的 `localhost` 地址当作手机地址，也不要选择不通的虚拟网卡或 VPN 地址。
3. 先在手机大触控区拖动，确认红点与网络通信正常；再按需启用陀螺仪并校准。
4. 切换到 Canva 的全屏演示窗口，让 Canva 保持前台焦点。透明层会覆盖演示，鼠标点击可穿透。

停止启动器管理的服务与透明层：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Stop
```

也可双击 **`Stop-LaserPen.vbs`**。只想退出透明层时按 **Ctrl+Alt+Q**，局域网服务仍会继续运行。手动停止再启动服务会创建新的配对编号，手机应重新扫描二维码。

### 第二块显示器与其他端口

显示器编号从 1 开始；只有一块屏幕时使用 1。

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Start -Monitor 2
```

若要更换已在运行的显示器设置，先停止透明层或停止服务，再用新参数启动。

改用其他端口时，启动与停止要传入同一个端口，防火墙规则也应使用该端口：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Start -Port 8444
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Stop -Port 8444
```

### 可选：Windows 防火墙规则

若电脑能打开页面、手机却连不上，先检查局域网地址及路由器设备隔离。确需放行时，在**管理员 PowerShell**中进入仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\allow-firewall.ps1
```

脚本仅允许 **Private（专用）网络配置**下的 **LocalSubnet（本地子网）**进入 TCP 8443，不关闭防火墙，也不会自动改变网络类型。仅在信任的家庭或演示网络上，按需将 Windows 网络配置设为专用；公共网络上规则不会生效。

自定义端口或撤销规则：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\allow-firewall.ps1 -Port 8444
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\allow-firewall.ps1 -Port 8444 -Remove
```

## 3. 手机操作与传感器权限

### 触控定位

大触控区整块对应电脑屏幕：中线交点对应屏幕中心，淡网格表示四分之一位置，四角有方向标识。触点圆环及 X/Y 百分比与发送坐标一致，松手后标记保留；旋屏或折叠后仍按相对位置映射。

触控无需传感器权限，适合先验证通信。拖动触控区会暂停陀螺仪；要恢复姿态控制，请打开“陀螺仪与高级设置（可选）”并重新启用。

### 陀螺仪与校准

1. 保持手机浏览器前台、屏幕常亮，确认安全上下文正常。
2. 手机屏幕朝上并略微抬起，让当前屏幕上边缘朝向电脑，点击“启用陀螺仪”。若浏览器实际弹出运动或方向权限提示，请按需允许，再点击“校准归零”。
3. 从 1.0× 灵敏度开始，左右转动及上下俯仰控制红点。仅绕指向轴滚转不会产生同样的指向移动。
4. 若方向与手势相反，分别开启左右/上下反转后再校准。切换横竖屏、数据来源或网络恢复时会重新归零，避免连接旧姿态。

指向模式使用完整姿态；若只有 beta/gamma 或 Motion 重力数据，可尝试倾斜备用。倾斜模式靠左右倾斜手机控制，不能替代真正的水平偏航跟踪。

过滤时间常数为 **80ms**，约在 80ms 后跟随阶跃目标的 63%，并结合约 0.1°小死区。它能减少高频抖动，也会带来一定跟随延迟；不能消除硬件或系统姿态融合的长期漂移。慢漂时可重新校准或尝试倾斜备用。

### 权限状态如何判断

程序按能力检测接口，不按手机品牌硬编码支持名单。没有 `DeviceOrientationEvent.requestPermission()` 或 `DeviceMotionEvent.requestPermission()`，并不代表已授权，也不代表接口一定不可用。`null`、NaN、Infinity 不会被当成角度 0。

“申请浏览器传感器权限”会从真实点击启动浏览器提供的传感器请求流程；“重试传感器授权”可重建传感器实例并重新注册监听。**网页不能强制浏览器弹出原生授权框，也不会用自绘弹窗冒充授权。** 权限查询为 `prompt` 仅表示查询结果，不代表已经弹框或已获准；是否可用要看实际 activate/reading 与有效轴值。

HarmonyOS 6.0.0.120 及以上可检查“设置 → 隐私和安全 → 应用获取设备方向”，若列表有华为浏览器，确认开启后重新进入页面尝试。华为官方对 5.0 至 6.0.0.115 标注不涉及此操作，不能套用其他系统的菜单。浏览器若提供当前站点的运动/方向权限，也需检查实际设置。参考 [华为官方版本说明](https://consumer.huawei.com/cn/support/content/zh-cn16002151/)。

Pura X 已确认的 `NotAllowedError: Permissions to access sensor are not granted` 表示实际请求未获准；仅凭该文案不能区分系统应用权限、站点权限或浏览器宿主处理。OpenHarmony 的 Web 传感器接入要求宿主处理 `TYPE_SENSOR` 授权，普通网页不能替浏览器完成该配置。参考 [OpenHarmony 官方接入说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/web/web-sensor.md)。目前没有已验证的网页侧恢复办法，可继续使用触控。

## 4. 本地诊断与隐私

手机高级设置及电脑“手机传感器状态”可查看：

- 安全上下文、前后台、焦点、监听状态和可用接口。
- 各来源有效 Hz、累计事件数、最后事件距今时间及原始角度/重力值。
- 只读权限查询、页面策略、Relative 激活/读数/错误，以及当前与上次显式申请结果。
- 服务器 RTT。它是往返网络时间，不等于完整的手势到屏幕延迟。

累计事件数与每秒 Hz 分开显示，因此“当前 0Hz”不等于“从未收到事件”。一次全 null 的事件不算有效姿态；查询不支持、异常或超时显示 unknown，不会伪装成 granted/denied。申请后暂停或触控不会把已记录错误改成授权成功。

手机诊断通过现有局域网 WSS 发送到电脑，**不上传云服务**。服务仅在内存保留最近一份诊断：手机断开后标记为上次记录，距最后接收达到 **10分钟**失效；新手机连接会清空旧记录，服务重启也会清空。可通过电脑页面或本地服务的 `/api/diagnostics` 查看。页面内的申请历史在刷新或新申请时重置。

只从浏览器 UA 提取允许的浏览器、内核和系统版本摘要，不保留原始 UA、设备序列号或账号。启动器另有本机运行日志，用于定位进程和证书错误，位于被 Git 忽略的 `.tools/`。提交公开 issue 前请检查截图和日志，不附私钥、配对链接或其他个人信息。

## 5. 常见问题

| 现象 | 排查顺序 |
| --- | --- |
| 手机连不上 | 确认服务仍运行；二维码选中实际 WLAN 地址；两设备同网且允许互访；手机不能使用 localhost；检查端口、Windows 专用网络与防火墙、访客网络/AP隔离及 VPN 路由。 |
| HTTPS/WSS 证书错误 | 确认手机与运行透明层的 Windows 用户信任同一个公开 CA，手机时间正确；电脑换 IP 后重签并重启；不要把 HTTPS 页面连接到 `ws://`，正式入口使用 `wss://`。 |
| 提示已有手机连接 | 每个配对房间只允许一部手机。关闭旧手机页面，再连接新手机；同一页面断网恢复会尝试接管自己的旧会话。 |
| 触控也不动 | 检查手机/电脑在线状态、二维码房间是否过期、服务与透明层是否仍运行。手动重启服务后重新扫码。 |
| 触控有效，陀螺仪不动 | 看安全上下文、暂停状态、原始轴值、有效 Hz 和申请错误；确认用独立浏览器打开而非扫码应用内置页面。无有效数据时继续触控，不能靠灵敏度或滤波修复权限拒绝。 |
| 权限为 prompt 却不弹框 | prompt 不是已授权或已弹框；检查实际申请结果及系统/站点可用权限入口。真点击重试仍被拒绝时，保留诊断，不反复点击并声称恢复。 |
| 红点一直居中 | 检查是否暂停、刚校准、只绕指向轴滚转；确认 α/β/γ 真正变化。只有 null 不会生成位置。 |
| 方向反了 | 重新校准，确认当前横竖屏与持机姿势，分别调整左右/上下反转；倾斜备用与指向模式手势不同。 |
| 静止慢漂或抖动 | 归零、降低灵敏度，避开强磁或磁性支架，尝试倾斜备用。80ms低通减少抖动，但不能根除系统姿态融合的慢漂。 |
| 延迟高 | 结合 RTT 与有效 Hz 判断网络或供数瓶颈；靠近稳定 AP，保持手机前台并检查省电策略、VPN。滤波本身有预期延迟，时间常数过大会更迟钝。 |
| 网页预览有点，Canva没有 | 确认 Windows 透明层连接成功、选对显示器，且 Ctrl+Alt+Q 未被其他程序占用。普通网页无法跨应用叠加。 |
| Canva不翻页 | 让 Canva 的播放窗口保持前台，先确认实体键盘左右键可翻页，避免焦点停在文本框。透明层与 Canva 保持相同权限级别，通常都以普通用户运行。 |
| 启动器报端口占用 | 停止之前手动运行的服务，或选择其他端口；不要同时使用启动器和两终端模式管理同一端口。 |
| 构建后二维码页404 | `npm run build` 构建上游库，可能清理示例产物；重新运行 `npm run build:demo` 或启动器。 |
| 双击无响应或启动报错 | 使用 PowerShell 启动命令查看错误；检查 Node.js 是否可从新终端找到，查看 `.tools/launcher.log`、`server.stderr.log` 和 `overlay.stderr.log`。 |

翻页通过 Windows `SendInput` 向**当前前台程序**发送左右方向键，不只绑定 Canva。它受 Windows 权限隔离限制，参考 [Microsoft 官方说明](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。

## 6. 高级：两终端手动运行

先完成依赖、证书与手机信任配置。终端一从仓库根目录执行：

```powershell
npm start
```

这会构建网页并以前台进程启动 HTTPS/WSS 服务。电脑打开 `https://127.0.0.1:8443`。

终端二同样进入仓库根目录，启动透明层：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\overlay.ps1 -Server https://127.0.0.1:8443
```

可加 `-Monitor 2` 选择第二块屏幕。停止时，终端一按 Ctrl+C，透明层按 Ctrl+Alt+Q；这些手动进程不由启动器 Stop 管理。

手动模式自定义端口或二维码首选 IP：

```powershell
$env:PORT = '8444'
$env:LAN_IP = Read-Host '输入电脑当前局域网 IPv4'
npm start
```

另一终端将透明层的 `-Server` 改为 `https://127.0.0.1:8444`。指定的局域网 IP 必须包含在服务器证书中。启动器会重新检测网卡，不沿用手动模式设置的 `LAN_IP`。

已有正确构建时可用 `npm run serve` 只启动服务。`npm run dev` 是开发预览，不是手机正式运行入口，不提供本指南配置的可信局域网 HTTPS 服务。

## 7. 开发与验证

| 文件 | 作用 |
| --- | --- |
| `example/RemoteController.ts`、`example/orientation.ts` | 手机生命周期、权限诊断、姿态映射、校准与低通过滤。 |
| `example/client.ejs`、`example/client.ts` | 手机触控/控制界面与连接状态。 |
| `example/main.ts`、`example/main.ejs` | 电脑二维码、地址选择、绘图与诊断显示。 |
| `example/ws.ts`、`server.cjs` | 同源WSS、重连、消息验证与局域网转发。 |
| `scripts/launch.ps1`、`scripts/overlay.ps1` | Windows 启动管理与透明叠加/翻页。 |
| `scripts/setup-https.ps1`、`scripts/allow-firewall.ps1` | 本地证书准备与可选防火墙规则。 |
| `tests/`、`scripts/test-overlay.ps1`、`scripts/test-launcher.ps1` | 数学与手机行为、TLS/WSS、Windows辅助脚本验证。 |

### 构建与自动测试

```powershell
npm run lint
npm run build:demo
npm test
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\test-overlay.ps1
```

当前 `npm test` 包含 **61项测试**，覆盖姿态数学、过滤、手机生命周期/权限状态、诊断保留和可信 TLS/WSS 转发。测试入口在操作系统临时目录生成专用 CA、服务器证书及测试密钥，不读写 `certs/`、不安装系统信任；缺少网页构建时会自动构建 demo。因此新拉取后完成 `npm ci` 即可运行测试，无需先配置演示证书。测试证书生成需要 OpenSSL；Windows 可使用 Git 自带的 OpenSSL。

Windows 离线烟测默认不显示窗口、不占用全局退出热键、不向前台应用发送真实翻页键。自动测试通过不等于所有手机及 Canva 全屏链路均已验收。

验证实际透明窗口时，先停止正在运行的透明层，使 Ctrl+Alt+Q 空闲，再执行：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\test-overlay.ps1 -Window
```

测试启动器可在完成演示证书及当前用户 CA 信任后执行，默认使用独立测试端口：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\test-launcher.ps1
```

CI 工作流提供 Node.js 22/24 检查，并在运行时生成临时测试证书及所需密钥，不依赖个人开发 CA。密钥不提交或随仓库分发；`certs/`、`.tools/`、`node_modules/` 与构建产物均在 Git 忽略列表中。是否通过 CI 以对应提交的 GitHub Actions 结果为准。

### 真机验收建议

在每个目标系统/浏览器版本上验证：扫码和可信 HTTPS → 触控四角/中线 → 传感器实际授权与有效数据 → 归零及四向移动 → 静止观察 → 旋屏与后台恢复 → Canva上下页 → 断网重连。反馈问题时附具体系统/浏览器版本、操作方式、有效Hz、RTT和错误类型；不要只用“浏览器同名”或“有陀螺仪硬件”推断网页兼容。

## 许可

MIT，保留 [SilentTiger/laser-pen](https://github.com/SilentTiger/laser-pen) 的原始版权声明；详见 [LICENSE](LICENSE)。
