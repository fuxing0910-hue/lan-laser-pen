const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { WebSocketServer, WebSocket } = require('ws')

function isLanAddress(address = '') {
  const ip = address.replace(/^::ffff:/, '')
  return ip === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^(fc|fd|fe80:)/i.test(ip)
}

function lanAddresses() {
  const addresses = Object.entries(os.networkInterfaces())
    .sort(([a], [b]) => Number(/vmware|virtual|vbox|tailscale|vpn|vethernet|docker|wsl/i.test(a)) -
      Number(/vmware|virtual|vbox|tailscale|vpn|vethernet|docker|wsl/i.test(b)))
    .flatMap(([, items]) => items || [])
    .filter(item => item.family === 'IPv4' && !item.internal && isLanAddress(item.address) &&
      !item.address.startsWith('169.254.'))
    .map(item => item.address)
  if (process.env.LAN_IP) {
    if (!addresses.includes(process.env.LAN_IP)) throw new Error('LAN_IP must be a local private IPv4 address')
    return [process.env.LAN_IP]
  }
  return [...new Set(addresses)]
}

function validCommand(message) {
  if (!message || typeof message !== 'object') return null
  if (message.type === 'point' && Array.isArray(message.point) && message.point.length === 2 &&
      message.point.every(value => typeof value === 'number' && Number.isFinite(value))) {
    return { type: 'point', point: message.point.map(value => Math.max(-1, Math.min(1, value))) }
  }
  if (message.type === 'reset') return { type: 'reset' }
  if (message.type === 'page' && ['next', 'previous'].includes(message.direction)) {
    return { type: 'page', direction: message.direction }
  }
  if (message.type === 'color' && Array.isArray(message.color) && message.color.length === 3 &&
      message.color.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return { type: 'color', color: message.color }
  }
  return null
}

function sanitizeDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.secure !== 'boolean' || typeof value.running !== 'boolean') return null
  const diagnostic = { secure: value.secure, running: value.running }
  for (const key of ['visible', 'listenersAttached']) {
    if (typeof value[key] === 'boolean') diagnostic[key] = value[key]
  }
  for (const key of ['focused', 'relativeActivated', 'relativeHasReading']) {
    if (value[key] === null || typeof value[key] === 'boolean') diagnostic[key] = value[key]
  }
  for (const key of ['requestedMode', 'activeSource', 'orientationPermission', 'motionPermission', 'relativeStatus', 'reason']) {
    if (typeof value[key] === 'string') diagnostic[key] = value[key].slice(0, key === 'reason' ? 160 : 80)
  }
  for (const key of ['sensorPermissions', 'sensorPolicy', 'apiSupport', 'browserInfo']) {
    if (typeof value[key] === 'string') diagnostic[key] = value[key].slice(0, key === 'browserInfo' ? 240 : 160)
  }
  for (const key of ['orientationHz', 'absoluteHz', 'motionHz', 'relativeHz', 'validHz', 'alpha', 'beta', 'gamma', 'gravityX', 'gravityY', 'gravityZ']) {
    if (value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]) && Math.abs(value[key]) <= 10000)) {
      diagnostic[key] = value[key]
    }
  }
  for (const key of ['orientationEvents', 'absoluteEvents', 'motionEvents', 'relativeEvents', 'relativeActivations']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) diagnostic[key] = value[key]
  }
  for (const key of ['orientationAgeMs', 'absoluteAgeMs', 'motionAgeMs', 'relativeAgeMs']) {
    if (value[key] === null || (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 86400000)) {
      diagnostic[key] = value[key]
    }
  }
  if (value.relativeTimestamp === null || (typeof value.relativeTimestamp === 'number' && Number.isFinite(value.relativeTimestamp) && value.relativeTimestamp >= 0 && value.relativeTimestamp <= Number.MAX_SAFE_INTEGER)) {
    diagnostic.relativeTimestamp = value.relativeTimestamp
  }
  return diagnostic
}

function createLaserServer({ key, cert, port = 8443, addresses = lanAddresses(), room = crypto.randomBytes(18).toString('hex') }) {
  const peers = new Set()
  let latestDiagnostic = null
  let diagnosticReceivedAt = 0
  const currentDiagnostic = () => {
    if (latestDiagnostic && Date.now() - diagnosticReceivedAt >= 10 * 60 * 1000) latestDiagnostic = null
    return latestDiagnostic
  }
  const dist = path.join(__dirname, 'dist')
  const config = {
    room, port, addresses,
    clientUrl: `https://${addresses[0] || 'localhost'}:${port}/client.html?id=${room}`,
  }
  const validHost = (authority, localPort) => {
    try {
      const url = new URL(`https://${authority}`)
      return ['localhost', '127.0.0.1', ...addresses].includes(url.hostname) &&
        Number(url.port || 443) === localPort && !url.username && !url.password
    } catch { return false }
  }
  const server = https.createServer({ key, cert }, (request, response) => {
    if (!isLanAddress(request.socket.remoteAddress) || !validHost(request.headers.host, request.socket.localPort)) {
      response.writeHead(403).end('LAN access only')
      return
    }
    response.setHeader('Permissions-Policy', 'accelerometer=(self), gyroscope=(self), magnetometer=(self)')
    response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://${request.headers.host}; object-src 'none'; frame-ancestors 'none'`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method !== 'GET') { response.writeHead(405).end('GET only'); return }
    let pathname
    try { pathname = new URL(request.url, 'https://localhost').pathname } catch {
      response.writeHead(400).end('Invalid URL'); return
    }
    if (pathname === '/api/config') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify(config)); return
    }
    if (pathname === '/api/diagnostics') {
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ connected: [...peers].some(peer => peer.role === 'client'), diagnostic: currentDiagnostic() }))
      return
    }
    // Serve only build outputs; private certificates and source files stay inaccessible.
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1)
    if (!/^[a-zA-Z0-9_.-]+$/.test(filename) || !/\.(html|js|map)$/.test(filename)) {
      response.writeHead(404).end('Not found'); return
    }
    fs.readFile(path.join(dist, filename), (error, data) => {
      if (error) { response.writeHead(404).end('Build first: npm run build:demo'); return }
      response.setHeader('Content-Type', filename.endsWith('.html') ? 'text/html; charset=utf-8' :
        filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/json')
      response.end(data)
    })
  })
  // Bounded Unicode diagnostics can exceed 2 KiB; control commands remain separately validated.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false })
  const send = (peer, data) => {
    if (peer.readyState === WebSocket.OPEN && (data.type !== 'point' || peer.bufferedAmount < 8192)) {
      peer.send(JSON.stringify(data))
    }
  }
  const presence = () => {
    const phone = [...peers].some(peer => peer.role === 'client')
    const desktop = [...peers].some(peer => peer.role !== 'client')
    for (const peer of peers) {
      const connected = peer.role === 'client' ? desktop : phone
      if (peer.presence !== connected) {
        peer.presence = connected
        send(peer, { type: 'presence', connected })
      }
    }
  }
  server.on('upgrade', (request, socket, head) => {
    let url
    try { url = new URL(request.url, 'https://localhost') } catch { socket.destroy(); return }
    const role = url.searchParams.get('role')
    const origin = request.headers.origin
    if (!isLanAddress(request.socket.remoteAddress) || !validHost(request.headers.host, request.socket.localPort) || url.pathname !== '/ws' ||
        url.searchParams.get('room') !== room || !['main', 'client', 'overlay'].includes(role) ||
        (origin && origin !== `https://${request.headers.host}`)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    const session = url.searchParams.get('session') || ''
    wss.handleUpgrade(request, socket, head, peer => wss.emit('connection', peer, role, session))
  })
  wss.on('connection', (peer, role, session) => {
    peer.role = role
    peer.session = session
    peer.alive = true
    peer.on('error', () => peer.terminate())
    const previous = [...peers].find(other => other.role === 'client')
    // The same phone may replace its half-open socket immediately after a Wi-Fi interruption.
    if (role === 'client' && previous && /^[-a-zA-Z0-9]{16,80}$/.test(session) && previous.session === session) {
      peers.delete(previous)
      previous.terminate()
    }
    // One phone prevents two sensors from fighting over the same dot.
    if (role === 'client' && [...peers].some(other => other.role === 'client')) {
      send(peer, { type: 'error', message: '已有手机连接，请先关闭原手机页面。' })
      peer.close(1008, 'One phone per room'); return
    }
    peers.add(peer)
    if (role === 'client') latestDiagnostic = null
    presence()
    if (role === 'main' && currentDiagnostic()) send(peer, { type: 'diagnostic', connected: [...peers].some(other => other.role === 'client'), diagnostic: latestDiagnostic })
    peer.on('pong', () => { peer.alive = true })
    peer.on('message', raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message && message.type === 'ping' && typeof message.sentAt === 'number' && Number.isFinite(message.sentAt)) {
        send(peer, { type: 'pong', sentAt: message.sentAt }); return
      }
      if (role !== 'client') return
      if (message.type === 'diagnostic') {
        const diagnostic = sanitizeDiagnostic(message.diagnostic)
        if (diagnostic) {
          diagnosticReceivedAt = Date.now()
          latestDiagnostic = { ...diagnostic, updatedAt: new Date().toISOString() }
          // Keep the newest result even when a desktop notification is rate limited.
          if (!peer.lastDiagnosticAt || Date.now() - peer.lastDiagnosticAt >= 500) {
            peer.lastDiagnosticAt = Date.now()
            for (const other of peers) if (other.role === 'main') send(other, { type: 'diagnostic', connected: true, diagnostic: latestDiagnostic })
          }
        }
        return
      }
      const command = validCommand(message)
      if (command) for (const other of peers) if (other.role !== 'client') send(other, command)
    })
    peer.on('close', () => {
      peers.delete(peer)
      // A phone may leave the browser to report a problem. Retain its last snapshot
      // in memory for ten minutes; connected and updatedAt keep it distinct from live data.
      presence()
      if (role === 'client' && ![...peers].some(other => other.role === 'client') && currentDiagnostic()) {
        for (const other of peers) if (other.role === 'main') send(other, { type: 'diagnostic', connected: false, diagnostic: latestDiagnostic })
      }
    })
  })
  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) { peer.terminate(); continue }
      peer.alive = false
      peer.ping()
    }
  }, 10000)
  heartbeat.unref()
  server.on('close', () => clearInterval(heartbeat))
  return { server, wss, config, close: () => {
    clearInterval(heartbeat)
    for (const peer of wss.clients) peer.terminate()
    wss.close()
    return new Promise(resolve => server.close(resolve))
  } }
}

if (require.main === module) {
  try {
    const port = Number(process.env.PORT || 8443)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT')
    const retainedRoom = process.env.LASER_PEN_ROOM
    if (retainedRoom && !/^[a-f0-9]{36}$/.test(retainedRoom)) throw new Error('Invalid retained room')
    const app = createLaserServer({
      key: fs.readFileSync(path.join(__dirname, 'certs/lan-key.pem')),
      cert: fs.readFileSync(path.join(__dirname, 'certs/lan.pem')), port,
      ...(retainedRoom ? { room: retainedRoom } : {}),
    })
    app.server.on('error', error => { console.error(error.message); process.exitCode = 1 })
    app.server.listen(port, '0.0.0.0', () => {
      console.log(`Desktop: https://localhost:${port}`)
      for (const ip of app.config.addresses) console.log(`LAN desktop: https://${ip}:${port}`)
      console.log(`Phone: ${app.config.clientUrl}`)
      console.log('Local HTTPS + WSS only. Ctrl+C to stop. Trust certs/rootCA.cer before using sensors.')
    })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit()))
  } catch (error) {
    console.error(`${error.message}\nGenerate certificates first: powershell -ExecutionPolicy Bypass -File scripts/setup-https.ps1`)
    process.exitCode = 1
  }
}

module.exports = { createLaserServer, validCommand, sanitizeDiagnostic, isLanAddress, lanAddresses }
