# Security and privacy

LAN Laser Pen is intended for a trusted private local network. It does not provide Internet-facing authentication or identify individual LAN users. A device that can reach the service can discover the pairing configuration and diagnostics; the single-phone room limits conflicting controllers, not access by an untrusted LAN participant.

Do not port-forward the service, expose it through a public tunnel, or use it on an untrusted shared network. Windows firewall helpers restrict access to the private profile and local subnet. HTTPS protects traffic, but it does not make other devices on the same LAN trusted.

Generate a separate local CA on your own computer. Only transfer the public `rootCA.cer` to the phone. Keep CA signing keys and server private keys private. Certificates, process logs, dependency folders, and local state are excluded from Git and release bundles. Test certificates are temporary and are never installed in the operating system's trust store.

Runtime diagnostics stay in server memory, expire ten minutes after the last report, and clear on a new phone connection. They include sensor readings and a limited browser-version summary. Sanitize all reports before sharing. Presentation arrow keys are sent to the active Windows application; keep the intended presentation in the foreground.

## Reporting a vulnerability

Use this repository's **Security → Report a vulnerability** option if available. Do not put private keys, tokens, detailed exploitation instructions, or personal diagnostics in a public issue. If private reporting is unavailable, open an issue containing only a high-level request for a private contact channel.

The initial supported release is 0.1.x. Fixes will be documented in release notes; no formal response-time commitment is made.
