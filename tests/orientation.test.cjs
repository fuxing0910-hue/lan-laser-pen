const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../example/orientation.ts'), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const api = { exports: {} }
new Function('exports', 'module', javascript)(api.exports, api)
const { createReference, pointerAngles, tiltAngles, gravityOrientation, quaternionOrientation, isValidSample, rotateVector, shortestAngle, LowPassFilter, normalizedPoint } = api.exports
const sample = (alpha = 0, beta = 0, gamma = 0) => ({ alpha, beta, gamma })
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`)

test('null and non-finite angles never become zero data', () => {
  for (const invalid of [null, NaN, Infinity, -Infinity]) {
    assert.equal(isValidSample(sample(invalid), 'pointer'), false)
    assert.equal(isValidSample(sample(0, invalid), 'tilt'), false)
    assert.equal(isValidSample(sample(0, 0, invalid), 'pointer'), false)
  }
  assert.equal(isValidSample(sample(0, 0, 0), 'pointer'), true)
  assert.equal(isValidSample(sample(null, 0, 0), 'tilt'), true)
})

test('alpha 359 -> 0 moves one degree without a boundary jump', () => {
  const ref = createReference(sample(359), 0)
  const point = pointerAngles(sample(0), ref, 0)
  near(point[0], -1)
  near(point[1], 0)
  near(shortestAngle(0, 359), 1)
  near(shortestAngle(359, 0), -1)
})

test('portrait yaw and pitch map to right and down coordinates', () => {
  const ref = createReference(sample(), 0)
  near(pointerAngles(sample(350), ref, 0)[0], 10)
  near(pointerAngles(sample(0, 10), ref, 0)[1], -10)
  near(pointerAngles(sample(0, 0, 40), ref, 0)[0], 0)
  near(pointerAngles(sample(0, 0, 40), ref, 0)[1], 0)
})

test('both landscape orientations track their screen top edge', () => {
  for (const angle of [90, -90, 270]) {
    const ref = createReference(sample(), angle)
    near(pointerAngles(sample(350), ref, angle)[0], 10)
    near(pointerAngles(sample(0, 0, 10), ref, angle)[1], angle === 90 ? 10 : -10)
  }
})

test('all rotated screen orientations calibrate exactly at an arbitrary pose', () => {
  for (const angle of [0, 90, 180, 270]) {
    const pose = sample(178, 72, -21)
    const point = pointerAngles(pose, createReference(pose, angle), angle)
    near(point[0], 0)
    near(point[1], 0)
  }
})

test('equivalent Euler representations near the beta singularity have the same ray', () => {
  const first = sample(15, 91, 20)
  const equivalent = sample(195, 89, -160)
  const a = rotateVector(first, [0, 1, 0])
  const b = rotateVector(equivalent, [0, 1, 0])
  a.forEach((value, index) => near(value, b[index]))
})

test('tilt fallback works without alpha and compensates screen rotation', () => {
  const origin = sample(null, 20, 4)
  const current = sample(null, 30, 9)
  assert.deepEqual(tiltAngles(current, origin, 0), [5, 10])
  const landscape = tiltAngles(current, origin, 90)
  near(landscape[0], 10)
  near(landscape[1], -5)
})

test('low pass has an 80 ms time constant independent of sample rate', () => {
  const slow = new LowPassFilter()
  const fast = new LowPassFilter()
  slow.update([0, 0], 0)
  fast.update([0, 0], 0)
  let a
  let b
  for (let time = 20; time <= 80; time += 20) a = slow.update([10, -10], time)
  for (let time = 10; time <= 80; time += 10) b = fast.update([10, -10], time)
  near(a[0], 10 * (1 - Math.exp(-1)))
  near(a[0], b[0])
  near(a[1], b[1])
  fast.reset()
  assert.deepEqual(fast.update([0, 0], 2000), [0, 0])
})

test('dead zone, sensitivity, reversals and clamping keep finite points in bounds', () => {
  const zero = normalizedPoint([0.09, -0.09], 1, false, false)
  near(zero[0], 0)
  near(zero[1], 0)
  assert.deepEqual(normalizedPoint([1000, -1000], 3, true, true), [-1, 1])
  const normal = normalizedPoint([5, -5], 1, false, false)
  const double = normalizedPoint([5, -5], 2, false, false)
  near(double[0], normal[0] * 2)
  near(double[1], normal[1] * 2)
})

function controllerFixture(permission = 'granted', secure = true, options = {}) {
  const vm = require('node:vm')
  const elements = new Map()
  const windowHandlers = new Map()
  const legacyStopped = new Map()
  const addedListeners = []
  const removedListeners = []
  const documentHandlers = new Map()
  const messages = []
  let time = 1000
  let permissionCalls = 0
  const permissionOrder = []
  let relativeInstance
  const relativeInstances = []
  const relativeStarts = []
  const environmentTimers = new Map()
  let nextTimer = 1
  let diagnostic
  const element = id => {
    if (!elements.has(id)) {
      const classes = new Set()
      elements.set(id, {
        handlers: new Map(), textContent: '', disabled: false, checked: false,
        hidden: id === 'touchMarker', style: {}, captures: [],
        clientLeft: options.touchBorderLeft || 0, clientTop: options.touchBorderTop || 0,
        classList: {
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); return Boolean(enabled) },
          contains: name => classes.has(name),
        },
        value: id === 'rangeSensitivity' ? '1' : 'pointer',
        addEventListener(name, handler) { this.handlers.set(name, handler) },
        setPointerCapture(pointerId) { this.captures.push(pointerId) },
        getBoundingClientRect() { return options.touchRect || { left: 0, top: 0, width: 100, height: 100 } },
      })
    }
    return elements.get(id)
  }
  const document = {
    hidden: false,
    getElementById: element,
    addEventListener(name, handler) { documentHandlers.set(name, handler) },
    hasFocus: () => options.focused !== false,
    permissionsPolicy: options.policy,
  }
  const window = {
    isSecureContext: secure,
    screen: { orientation: { angle: 0, addEventListener() {} } },
    addEventListener(name, handler) { windowHandlers.set(name, handler); legacyStopped.set(name, false); addedListeners.push(name) },
    removeEventListener(name, handler) { if (windowHandlers.get(name) === handler) windowHandlers.delete(name); removedListeners.push(name) },
    setInterval(handler) { diagnostic = handler; return 1 },
    setTimeout(handler) { const timer = nextTimer++; environmentTimers.set(timer, handler); return timer },
    clearTimeout(timer) { environmentTimers.delete(timer) },
  }
  if (options.relative) {
    window.RelativeOrientationSensor = class {
      constructor() {
        relativeInstance = this; relativeInstances.push(this); this.quaternion = null; this.starts = 0; this.stops = 0
        this.activated = false; this.hasReading = false; this.timestamp = null
      }
      start() {
        this.starts += 1
        relativeStarts.push({ active: navigator.userActivation?.isActive, legacyListening: windowHandlers.has('deviceorientation') || windowHandlers.has('deviceorientationabsolute') || windowHandlers.has('devicemotion') })
        options.onRelativeStart?.()
        if (options.relativeBeforePermissionError && !permissionOrder.includes('orientation-resolved')) {
          this.onerror?.({ error: { name: 'NotAllowedError', message: 'Permission is still pending' } })
        }
      }
      stop() { this.stops += 1; this.activated = false; this.hasReading = false; this.timestamp = null }
    }
  }
  const controllerSource = fs.readFileSync(path.join(__dirname, '../example/RemoteController.ts'), 'utf8')
  const controllerCode = ts.transpileModule(controllerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const navigator = { userAgent: options.userAgent || '', permissions: options.permissions, userActivation: options.userActivation }
  const environmentSource = fs.readFileSync(path.join(__dirname, '../example/sensorEnvironment.ts'), 'utf8')
  const environmentCode = ts.transpileModule(environmentSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const environmentModule = { exports: {} }
  const context = {
    window, document, navigator, performance: { now: () => time },
    exports: module.exports, module,
    require: name => {
      if (name === './orientation') return api.exports
      assert.equal(name, './sensorEnvironment')
      return environmentModule.exports
    },
  }
  if (options.orientation !== false) {
    context.DeviceOrientationEvent = { requestPermission: () => {
      permissionCalls += 1
      permissionOrder.push('orientation-call')
      return Promise.resolve(permission).then(value => { permissionOrder.push('orientation-resolved'); return value })
    } }
    if (options.staticPermission === false) delete context.DeviceOrientationEvent.requestPermission
  }
  if (options.motion) {
    context.DeviceMotionEvent = { requestPermission: () => {
      permissionOrder.push('motion-call')
      return Promise.resolve(options.motionPermission || 'granted').then(value => { permissionOrder.push('motion-resolved'); return value })
    } }
    if (options.staticPermission === false) delete context.DeviceMotionEvent.requestPermission
  }
  vm.runInNewContext(environmentCode, { ...context, exports: environmentModule.exports, module: environmentModule })
  vm.runInNewContext(controllerCode, context)
  const controller = new module.exports.RemoteController({ send(message) { messages.push(message); return true } })
  const emitOrientation = (value, elapsed) => {
    time += elapsed
    if (legacyStopped.get('deviceorientation')) return
    windowHandlers.get('deviceorientation')?.(value)
    if (options.stopLegacyAfterNull && value.alpha === null && value.beta === null && value.gamma === null) legacyStopped.set('deviceorientation', true)
  }
  return {
    controller, element, messages, document, window, navigator,
    permissionCalls: () => permissionCalls,
    permissionOrder,
    relativeInstance: () => relativeInstance,
    relativeInstances, relativeStarts,
    addedListeners, removedListeners,
    environmentApi: environmentModule.exports,
    environmentTimeouts: () => { for (const handler of [...environmentTimers.values()]) handler() },
    click: (id, event = { isTrusted: true }) => element(id).handlers.get('click')(event),
    orientation: (value, elapsed = 20) => emitOrientation(value, elapsed),
    absolute: (value, elapsed = 20) => { time += elapsed; windowHandlers.get('deviceorientationabsolute')?.(value) },
    motion: (gravity, elapsed = 20) => { time += elapsed; windowHandlers.get('devicemotion')?.({ accelerationIncludingGravity: gravity }) },
    relative: (quaternion, elapsed = 20) => {
      time += elapsed; relativeInstance.quaternion = quaternion
      relativeInstance.activated = true; relativeInstance.hasReading = true; relativeInstance.timestamp = time
      relativeInstance.onreading?.()
    },
    activateRelative: () => { relativeInstance.activated = true; relativeInstance.onactivate?.() },
    visibility: hidden => { document.hidden = hidden; documentHandlers.get('visibilitychange')() },
    resize: () => windowHandlers.get('resize')?.(),
    diagnostics: elapsed => { time += elapsed; diagnostic() },
    pointMessages: () => messages.filter(message => message.type === 'point'),
    listening: () => windowHandlers.has('deviceorientation'),
  }
}

test('permission request occurs on Start and uses the orientation API', async () => {
  const fixture = controllerFixture()
  assert.equal(fixture.permissionCalls(), 0)
  assert.equal(fixture.listening(), false)
  await fixture.click('btnStart')
  assert.equal(fixture.permissionCalls(), 1)
  assert.equal(fixture.listening(), true)
  fixture.controller.setConnected(true)
  fixture.orientation(sample(40, 30, 0))
  fixture.orientation(sample(30, 30, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
})

test('insecure pages and denied orientation permission give actionable diagnostics', async () => {
  const insecure = controllerFixture('granted', false)
  await insecure.click('btnStart')
  assert.equal(insecure.permissionCalls(), 0)
  assert.equal(insecure.listening(), false)
  assert.match(insecure.element('sensorStatus').textContent, /HTTPS/)
  const denied = controllerFixture('denied')
  await denied.click('btnStart')
  assert.equal(denied.listening(), true)
  assert.match(denied.element('permissionStatus').textContent, /权限被拒绝/)
})

test('background, reconnect and pause each recalibrate instead of replaying stale positions', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(40, 30, 0))
  fixture.orientation(sample(30, 30, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  fixture.visibility(true)
  const pointsBeforeBackground = fixture.pointMessages().length
  fixture.orientation(sample(100, 20, 0))
  assert.equal(fixture.pointMessages().length, pointsBeforeBackground)
  fixture.visibility(false)
  fixture.orientation(sample(100, 20, 0))
  near(fixture.pointMessages().at(-1).point[0], 0)
  fixture.controller.setConnected(false)
  const pointsBeforeDisconnect = fixture.pointMessages().length
  fixture.orientation(sample(150, 50, 0))
  assert.equal(fixture.pointMessages().length, pointsBeforeDisconnect)
  fixture.controller.setConnected(true)
  fixture.orientation(sample(150, 50, 0))
  near(fixture.pointMessages().at(-1).point[0], 0)
  await fixture.click('btnStart')
  const pointsBeforePause = fixture.pointMessages().length
  fixture.orientation(sample(200, 20, 0))
  assert.equal(fixture.pointMessages().length, pointsBeforePause)
  await fixture.click('btnStart')
  fixture.orientation(sample(200, 20, 0))
  near(fixture.pointMessages().at(-1).point[0], 0)
})

test('missing angles time out without movement and valid data recovery recalibrates', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(40, 30, 0))
  const validPoints = fixture.pointMessages().length
  fixture.orientation(sample(null, null, 0))
  assert.equal(fixture.pointMessages().length, validPoints)
  fixture.diagnostics(5100)
  assert.match(fixture.element('sensorStatus').textContent, /浏览器未提供有效传感器数据.*可继续触控.*上次申请结果/)
  fixture.orientation(sample(200, 10, 0))
  near(fixture.pointMessages().at(-1).point[0], 0)
})

test('gravity tilt rejects missing fields and the zero vector, while preserving valid zero axes', () => {
  assert.equal(gravityOrientation(null), null)
  for (const value of [null, NaN, Infinity]) assert.equal(gravityOrientation({ x: value, y: 0, z: 9.8 }), null)
  assert.equal(gravityOrientation({ x: 0, y: 0, z: 0 }), null)
  assert.equal(gravityOrientation({ x: 0, y: 0, z: 40 }), null)
  const flat = gravityOrientation({ x: 0, y: 0, z: 9.8 })
  assert.equal(flat.alpha, null)
  near(flat.beta, 0)
  near(flat.gamma, 0)
  const tipped = gravityOrientation({ x: -4.9, y: 0, z: 9.8 * Math.cos(Math.PI / 6) })
  near(tipped.gamma, 30)
})

test('relative quaternion conversion matches yaw, pitch and invalid data semantics', () => {
  assert.equal(quaternionOrientation(null), null)
  assert.equal(quaternionOrientation([0, 0, 0, 0]), null)
  assert.equal(quaternionOrientation([0, 0, NaN, 1]), null)
  const half = Math.PI / 12
  const yaw = quaternionOrientation([0, 0, Math.sin(half), Math.cos(half)])
  near(yaw.alpha, 30)
  near(yaw.beta, 0)
  near(yaw.gamma, 0)
  const pitch = quaternionOrientation([Math.sin(half), 0, 0, Math.cos(half)])
  near(pitch.beta, 30)
})

test('both permission requests start before either promise resolves', async () => {
  const fixture = controllerFixture('granted', true, { motion: true })
  const pending = fixture.click('btnStart')
  assert.deepEqual(fixture.permissionOrder, ['orientation-call', 'motion-call'])
  await pending
  assert.deepEqual(fixture.permissionOrder.slice(2), ['orientation-resolved', 'motion-resolved'])
})

test('an absent or denied orientation API does not prevent Motion gravity fallback', async () => {
  for (const configuration of [{ orientation: false, motion: true }, { motion: true }]) {
    const fixture = controllerFixture('denied', true, configuration)
    await fixture.click('btnStart')
    fixture.controller.setConnected(true)
    fixture.motion({ x: 0, y: 0, z: 9.8 })
    fixture.motion({ x: -3, y: 0, z: 9.3 })
    assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
    assert.match(fixture.element('activeSource').textContent, /重力倾斜备用/)
    assert.match(fixture.element('sensorStatus').textContent, /不支持水平偏航/)
  }
})

test('missing alpha automatically selects usable beta/gamma tilt data', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(null, 30, 0))
  fixture.orientation(sample(null, 30, 10))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  assert.match(fixture.element('activeSource').textContent, /方向事件 · 倾斜备用/)
})

test('absolute-only devices work and independent sources never compete for points', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.absolute(sample(120, 20, 0))
  fixture.absolute(sample(110, 20, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  const before = fixture.pointMessages().length
  fixture.motion({ x: -5, y: 0, z: 8.4 })
  fixture.orientation(sample(250, 30, 0))
  fixture.orientation(sample(240, 30, 0))
  assert.equal(fixture.pointMessages().length, before)
  fixture.absolute(sample(100, 20, 0))
  fixture.orientation(sample(230, 30, 0), 200)
  assert.match(fixture.element('activeSource').textContent, /选中源：方向事件 · 指向/)
  near(fixture.pointMessages().at(-1).point[0], 0)
})

test('a stale full orientation stream falls back to current Motion data and recalibrates', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(40, 30, 0))
  fixture.orientation(sample(30, 30, 0))
  const before = fixture.pointMessages().length
  fixture.motion({ x: 0, y: 0, z: 9.8 })
  assert.equal(fixture.pointMessages().length, before)
  fixture.motion({ x: -3, y: 0, z: 9.3 }, 1100)
  near(fixture.pointMessages().at(-1).point[0], 0)
  assert.match(fixture.element('activeSource').textContent, /重力倾斜备用/)
})

test('RelativeOrientationSensor works without legacy constructors and stops while paused', async () => {
  const fixture = controllerFixture('granted', true, { orientation: false, relative: true })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.relative([0, 0, 0, 1])
  fixture.relative([0, 0, Math.sin(-Math.PI / 36), Math.cos(-Math.PI / 36)])
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  assert.match(fixture.element('activeSource').textContent, /Relative 相对姿态 · 指向/)
  await fixture.click('btnStart')
  assert.equal(fixture.relativeInstance().stops, 1)
  assert.equal(fixture.element('btnStart').textContent, '启用陀螺仪')
})

test('Relative sensor is recreated after permission settles and diagnostics use the active axes', async () => {
  const fixture = controllerFixture('granted', true, { relative: true, relativeBeforePermissionError: true })
  await fixture.click('btnStart')
  assert.equal(fixture.relativeInstances.length, 2)
  assert.equal(fixture.relativeInstances[0].stops, 1)
  fixture.controller.setConnected(true)
  fixture.relative([0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)])
  fixture.diagnostics(100)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.activeSource, 'relative:pointer')
  near(diagnostic.alpha, 30)
  near(diagnostic.beta, 0)
  assert.match(fixture.element('selectedData').textContent, /30.0/)
})

test('returning from a fallback source always gets a new calibration frame', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(30, 30, 0))
  fixture.orientation(sample(20, 30, 0))
  fixture.motion({ x: -3, y: 0, z: 9.3 }, 1100)
  fixture.motion({ x: -5, y: 0, z: 8.4 })
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  fixture.orientation(sample(160, 10, 0))
  fixture.orientation(sample(150, 10, 0), 110)
  fixture.orientation(sample(140, 10, 0), 110)
  assert.match(fixture.element('activeSource').textContent, /选中源：方向事件 · 指向/)
  near(fixture.pointMessages().at(-1).point[0], 0)
})

test('all-zero event rates and Relative permission errors reach local diagnostics without invented values', async () => {
  const fixture = controllerFixture('granted', true, { relative: true })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Sensor permission denied' } })
  fixture.diagnostics(5100)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.secure, true)
  assert.equal(diagnostic.running, true)
  assert.equal(diagnostic.activeSource, 'none')
  for (const key of ['orientationHz', 'absoluteHz', 'motionHz', 'relativeHz', 'validHz']) assert.equal(diagnostic[key], 0)
  for (const key of ['alpha', 'beta', 'gamma', 'gravityX', 'gravityY', 'gravityZ']) assert.equal(diagnostic[key], null)
  assert.match(diagnostic.relativeStatus, /NotAllowedError/)
  assert.match(diagnostic.reason, /传感器权限未获准/)
  assert.ok(diagnostic.reason.length <= 160)
  fixture.controller.setConnected(false)
  const count = fixture.messages.filter(message => message.type === 'diagnostic').length
  fixture.diagnostics(1000)
  assert.equal(fixture.messages.filter(message => message.type === 'diagnostic').length, count + 1)
})

test('touch testing clearly pauses sensor input until Enable is clicked again', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(40, 30, 0))
  fixture.element('touchPad').handlers.get('pointerdown')({ pointerId: 1, clientX: 75, clientY: 75 })
  assert.match(fixture.element('sensorStatus').textContent, /触控已暂停陀螺仪/)
  assert.equal(fixture.element('btnStart').textContent, '启用陀螺仪')
  const before = fixture.pointMessages().length
  fixture.orientation(sample(20, 30, 0))
  assert.equal(fixture.pointMessages().length, before)
  await fixture.click('btnStart')
  fixture.orientation(sample(10, 30, 0))
  near(fixture.pointMessages().at(-1).point[0], 0)
})

test('diagnostics distinguish never enabled from listening with no events', async () => {
  const fixture = controllerFixture()
  fixture.controller.setConnected(true)
  fixture.diagnostics(1000)
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.running, false)
  assert.equal(diagnostic.listenersAttached, false)
  assert.equal(diagnostic.visible, true)
  assert.match(fixture.element('controlMode').textContent, /触控模式.*未启用/)
  await fixture.click('btnStart')
  assert.match(fixture.element('controlMode').textContent, /已启用.*等待数据/)
  fixture.diagnostics(5100)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.running, true)
  assert.equal(diagnostic.listenersAttached, true)
  for (const source of ['orientation', 'absolute', 'motion', 'relative']) {
    assert.equal(diagnostic[`${source}Hz`], 0)
    assert.equal(diagnostic[`${source}Events`], 0)
    assert.equal(diagnostic[`${source}AgeMs`], null)
  }
  assert.equal(fixture.element('controlMode').textContent, '陀螺仪已启用，尚未收到数据')
  assert.match(fixture.element('eventHistory').textContent, /方向 0 次，从未收到/)
})

test('touch pause survives background return without claiming automatic sensor recovery', async () => {
  const fixture = controllerFixture()
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(40, 30, 0))
  assert.match(fixture.element('controlMode').textContent, /陀螺仪运行中.*方向事件/)
  fixture.element('touchPad').handlers.get('pointerdown')({ pointerId: 1, clientX: 75, clientY: 75 })
  assert.equal(fixture.element('controlMode').textContent, '手动触控模式 · 陀螺仪已暂停')
  assert.doesNotMatch(fixture.element('sensorStatus').textContent, /上方/)
  const beforeBackground = fixture.messages.filter(message => message.type === 'diagnostic').length
  fixture.visibility(true)
  assert.equal(fixture.element('controlMode').textContent, '后台暂停发送')
  fixture.diagnostics(1000)
  assert.equal(fixture.element('controlMode').textContent, '后台暂停发送')
  assert.equal(fixture.messages.filter(message => message.type === 'diagnostic').length, beforeBackground)
  fixture.visibility(false)
  assert.equal(fixture.element('controlMode').textContent, '手动触控模式 · 陀螺仪已暂停')
  assert.match(fixture.element('sensorStatus').textContent, /仍暂停.*启用陀螺仪/)
  assert.doesNotMatch(fixture.element('sensorStatus').textContent, /下一帧自动归零/)
  await fixture.click('btnStart')
  fixture.orientation(sample(40, 30, 0))
  fixture.visibility(true)
  fixture.diagnostics(1000)
  assert.equal(fixture.element('controlMode').textContent, '后台暂停发送')
  fixture.visibility(false)
  assert.match(fixture.element('sensorStatus').textContent, /下一帧自动归零/)
  assert.match(fixture.element('controlMode').textContent, /已启用.*等待数据/)
})

test('event history remains cumulative when Hz resets and counts invalid, paused or hidden events', async () => {
  const fixture = controllerFixture('granted', true, { relative: true })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(null, null, null))
  fixture.absolute(sample(20, 30, 0))
  fixture.motion(null)
  fixture.relative([0, 0, 0, 1])
  fixture.diagnostics(1000)
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  for (const source of ['orientation', 'absolute', 'motion', 'relative']) {
    assert.equal(diagnostic[`${source}Events`], 1)
    assert.ok(diagnostic[`${source}AgeMs`] >= 1000)
  }
  const previousAge = diagnostic.orientationAgeMs
  fixture.diagnostics(2000)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.orientationHz, 0)
  assert.equal(diagnostic.orientationEvents, 1)
  assert.equal(diagnostic.orientationAgeMs, previousAge + 2000)
  assert.match(fixture.element('eventHistory').textContent, /方向 1 次，最后/)
  await fixture.click('btnStart')
  fixture.orientation(sample(null, null, null))
  fixture.visibility(true)
  fixture.orientation(sample(0, 0, 0))
  fixture.diagnostics(1000)
  fixture.visibility(false)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.running, false)
  assert.equal(diagnostic.orientationEvents, 3)
  assert.equal(diagnostic.orientationAgeMs, 1000)
  fixture.diagnostics(90000000)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.orientationAgeMs, 86400000)
})

test('unsupported permission queries and unrecognized policy features never become denied', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, policy: { allowsFeature: () => false } })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.diagnostics(100)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.sensorPermissions, /accelerometer=unknown:unsupported/)
  assert.doesNotMatch(diagnostic.sensorPermissions, /=denied/)
  assert.equal(diagnostic.sensorPolicy, 'accelerometer=unknown; gyroscope=unknown; magnetometer=unknown')
  assert.equal(diagnostic.orientationPermission, '无网页授权方法；授权状态待查询')
  assert.doesNotMatch(diagnostic.orientationPermission, /无需显式请求/)
  const policySummary = fixture.environmentApi.policySummary
  const recognized = policySummary({ features: () => ['gyroscope'], allowsFeature: () => false })
  assert.match(recognized, /gyroscope=blocked/)
  assert.match(recognized, /accelerometer=unknown/)
  assert.match(policySummary({ allowedFeatures: () => ['accelerometer'], allowsFeature: () => false }), /accelerometer=allowed/)
})

test('pending permission queries never delay sensor startup and time out as unknown', async () => {
  const fixture = controllerFixture('granted', true, { permissions: { query: () => new Promise(() => {}) } })
  const pending = fixture.click('btnStart')
  assert.equal(fixture.listening(), true)
  await pending
  fixture.controller.setConnected(true)
  fixture.environmentTimeouts()
  await new Promise(setImmediate)
  fixture.diagnostics(100)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.sensorPermissions, /accelerometer=unknown:timeout/)
  assert.match(diagnostic.sensorPermissions, /gyroscope=unknown:timeout/)
  assert.doesNotMatch(diagnostic.sensorPermissions, /=denied/)
})

test('permission query exceptions stay unknown, and permission changes update the environment', async () => {
  const status = { state: 'prompt', onchange: null }
  const fixture = controllerFixture('granted', true, { permissions: { query: ({ name }) => {
    if (name === 'accelerometer') throw new TypeError('Unsupported sensor permission name')
    if (name === 'magnetometer') return Promise.reject(new Error('Query unavailable'))
    return Promise.resolve(status)
  } } })
  await fixture.click('btnStart')
  await new Promise(setImmediate)
  fixture.controller.setConnected(true)
  fixture.diagnostics(100)
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.sensorPermissions, /accelerometer=unknown:error/)
  assert.match(diagnostic.sensorPermissions, /gyroscope=prompt/)
  assert.match(diagnostic.sensorPermissions, /magnetometer=unknown:error/)
  status.state = 'granted'
  status.onchange()
  fixture.diagnostics(100)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.sensorPermissions, /gyroscope=granted/)
  assert.match(fixture.element('sensorEnvironment').textContent, /gyroscope=granted/)
})

test('failed PermissionStatus cleanup does not interrupt a later enable', async () => {
  const fixture = controllerFixture('granted', true, { permissions: { query: () => Promise.resolve({
    state: 'granted', addEventListener() {}, removeEventListener() { throw new Error('Old status detached') },
  }) } })
  await new Promise(setImmediate)
  await fixture.click('btnStart')
  assert.equal(fixture.listening(), true)
  fixture.controller.setConnected(true)
  fixture.orientation(sample(20, 30, 0))
  assert.match(fixture.element('controlMode').textContent, /运行中/)
})

test('NotAllowed is explicit through timeout and does not override another working stream', async () => {
  const fixture = controllerFixture('granted', true, { relative: true })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Permissions to access sensor are not granted' } })
  assert.equal(fixture.element('controlMode').textContent, '传感器权限未获准')
  fixture.diagnostics(5100)
  assert.equal(fixture.element('controlMode').textContent, '传感器权限未获准')
  assert.match(fixture.element('sensorStatus').textContent, /Relative NotAllowedError/)
  assert.doesNotMatch(fixture.element('sensorStatus').textContent, /5 秒/)
  fixture.orientation(sample(20, 30, 0))
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Still denied' } })
  assert.match(fixture.element('controlMode').textContent, /运行中.*方向事件/)
  fixture.orientation(sample(10, 30, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
})

test('relative activation, reading state and focus are reported without fabricated defaults', async () => {
  const fixture = controllerFixture('granted', true, { relative: true, focused: false })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.diagnostics(100)
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.focused, false)
  assert.equal(diagnostic.relativeActivated, false)
  assert.equal(diagnostic.relativeHasReading, false)
  assert.equal(diagnostic.relativeTimestamp, null)
  assert.equal(diagnostic.relativeActivations, 0)
  fixture.activateRelative()
  fixture.relative([0, 0, 0, 1])
  fixture.diagnostics(100)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.relativeActivated, true)
  assert.equal(diagnostic.relativeHasReading, true)
  assert.equal(diagnostic.relativeActivations, 1)
  assert.ok(diagnostic.relativeTimestamp > 0)
  const noSensor = controllerFixture()
  noSensor.controller.setConnected(true)
  noSensor.diagnostics(100)
  const unsupported = noSensor.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(unsupported.relativeActivated, null)
  assert.equal(unsupported.relativeHasReading, null)
})

test('retry rebinds legacy streams stopped after null and rebuilds a failed relative sensor', async () => {
  const fixture = controllerFixture('granted', true, { relative: true, staticPermission: false, stopLegacyAfterNull: true })
  await fixture.click('btnStart')
  fixture.controller.setConnected(true)
  const oldSensor = fixture.relativeInstance()
  fixture.orientation(sample(null, null, null))
  oldSensor.onerror({ error: { name: 'NotAllowedError', message: 'Denied' } })
  fixture.orientation(sample(40, 30, 0))
  assert.equal(fixture.pointMessages().length, 0)
  await fixture.click('btnRetrySensor')
  assert.notEqual(fixture.relativeInstance(), oldSensor)
  assert.equal(oldSensor.stops, 1)
  for (const name of ['deviceorientation', 'deviceorientationabsolute', 'devicemotion']) {
    assert.equal(fixture.addedListeners.filter(value => value === name).length, 2)
    assert.equal(fixture.removedListeners.filter(value => value === name).length, 1)
  }
  oldSensor.onerror({ error: { name: 'NotAllowedError', message: 'Late old error' } })
  fixture.orientation(sample(40, 30, 0))
  fixture.orientation(sample(30, 30, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  fixture.diagnostics(100)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.orientationEvents, 3)
  assert.match(fixture.element('controlMode').textContent, /运行中/)
})

test('permission completion rebinds a legacy stream that emitted null while permission was pending', async () => {
  const fixture = controllerFixture('granted', true, { stopLegacyAfterNull: true })
  const pending = fixture.click('btnStart')
  fixture.controller.setConnected(true)
  fixture.orientation(sample(null, null, null))
  await pending
  assert.equal(fixture.addedListeners.filter(name => name === 'deviceorientation').length, 2)
  fixture.orientation(sample(40, 30, 0))
  fixture.orientation(sample(30, 30, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
})

test('browser summary exports only the permitted product/version tokens', () => {
  const fixture = controllerFixture()
  const summary = fixture.environmentApi.browserSummary('SecretModel/VDE123 Serial/secret HuaweiBrowser/15.0 ArkWeb/4.1 OpenHarmony/5.0 Version/18.3 Safari/605.1.15 /private/path')
  assert.match(summary, /HuaweiBrowser\/15.0/)
  assert.match(summary, /OpenHarmony\/5.0/)
  assert.match(summary, /Version\/18.3/)
  assert.doesNotMatch(summary, /SecretModel|VDE123|Serial|secret|private|HarmonyOS/)
  assert.ok(summary.length <= 240)
  assert.match(fixture.environmentApi.browserSummary('Undisclosed browser'), /版本未披露/)
})

test('the native authorization experiment starts only Relative synchronously before permission queries', async () => {
  const order = []
  const activation = { isActive: true, hasBeenActive: true }
  const fixture = controllerFixture('granted', true, {
    staticPermission: false, relative: true, userActivation: activation,
    onRelativeStart: () => order.push('start'),
    permissions: { query: () => { order.push('query'); activation.isActive = false; return Promise.resolve({ state: 'prompt' }) } },
  })
  order.length = 0
  activation.isActive = true
  const pending = fixture.click('btnRequestSensorAuthorization', { isTrusted: true })
  assert.deepEqual(order, ['start', 'query', 'query', 'query'])
  assert.equal(fixture.listening(), false)
  assert.equal(fixture.relativeInstances.length, 1)
  assert.equal(fixture.relativeStarts[0].active, true)
  assert.equal(fixture.relativeStarts[0].legacyListening, false)
  assert.match(fixture.element('controlMode').textContent, /正在申请原生传感器授权/)
  assert.equal(fixture.pointMessages().length, 0)
  await pending
  fixture.controller.setConnected(true)
  fixture.diagnostics(100)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.apiSupport, /authClick\(T\/A\/H\)=1\/1\/1/)
  assert.match(diagnostic.apiSupport, /authStart\(A\/H\)=1\/1/)
  assert.ok(diagnostic.apiSupport.length <= 160)
  assert.equal(diagnostic.relativeActivated, false)
  assert.equal(diagnostic.relativeHasReading, false)
})

test('the isolated native attempt removes old legacy listeners and destroys the previous sensor', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnStart')
  const oldSensor = fixture.relativeInstance()
  const legacyAdds = fixture.addedListeners.filter(name => /^device(orientation|motion)/.test(name)).length
  await fixture.click('btnRequestSensorAuthorization')
  assert.equal(oldSensor.stops, 1)
  assert.notEqual(fixture.relativeInstance(), oldSensor)
  assert.equal(fixture.relativeInstances.length, 2)
  assert.equal(fixture.listening(), false)
  assert.equal(fixture.addedListeners.filter(name => /^device(orientation|motion)/.test(name)).length, legacyAdds)
  for (const name of ['deviceorientation', 'deviceorientationabsolute', 'devicemotion']) assert.ok(fixture.removedListeners.includes(name))
  assert.equal(fixture.relativeStarts.at(-1).legacyListening, false)
})

test('native authorization never reports a usable source before real activation and reading', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  fixture.controller.setConnected(true)
  await fixture.click('btnRequestSensorAuthorization')
  assert.doesNotMatch(fixture.element('controlMode').textContent, /运行中|已激活/)
  fixture.activateRelative()
  assert.match(fixture.element('controlMode').textContent, /已激活.*等待真实读数/)
  assert.equal(fixture.pointMessages().length, 0)
  fixture.relative([0, 0, 0, 1])
  assert.match(fixture.element('controlMode').textContent, /运行中.*Relative/)
  assert.equal(fixture.pointMessages().length, 1)
})

test('a native authorization denial remains real and touch plus ordinary enabling still work', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  fixture.controller.setConnected(true)
  await fixture.click('btnRequestSensorAuthorization', { isTrusted: false })
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Permissions to access sensor are not granted' } })
  assert.equal(fixture.element('controlMode').textContent, '传感器权限未获准')
  assert.match(fixture.element('relativeStatus').textContent, /上次申请：错误 NotAllowedError/)
  fixture.element('touchPad').handlers.get('pointerdown')({ pointerId: 1, clientX: 75, clientY: 50 })
  assert.equal(fixture.pointMessages().at(-1).point[0], 0.5)
  await fixture.click('btnStart')
  assert.equal(fixture.listening(), true)
  fixture.orientation(sample(40, 30, 0))
  fixture.orientation(sample(30, 30, 0))
  assert.ok(fixture.pointMessages().at(-1).point[0] > 0)
  assert.match(fixture.element('controlMode').textContent, /运行中.*方向事件/)
})

test('the authorization button preserves real legacy permission requests where available', async () => {
  const fixture = controllerFixture('granted', true, { motion: true })
  const pending = fixture.click('btnRequestSensorAuthorization')
  assert.deepEqual(fixture.permissionOrder, ['orientation-call', 'motion-call'])
  assert.equal(fixture.listening(), true)
  await pending
  assert.equal(fixture.permissionCalls(), 1)
  assert.match(fixture.element('relativeStatus').textContent, /上次申请：Relative接口未提供；方向\/运动结果见权限栏/)
  assert.doesNotMatch(fixture.element('relativeStatus').textContent, /等待真实结果/)
})

test('missing native interfaces are reported without inventing an authorization mechanism', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false })
  await fixture.click('btnRequestSensorAuthorization')
  assert.match(fixture.element('sensorStatus').textContent, /没有可主动调用的原生传感器授权接口/)
  assert.equal(fixture.listening(), false)
  assert.equal(fixture.permissionCalls(), 0)
  assert.equal(fixture.relativeInstances.length, 0)
})

test('the isolated authorization experiment never automatically repeats requests after backgrounding', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnRequestSensorAuthorization')
  fixture.visibility(true)
  fixture.visibility(false)
  fixture.diagnostics(1000)
  assert.equal(fixture.relativeStarts.length, 1)
  assert.equal(fixture.listening(), false)
  assert.match(fixture.element('controlMode').textContent, /独立授权尝试已暂停/)
  await fixture.click('btnRequestSensorAuthorization')
  assert.equal(fixture.relativeStarts.length, 2)
})

test('touch marker, border offsets, readout and transmitted coordinates describe the same position', () => {
  const fixture = controllerFixture('granted', true, {
    touchRect: { left: 10, top: 20, width: 204, height: 104 }, touchBorderLeft: 2, touchBorderTop: 3,
  })
  fixture.controller.setConnected(true)
  const pad = fixture.element('touchPad')
  const marker = fixture.element('touchMarker')
  pad.handlers.get('pointerdown')({ pointerId: 1, clientX: 61, clientY: 98 })
  const point = fixture.pointMessages().at(-1).point
  near(point[0], -0.5)
  near(point[1], 0.5)
  assert.equal(marker.style.left, '49px')
  assert.equal(marker.style.top, '75px')
  assert.equal(fixture.element('touchPosition').textContent, '触点 X 25% · Y 75%')
  assert.equal(marker.hidden, false)
  assert.equal(marker.classList.contains('is-dragging'), true)
  assert.equal(pad.classList.contains('is-dragging'), true)
})

test('captured dragging outside the pad clamps both the marker and outgoing point at its edges', () => {
  const fixture = controllerFixture('granted', true, { touchBorderLeft: 2, touchBorderTop: 2 })
  fixture.controller.setConnected(true)
  const pad = fixture.element('touchPad')
  const marker = fixture.element('touchMarker')
  pad.handlers.get('pointerdown')({ pointerId: 1, clientX: 50, clientY: 50 })
  assert.deepEqual(pad.captures, [1])
  pad.handlers.get('pointermove')({ pointerId: 1, clientX: 200, clientY: -20 })
  const point = fixture.pointMessages().at(-1).point
  near(point[0], 1)
  near(point[1], -1)
  assert.equal(marker.style.left, '98px')
  assert.equal(marker.style.top, '-2px')
  assert.equal(fixture.element('touchPosition').textContent, '触点 X 100% · Y 0%')
})

test('a second pointer is ignored and each ending event fades the last marker without another point', () => {
  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const fixture = controllerFixture()
    fixture.controller.setConnected(true)
    const pad = fixture.element('touchPad')
    const marker = fixture.element('touchMarker')
    pad.handlers.get('pointerdown')({ pointerId: 1, clientX: 25, clientY: 25 })
    const sent = fixture.pointMessages().length
    pad.handlers.get('pointerdown')({ pointerId: 2, clientX: 75, clientY: 75 })
    pad.handlers.get('pointermove')({ pointerId: 2, clientX: 80, clientY: 80 })
    pad.handlers.get(ending)({ pointerId: 2 })
    assert.equal(fixture.pointMessages().length, sent)
    assert.deepEqual(pad.captures, [1])
    assert.equal(marker.style.left, '25px')
    assert.equal(marker.classList.contains('is-dragging'), true)
    pad.handlers.get(ending)({ pointerId: 1, clientX: 90, clientY: 90 })
    assert.equal(fixture.pointMessages().length, sent)
    assert.equal(marker.classList.contains('is-dragging'), false)
    assert.equal(pad.classList.contains('is-dragging'), false)
    assert.equal(marker.hidden, false)
    assert.equal(marker.style.left, '25px')
    pad.handlers.get('pointermove')({ pointerId: 1, clientX: 60, clientY: 60 })
    assert.equal(fixture.pointMessages().length, sent)
    pad.handlers.get('pointerdown')({ pointerId: 3, clientX: 50, clientY: 50 })
    assert.equal(fixture.pointMessages().length, sent + 1)
    assert.equal(marker.classList.contains('is-dragging'), true)
  }
})

test('offline touch still updates local feedback and sends points only after connection', () => {
  const fixture = controllerFixture()
  const pad = fixture.element('touchPad')
  const marker = fixture.element('touchMarker')
  pad.handlers.get('pointerdown')({ pointerId: 1, clientX: 50, clientY: 50 })
  assert.equal(marker.hidden, false)
  assert.equal(marker.style.left, '50px')
  assert.equal(fixture.element('touchPosition').textContent, '触点 X 50% · Y 50%（未连接）')
  assert.equal(fixture.pointMessages().length, 0)
  fixture.controller.setConnected(true)
  pad.handlers.get('pointermove')({ pointerId: 1, clientX: 75, clientY: 50 })
  assert.equal(fixture.element('touchPosition').textContent, '触点 X 75% · Y 50%')
  assert.equal(fixture.pointMessages().length, 1)
  near(fixture.pointMessages()[0].point[0], 0.5)
})

test('resizing keeps the last normalized marker location without sending or recentering', () => {
  const rect = { left: 10, top: 20, width: 390, height: 480 }
  const fixture = controllerFixture('granted', true, { touchRect: rect, touchBorderLeft: 2, touchBorderTop: 2 })
  fixture.controller.setConnected(true)
  const pad = fixture.element('touchPad')
  const marker = fixture.element('touchMarker')
  pad.handlers.get('pointerdown')({ pointerId: 1, clientX: 302.5, clientY: 140 })
  pad.handlers.get('pointerup')({ pointerId: 1 })
  assert.equal(fixture.element('touchPosition').textContent, '触点 X 75% · Y 25%')
  assert.equal(marker.style.left, '290.5px')
  assert.equal(marker.style.top, '118px')
  const messageCount = fixture.messages.length
  rect.width = 320
  rect.height = 200
  fixture.resize()
  assert.equal(marker.style.left, '238px')
  assert.equal(marker.style.top, '48px')
  assert.equal(fixture.element('touchPosition').textContent, '触点 X 75% · Y 25%')
  assert.equal(marker.classList.contains('is-dragging'), false)
  assert.equal(fixture.messages.length, messageCount)
  const untouched = controllerFixture()
  untouched.resize()
  assert.equal(untouched.element('touchMarker').hidden, true)
})

test('authorization click and Relative errors publish immediately without requiring a desktop presence', async () => {
  const fixture = controllerFixture('granted', true, {
    staticPermission: false, relative: true, userActivation: { isActive: true, hasBeenActive: true },
  })
  await fixture.click('btnRequestSensorAuthorization')
  let messages = fixture.messages.filter(message => message.type === 'diagnostic')
  const requested = messages.at(-1).diagnostic
  assert.equal(requested.running, true)
  assert.equal(requested.listenersAttached, false)
  assert.match(requested.apiSupport, /authClick\(T\/A\/H\)=1\/1\/1/)
  assert.match(requested.apiSupport, /authStart\(A\/H\)=1\/1/)
  const beforeError = messages.length
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Permissions to access sensor are not granted' } })
  messages = fixture.messages.filter(message => message.type === 'diagnostic')
  assert.equal(messages.length, beforeError + 1)
  assert.match(messages.at(-1).diagnostic.relativeStatus, /NotAllowedError/)
  assert.match(messages.at(-1).diagnostic.reason, /传感器权限未获准/)
  assert.equal(messages.at(-1).diagnostic.relativeHz, 0)
  assert.equal(fixture.pointMessages().length, 0)
})

test('immediate activation and error snapshots preserve cumulative events and the last periodic Hz', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnStart')
  for (let index = 0; index < 4; index += 1) fixture.orientation(sample(20, 30, 0), 20)
  fixture.diagnostics(920)
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.orientationHz, 4)
  assert.equal(diagnostic.orientationEvents, 4)
  fixture.orientation(sample(10, 30, 0), 20)
  fixture.orientation(sample(0, 30, 0), 20)
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Denied' } })
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.orientationHz, 4)
  assert.equal(diagnostic.orientationEvents, 6)
  fixture.activateRelative()
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.relativeActivations, 1)
  assert.equal(diagnostic.relativeActivated, true)
  assert.equal(diagnostic.orientationHz, 4)
  assert.equal(diagnostic.orientationEvents, 6)
  fixture.diagnostics(960)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.orientationHz, 2)
  assert.equal(diagnostic.orientationEvents, 6)
  assert.equal(fixture.pointMessages().length, 0)
})

test('Relative reading loops never publish diagnostics at sensor frequency', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnStart')
  const before = fixture.messages.filter(message => message.type === 'diagnostic').length
  for (let index = 0; index < 100; index += 1) fixture.relative([0, 0, 0, 1], 1)
  assert.equal(fixture.messages.filter(message => message.type === 'diagnostic').length, before)
  assert.equal(fixture.pointMessages().length, 0)
  fixture.diagnostics(900)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.equal(diagnostic.relativeEvents, 100)
  assert.equal(diagnostic.relativeHz, 100)
})

test('read-only permission state changes publish immediately without waiting for the periodic timer', async () => {
  const states = {
    accelerometer: { state: 'prompt', onchange: null }, gyroscope: { state: 'prompt', onchange: null },
    magnetometer: { state: 'prompt', onchange: null },
  }
  const fixture = controllerFixture('granted', true, { permissions: { query: ({ name }) => Promise.resolve(states[name]) } })
  await fixture.click('btnStart')
  await new Promise(setImmediate)
  const before = fixture.messages.filter(message => message.type === 'diagnostic').length
  states.gyroscope.state = 'denied'
  states.gyroscope.onchange()
  const diagnostics = fixture.messages.filter(message => message.type === 'diagnostic')
  assert.equal(diagnostics.length, before + 1)
  assert.match(diagnostics.at(-1).diagnostic.sensorPermissions, /gyroscope=denied/)
})

test('background transitions and callbacks never overwrite the last foreground authorization error', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnRequestSensorAuthorization')
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Denied in foreground' } })
  const before = fixture.messages.filter(message => message.type === 'diagnostic')
  const retained = before.at(-1)
  fixture.visibility(true)
  fixture.relativeInstance().onerror({ error: { name: 'NotReadableError', message: 'Backgrounded' } })
  fixture.diagnostics(1000)
  const after = fixture.messages.filter(message => message.type === 'diagnostic')
  assert.equal(after.length, before.length)
  assert.equal(after.at(-1), retained)
  assert.match(retained.diagnostic.relativeStatus, /NotAllowedError/)
  fixture.visibility(false)
  assert.ok(fixture.messages.filter(message => message.type === 'diagnostic').length > before.length)
})

test('explicit authorization error survives touch pause and ordinary sensor callbacks as labeled history', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnRequestSensorAuthorization')
  fixture.relativeInstance().onerror({ error: { name: 'NotAllowedError', message: 'Permissions to access sensor are not granted' } })
  fixture.element('touchPad').handlers.get('pointerdown')({ pointerId: 1, clientX: 50, clientY: 50 })
  fixture.diagnostics(1000)
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.relativeStatus, /^当前：已暂停并释放传感器；上次申请：错误 NotAllowedError/)
  assert.ok(diagnostic.relativeStatus.length <= 80)
  assert.match(fixture.element('relativeStatus').textContent, /上次申请：错误 NotAllowedError/)
  await fixture.click('btnStart')
  fixture.activateRelative()
  fixture.relative([0, 0, 0, 1])
  fixture.diagnostics(1000)
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.relativeStatus, /^当前：正在读取相对姿态四元数；上次申请：错误 NotAllowedError/)
})

test('pending authorization interrupted by touch or background is unfinished rather than denied', async () => {
  for (const interruption of ['touch', 'background']) {
    const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
    await fixture.click('btnRequestSensorAuthorization')
    if (interruption === 'touch') {
      fixture.element('touchPad').handlers.get('pointerdown')({ pointerId: 1, clientX: 50, clientY: 50 })
    } else {
      fixture.visibility(true)
      fixture.visibility(false)
    }
    fixture.diagnostics(1000)
    const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
    assert.match(diagnostic.relativeStatus, interruption === 'touch' ? /上次申请：未完成（触控中断）/ : /上次申请：未完成（后台中断）/)
    assert.doesNotMatch(diagnostic.relativeStatus, /NotAllowedError|denied|硬件不支持|已授权/)
    assert.ok(diagnostic.relativeStatus.length <= 80)
  }
})

test('a new explicit authorization clears the previous error and only its sensor may update history', async () => {
  const fixture = controllerFixture('granted', true, { staticPermission: false, relative: true })
  await fixture.click('btnRequestSensorAuthorization')
  const oldSensor = fixture.relativeInstance()
  oldSensor.onerror({ error: { name: 'NotAllowedError', message: 'Old failure' } })
  await fixture.click('btnRequestSensorAuthorization')
  oldSensor.onerror({ error: { name: 'NotAllowedError', message: 'Late old failure' } })
  let diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.relativeStatus, /上次申请：已发起，等待真实结果/)
  assert.doesNotMatch(diagnostic.relativeStatus, /NotAllowedError|Old failure/)
  fixture.activateRelative()
  diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.relativeStatus, /上次申请：已真实激活，等待读数/)
})

test('real reading history never fabricates a granted permission and survives later pause', async () => {
  const fixture = controllerFixture('granted', true, {
    staticPermission: false, relative: true, permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
  })
  await fixture.click('btnRequestSensorAuthorization')
  await new Promise(setImmediate)
  fixture.relative([0, 0, 0, 1])
  fixture.element('touchPad').handlers.get('pointerdown')({ pointerId: 1, clientX: 50, clientY: 50 })
  fixture.diagnostics(1000)
  const diagnostic = fixture.messages.filter(message => message.type === 'diagnostic').at(-1).diagnostic
  assert.match(diagnostic.relativeStatus, /上次申请：收到有效reading（非授权状态查询）/)
  assert.doesNotMatch(diagnostic.relativeStatus, /granted|已授权|已允许/)
  assert.match(diagnostic.sensorPermissions, /accelerometer=prompt; gyroscope=prompt; magnetometer=prompt/)
})
