# LAN Laser Pen

[简体中文](./README.ZH_CN.MD)

[![CI](https://github.com/fuxing0910-hue/lan-laser-pen/actions/workflows/ci.yml/badge.svg)](https://github.com/fuxing0910-hue/lan-laser-pen/actions/workflows/ci.yml) · [Download v0.1.0](https://github.com/fuxing0910-hue/lan-laser-pen/releases/tag/v0.1.0) · [MIT](./LICENSE)

**Turn your phone into a presentation pointer for your Windows desktop, over your local network.**

Scan a QR code, drag the phone touchpad, and move a red laser dot above your slides. Motion control is available when the phone browser permits sensor access. The pointer itself needs no cloud service, account, or payment.

![How LAN Laser Pen connects a phone to a Windows presentation](./docs/assets/overview.svg)

## Features

- **Phone touchpad:** a large absolute-position touch area with center guides and a local position marker.
- **Windows overlay:** transparent, always on top, click through, and designed to preserve the foreground presentation's focus.
- **A fading trail:** the red dot leaves a trail that fades over approximately 500 ms.
- **Optional motion control:** orientation events, relative orientation, and a gravity tilt fallback, with calibration, sensitivity, axis reversal, and a first-order low-pass filter. Availability depends on browser and system permissions.
- **Presentation controls:** previous/next buttons send left/right arrow keys to the foreground Windows application. Keep Canva or your presentation focused.
- **Local pairing:** desktop QR code, HTTPS/WSS on the LAN, reconnection, and one phone controlling each session.

<img src="./docs/assets/mobile-control.png" alt="Phone touchpad with center guides, position marker, and slide buttons" width="360">

## Quick start

Prefer a download? Get the **Windows ZIP** from [Releases](https://github.com/fuxing0910-hue/lan-laser-pen/releases/tag/v0.1.0), extract it, and run the same launcher command below from the extracted folder. It includes prebuilt web pages, but still requires Node.js, first-use dependency installation, and local certificate trust setup. It does not bundle Node.js or any certificates.

You need a **Windows desktop**, Git, **Node.js 22 or newer**, and a phone on the same local network. Dependency installation and the first mkcert download require internet access. The launcher uses Windows PowerShell; the cross-application overlay is Windows only.

```powershell
git clone https://github.com/fuxing0910-hue/lan-laser-pen.git
Set-Location lan-laser-pen
npm ci
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Start
```

The launcher builds the web pages, prepares local HTTPS certificates when needed, starts the server and overlay, and opens the desktop QR page. On first use, Windows may ask you to confirm trusting the generated local CA. Allow LAN access on your trusted private network if Windows Firewall prompts; see the detailed guide if the phone cannot connect.

**The phone needs a one-time certificate setup:**

1. Copy the generated **`certs/rootCA.cer`** to the phone and install it as a trusted CA. Transfer only that public certificate; keep all private keys on the computer.
2. If using **Safari on iOS**, installing the certificate profile alone does not enable SSL/TLS trust. After installation, open **Settings → General → About → Certificate Trust Settings** and enable full trust for this CA. See [Apple's instructions](https://support.apple.com/en-us/102390).
3. Reopen the phone browser, scan the desktop QR code, and verify that the HTTPS page opens without a certificate warning. Select the correct LAN address on the desktop page if the computer has multiple network adapters.
4. Drag the touchpad to use the laser dot. Touch control does not require enabling motion sensors. To try motion control, tap the enable/authorization buttons, allow any permission prompt, then calibrate.

First use requires local installation and certificate setup. Phone certificate menus and sensor permissions vary by system version. Full setup, firewall options, and troubleshooting are in the [installation guide (Chinese)](./README.LOCAL.zh-CN.md).

To stop the server and overlay:

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File .\scripts\launch.ps1 -Action Stop
```

`Ctrl+Alt+Q` closes only the overlay. The repository also provides `Start-LaserPen.vbs` and `Stop-LaserPen.vbs` for double-click use on Windows with VBScript enabled; the PowerShell commands work independently of those entries.

## Compatibility: current evidence

| Phone / browser | Status | Limits of the evidence |
| --- | --- | --- |
| iPhone | A user reported it working. | Model, iOS version, and browser were not supplied; this is not a Safari-specific test result. |
| Huawei Mate X5 / built-in Huawei Browser | A user reported motion control working. | Exact OS and browser versions were not supplied. |
| Huawei Pura X, VDE-AL10 / Huawei Browser | Touch control works; motion access was blocked with `NotAllowedError`. | Motion control is not confirmed on this setup. |
| Other phone browsers | Touch control targets browsers with Pointer Events and trusted HTTPS. Motion sources are feature detected. | Not every phone/browser combination has been tested on hardware. |

The bundled **cross-application overlay is Windows only**. Other desktop operating systems do not have a bundled cross-application overlay or this Windows launcher. A browser preview does not provide that desktop overlay.

If the browser denies access to every sensor, the web page cannot bypass that decision. Touch control remains a useful way to operate the pointer.

## Local operation and privacy

At runtime, pointer positions and slide commands travel between the phone and computer over local WSS. The project has no external relay, analytics service, login, or payment flow. Canva and other presentation apps have their own network requirements.

Sensor diagnostics include permission states, event counts, recent readings, and a limited browser/version summary. The server keeps only the latest snapshot in memory for up to **10 minutes after the last report**, including after the phone disconnects, and clears it when a new phone connection is accepted. Diagnostics are not written to a database or uploaded to a cloud service. Launcher/process logs remain local under `.tools/`.

Do not publish `certs/`, `.tools/`, private keys, or unredacted local diagnostics in an issue.

## Contributing

Bug reports, browser compatibility reports, and small pull requests are welcome. For sensor issues, include the phone model, OS/browser versions, and the page's permission/event status; remove private network details and certificate material.

Development checks use OpenSSL and isolated temporary certificates; no OS certificate trust setup is needed:

```powershell
npm test
npm run lint
npm run build:demo
```

If this helps your presentations, a star is welcome.

## License and upstream

[MIT](./LICENSE). This project builds on [SilentTiger/laser-pen at `9694f27`](https://github.com/SilentTiger/laser-pen/tree/9694f27b846cd1baff527be2f9d14fdf86234854), retaining its canvas drawing core and original copyright notice, and adding LAN control and a Windows overlay.
