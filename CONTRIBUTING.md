# Contributing

Small, focused changes and reproducible compatibility reports are welcome.

## Development

Install Git and Node.js 22 or later, then run:

```sh
npm ci
npm run lint
npm run build:demo
npm test
```

Tests generate their own temporary TLS certificates using OpenSSL. Git for Windows includes OpenSSL; Linux runners normally provide it. The tests do not install a trusted CA, access phone sensors, or send real presentation keystrokes. Windows overlay checks are separate: `scripts/test-overlay.ps1`.

The application build is `npm run build` or `npm run build:demo`. The preserved upstream drawing-library build is `npm run build:library`; it replaces `dist/` with library output, so rebuild the demo before running the LAN app.

Keep runtime traffic on the LAN. Avoid external scripts, fonts, telemetry, cloud relays, new frameworks, or automatic permission grants. Write code comments in English. Include relevant tests for behavior changes and describe the evidence behind compatibility claims.

## Reporting phone compatibility

Include phone model, OS version, browser/version, whether touch works, and whether motion control receives valid data. Distinguish user reports from reproducible test results. An API being present or a permission reporting `prompt` does not mean sensor access is granted.

Remove IP addresses, Wi-Fi names, pairing URLs, raw logs, and identifying information before posting. Never attach certificates or private keys. Use the sensor compatibility issue template for the bounded diagnostic fields that matter.

## Pull requests

Explain the trigger, resulting behavior, and checks you ran. Keep Windows overlay behavior and touchscreen controls usable while changing optional motion support. Preserve the upstream MIT notice and credit substantial reused work.
