# LAN Laser Pen v0.1.0

Turn a phone into a pointer above a Windows presentation, with local HTTPS/WebSocket pairing and no cloud relay, account, or payment flow.

## Included

- A phone touchpad with absolute mapping, center guides, corner labels and a live position marker.
- A transparent Windows overlay with click through, always-on-top placement, and an approximately 500 ms fading trail.
- Previous/next slide buttons, calibration, sensitivity and axis reversal.
- Optional browser motion control with feature detection, first-order low-pass filtering and permission diagnostics.
- A Windows launcher and locally generated certificates.
- English/Chinese documentation, issue templates, and Node.js 22/24 CI.

## Download and run

1. Download `lan-laser-pen-0.1.0-windows.zip` and extract it.
2. Install Node.js 22+ and Git for Windows. From the extracted folder run:

   ```powershell
   powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Start
   ```

3. Complete the first-use Windows local CA confirmation and install/trust the generated public `certs/rootCA.cer` on the phone. Safari on iOS also needs the CA's full-trust switch enabled.
4. Join the same trusted private network, scan the desktop QR code, and use the touchpad. Sensor control depends on the browser granting access.

The ZIP includes the source and prebuilt web pages. It does **not** include Node.js, npm dependencies, certificates, private keys, or local diagnostics. Dependency installation and first mkcert download require Internet access; pointer operation uses the local network. If VBScript is enabled, `Start-LaserPen.vbs` is also a double-click entry.

## Compatibility and limits

- A user reports iPhone working; model, OS and browser were not supplied.
- A user reports Huawei Mate X5 motion control working in Huawei Browser.
- Huawei Pura X VDE-AL10 touch works; motion access reports `NotAllowedError`. This release does not fix that browser/system restriction.
- The cross-application overlay and foreground slide keys are Windows only. The intended presentation must be the foreground application.

## Validation

61 automated tests, ESLint and production web build passed on Windows, including a clean source installation with temporary test TLS. GitHub CI passed for Node.js 22 and 24. These checks do not replace device testing or full-screen presentation testing.

MIT licensed. Based on [SilentTiger/laser-pen](https://github.com/SilentTiger/laser-pen/tree/9694f27b846cd1baff527be2f9d14fdf86234854), retaining the upstream canvas drawing core and copyright notice.

---

中文：手机通过局域网控制 Windows 演示红点，支持触控、短轨迹、透明置顶叠加与翻页；陀螺仪依赖浏览器权限。下载 ZIP 后仍需 Node.js、首次依赖安装和手机证书信任。iPhone 和 Mate X5 收到可用反馈，Pura X 当前使用触控。完整步骤见仓库中文 README。
