const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { once } = require('node:events')
const { WebSocket } = require('ws')
const { createLaserServer, validCommand, sanitizeDiagnostic, isLanAddress } = require('../server.cjs')

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Message timeout')) }, 2000)
    const listener = raw => {
      const message = JSON.parse(raw.toString())
      if (predicate(message)) { cleanup(); resolve(message) }
    }
    const cleanup = () => { clearTimeout(timer); socket.off('message', listener) }
    socket.on('message', listener)
  })
}

function get(url, ca) {
  return new Promise((resolve, reject) => {
    https.get(url, { ca }, response => {
      let data = ''
      response.on('data', chunk => { data += chunk })
      response.on('end', () => resolve({ status: response.statusCode, data, headers: response.headers }))
    }).on('error', reject)
  })
}

test('commands reject null, invalid axes and arbitrary keyboard injection', () => {
  for (const invalid of [null, {}, { type: 'point', point: [null, 0] }, { type: 'point', point: [NaN, 0] },
    { type: 'point', point: [Infinity, 0] }, { type: 'page', direction: 'escape' }, { type: 'key', key: 'cmd' }]) {
    assert.equal(validCommand(invalid), null)
  }
  assert.deepEqual(validCommand({ type: 'point', point: [2, -5] }), { type: 'point', point: [1, -1] })
  assert.equal(isLanAddress('8.8.8.8'), false)
  assert.equal(isLanAddress('::ffff:192.168.43.2'), true)
})

test('sensor diagnostics preserve real zeros and nulls and exclude unrelated fields', () => {
  assert.equal(sanitizeDiagnostic(null), null)
  assert.equal(sanitizeDiagnostic({ secure: true }), null)
  const diagnostic = sanitizeDiagnostic({ secure: true, running: false, visible: true, listenersAttached: false,
    focused: null, relativeActivated: false, relativeHasReading: false, relativeActivations: 0, relativeTimestamp: 0,
    sensorPermissions: 'accelerometer=denied;gyroscope=denied;magnetometer=unknown',
    sensorPolicy: 'accelerometer=allowed;gyroscope=allowed;magnetometer=unknown',
    apiSupport: 'orientation=yes;motion=yes;relative=yes', browserInfo: 'HuaweiBrowser 5.1;ArkWeb 114',
    orientationEvents: 0, absoluteEvents: -1, motionEvents: 12000, relativeEvents: 1.5,
    orientationAgeMs: null, absoluteAgeMs: -1, motionAgeMs: 30000, relativeAgeMs: Infinity, alpha: 0, beta: null,
    gamma: Infinity, orientationHz: 0, relativeHz: 0, relativeStatus: 'unsupported', reason: 'x'.repeat(300), userAgent: 'not collected', arbitrary: {} })
  assert.equal(diagnostic.alpha, 0)
  assert.equal(diagnostic.beta, null)
  assert.equal(diagnostic.orientationHz, 0)
  assert.equal(diagnostic.relativeHz, 0)
  assert.equal(diagnostic.relativeStatus, 'unsupported')
  assert.equal(diagnostic.visible, true)
  assert.equal(diagnostic.listenersAttached, false)
  assert.equal(diagnostic.focused, null)
  assert.equal(diagnostic.relativeActivated, false)
  assert.equal(diagnostic.relativeHasReading, false)
  assert.equal(diagnostic.relativeActivations, 0)
  assert.equal(diagnostic.relativeTimestamp, 0)
  assert.match(diagnostic.sensorPermissions, /gyroscope=denied/)
  assert.match(diagnostic.sensorPolicy, /gyroscope=allowed/)
  assert.match(diagnostic.apiSupport, /relative=yes/)
  assert.equal(diagnostic.browserInfo, 'HuaweiBrowser 5.1;ArkWeb 114')
  assert.equal(diagnostic.orientationEvents, 0)
  assert.equal(diagnostic.absoluteEvents, undefined)
  assert.equal(diagnostic.motionEvents, 12000)
  assert.equal(diagnostic.relativeEvents, undefined)
  assert.equal(diagnostic.orientationAgeMs, null)
  assert.equal(diagnostic.absoluteAgeMs, undefined)
  assert.equal(diagnostic.motionAgeMs, 30000)
  assert.equal(diagnostic.relativeAgeMs, undefined)
  assert.equal(diagnostic.reason.length, 160)
  assert.equal(diagnostic.gamma, undefined)
  assert.equal(diagnostic.userAgent, undefined)
  assert.equal(diagnostic.arbitrary, undefined)
  const malformed = sanitizeDiagnostic({ secure: true, running: true, focused: 'true', relativeActivated: 1,
    relativeHasReading: {}, relativeActivations: -1, relativeTimestamp: NaN, sensorPermissions: {}, sensorPolicy: 'x'.repeat(300), browserInfo: 'x'.repeat(300) })
  assert.equal(malformed.focused, undefined)
  assert.equal(malformed.relativeActivated, undefined)
  assert.equal(malformed.relativeHasReading, undefined)
  assert.equal(malformed.relativeActivations, undefined)
  assert.equal(malformed.relativeTimestamp, undefined)
  assert.equal(malformed.sensorPermissions, undefined)
  assert.equal(malformed.sensorPolicy.length, 160)
  assert.equal(malformed.browserInfo.length, 240)
})

test('trusted HTTPS and local WSS forward point/reset/page and handle disconnects', async t => {
  const certificateDirectory = process.env.LASER_PEN_TEST_CERT_DIR
  assert.ok(certificateDirectory, 'Run npm test to generate isolated temporary test certificates.')
  const key = fs.readFileSync(path.join(certificateDirectory, 'lan-key.pem'))
  const cert = fs.readFileSync(path.join(certificateDirectory, 'lan.pem'))
  const ca = new (require('node:crypto').X509Certificate)(fs.readFileSync(path.join(certificateDirectory, 'rootCA.cer'))).toString()
  const app = createLaserServer({ key, cert, port: 0, addresses: ['127.0.0.1'] })
  app.server.listen(0, '127.0.0.1')
  await once(app.server, 'listening')
  t.after(() => app.close())
  const base = `https://127.0.0.1:${app.server.address().port}`
  const config = await get(`${base}/api/config`, ca)
  assert.equal(config.status, 200)
  assert.equal(JSON.parse(config.data).room, app.config.room)
  assert.match(config.headers['permissions-policy'], /gyroscope=\(self\)/)
  assert.equal((await get(`${base}/certs/lan-key.pem`, ca)).status, 404)
  assert.equal((await get(`${base}/server.cjs`, ca)).status, 404)
  assert.equal((await get(base, ca)).status, 200)
  const connect = (role, session = '') => new WebSocket(`${base.replace('https:', 'wss:')}/ws?role=${role}&room=${app.config.room}&session=${session}`, { ca })
  const main = connect('main')
  const mainPresence = nextMessage(main)
  await once(main, 'open')
  assert.deepEqual(await mainPresence, { type: 'presence', connected: false })
  const online = nextMessage(main, message => message.type === 'presence')
  let phone = connect('client', 'same-phone-session-123')
  const phonePresence = nextMessage(phone)
  await once(phone, 'open')
  assert.equal((await phonePresence).connected, true)
  assert.equal((await online).connected, true)
  const overlay = connect('overlay')
  const overlayPresence = nextMessage(overlay)
  await once(overlay, 'open')
  assert.equal((await overlayPresence).connected, true)
  const sensorReport = { secure: true, running: true, visible: true, listenersAttached: true,
    focused: true, relativeActivated: false, relativeHasReading: false, relativeActivations: 0, relativeTimestamp: null,
    sensorPermissions: 'accelerometer=denied;gyroscope=denied;magnetometer=unknown',
    sensorPolicy: 'accelerometer=allowed;gyroscope=allowed;magnetometer=unknown',
    apiSupport: 'orientation=yes;motion=yes;relative=yes', browserInfo: '版本未披露'.repeat(48),
    activeSource: 'none', orientationHz: 0, absoluteHz: 0, motionHz: 0, validHz: 0,
    orientationEvents: 0, orientationAgeMs: null, motionEvents: 12000, motionAgeMs: 30000,
    alpha: null, beta: null, gamma: null, reason: 'No sensor events' }
  const reportOnDesktop = nextMessage(main, message => message.type === 'diagnostic')
  phone.send(JSON.stringify({ type: 'diagnostic', diagnostic: sensorReport }))
  const deliveredReport = await reportOnDesktop
  assert.equal(deliveredReport.diagnostic.orientationHz, 0)
  assert.equal(deliveredReport.diagnostic.alpha, null)
  assert.equal(deliveredReport.diagnostic.visible, true)
  assert.equal(deliveredReport.diagnostic.listenersAttached, true)
  assert.equal(deliveredReport.diagnostic.orientationAgeMs, null)
  assert.equal(deliveredReport.diagnostic.motionEvents, 12000)
  assert.equal(deliveredReport.diagnostic.motionAgeMs, 30000)
  assert.equal(deliveredReport.diagnostic.focused, true)
  assert.equal(deliveredReport.diagnostic.relativeActivated, false)
  assert.equal(deliveredReport.diagnostic.relativeHasReading, false)
  assert.equal(deliveredReport.diagnostic.relativeTimestamp, null)
  assert.match(deliveredReport.diagnostic.sensorPermissions, /denied/)
  assert.match(deliveredReport.diagnostic.sensorPolicy, /allowed/)
  assert.equal(deliveredReport.diagnostic.browserInfo.length, 240)
  const diagnosticResponse = JSON.parse((await get(`${base}/api/diagnostics`, ca)).data)
  assert.equal(diagnosticResponse.connected, true)
  assert.equal(diagnosticResponse.diagnostic.reason, 'No sensor events')
  for (const command of [{ type: 'point', point: [0.2, -0.4] }, { type: 'reset' },
    { type: 'page', direction: 'next' }, { type: 'page', direction: 'previous' }]) {
    const receivedMain = nextMessage(main, message => message.type === command.type)
    const receivedOverlay = nextMessage(overlay, message => message.type === command.type)
    phone.send(JSON.stringify(command))
    assert.deepEqual(await receivedMain, command)
    assert.deepEqual(await receivedOverlay, command)
  }
  const duplicate = connect('client')
  const refused = nextMessage(duplicate, message => message.type === 'error')
  await once(duplicate, 'open')
  assert.match((await refused).message, /已有手机/)
  const pong = nextMessage(phone, message => message.type === 'pong')
  phone.send(JSON.stringify({ type: 'ping', sentAt: 123 }))
  assert.deepEqual(await pong, { type: 'pong', sentAt: 123 })
  const oldPhone = phone
  const oldClosed = once(oldPhone, 'close')
  phone = connect('client', 'same-phone-session-123')
  const reconnected = nextMessage(phone, message => message.type === 'presence')
  await once(phone, 'open')
  assert.equal((await reconnected).connected, true)
  await oldClosed
  const pointAfterReconnect = nextMessage(overlay, message => message.type === 'point')
  phone.send(JSON.stringify({ type: 'point', point: [0, 0] }))
  assert.deepEqual(await pointAfterReconnect, { type: 'point', point: [0, 0] })
  const offline = nextMessage(main, message => message.type === 'presence')
  phone.close()
  assert.equal((await offline).connected, false)
  assert.deepEqual(JSON.parse((await get(`${base}/api/diagnostics`, ca)).data), { connected: false, diagnostic: null })

  const newPhone = connect('client', 'diagnostic-session-456')
  const newPhonePresence = nextMessage(newPhone, message => message.type === 'presence')
  await once(newPhone, 'open')
  assert.equal((await newPhonePresence).connected, true)
  const firstBurst = nextMessage(main, message => message.type === 'diagnostic')
  newPhone.send(JSON.stringify({ type: 'diagnostic', diagnostic: { ...sensorReport, reason: 'Request started' } }))
  await firstBurst
  newPhone.send(JSON.stringify({ type: 'diagnostic', diagnostic: { ...sensorReport, reason: 'NotAllowedError from the real request' } }))
  const burstProcessed = nextMessage(newPhone, message => message.type === 'pong' && message.sentAt === 456)
  newPhone.send(JSON.stringify({ type: 'ping', sentAt: 456 }))
  await burstProcessed
  const newest = JSON.parse((await get(`${base}/api/diagnostics`, ca)).data)
  assert.equal(newest.diagnostic.reason, 'NotAllowedError from the real request')
  const finalDesktopReport = nextMessage(main, message => message.type === 'diagnostic' && message.connected === false)
  const newPhoneClosed = once(newPhone, 'close')
  newPhone.close()
  await newPhoneClosed
  assert.equal((await finalDesktopReport).diagnostic.reason, newest.diagnostic.reason)
  const retained = JSON.parse((await get(`${base}/api/diagnostics`, ca)).data)
  assert.equal(retained.connected, false)
  assert.equal(retained.diagnostic.reason, newest.diagnostic.reason)
  assert.equal(retained.diagnostic.updatedAt, newest.diagnostic.updatedAt)
  const expiryNow = Date.now() + 10 * 60 * 1000 + 1
  const clock = t.mock.method(Date, 'now', () => expiryNow)
  assert.deepEqual(JSON.parse((await get(`${base}/api/diagnostics`, ca)).data), { connected: false, diagnostic: null })
  clock.mock.restore()

  const replacementPhone = connect('client', 'replacement-session-789')
  const replacementPresence = nextMessage(replacementPhone, message => message.type === 'presence')
  await once(replacementPhone, 'open')
  await replacementPresence
  const replacementReport = nextMessage(main, message => message.type === 'diagnostic' && message.diagnostic.reason === 'Previous phone result')
  replacementPhone.send(JSON.stringify({ type: 'diagnostic', diagnostic: { ...sensorReport, reason: 'Previous phone result' } }))
  await replacementReport
  const replacementClosed = once(replacementPhone, 'close')
  replacementPhone.close()
  await replacementClosed
  const nextPhone = connect('client', 'next-phone-session-123')
  const nextPresence = nextMessage(nextPhone, message => message.type === 'presence')
  await once(nextPhone, 'open')
  await nextPresence
  assert.deepEqual(JSON.parse((await get(`${base}/api/diagnostics`, ca)).data), { connected: true, diagnostic: null })
  nextPhone.close()
  const rejected = new WebSocket(`${base.replace('https:', 'wss:')}/ws?role=main&room=wrong`, { ca })
  await once(rejected, 'error')
  const badOrigin = new WebSocket(`${base.replace('https:', 'wss:')}/ws?role=main&room=${app.config.room}`, { ca, origin: 'https://example.com' })
  await once(badOrigin, 'error')
})
