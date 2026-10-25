import {
  createReference,
  gravityOrientation,
  isFiniteAngle,
  isValidSample,
  LowPassFilter,
  normalizedPoint,
  pointerAngles,
  quaternionOrientation,
  tiltAngles,
} from './orientation'
import type { GravitySample, OrientationMode, OrientationSample, ReferenceFrame } from './orientation'
import { SensorEnvironment } from './sensorEnvironment'

interface ControllerConnection {
  send(data: object): boolean
}

type Source = 'orientation' | 'absolute' | 'relative' | 'gravity'
type RequestedMode = OrientationMode | 'gravity'
interface PermissionSource { requestPermission?: () => Promise<string> }
interface RelativeSensor {
  quaternion: ArrayLike<number> | null
  activated?: boolean
  hasReading?: boolean
  timestamp?: number | null
  onactivate: (() => void) | null
  onreading: (() => void) | null
  onerror: ((event: { error?: { name?: string; message?: string } }) => void) | null
  start(): void
  stop(): void
}
interface Candidate {
  source: Source
  mode: OrientationMode
  sample: OrientationSample | null
  firstAt: number
  lastAt: number
  streak: number
}
interface SourceStats {
  events: number
  totalEvents: number
  lastEventAt: number | null
  valid: number
  raw: OrientationSample
}

export class RemoteController {
  private conn: ControllerConnection
  private running = false
  private connected = false
  private listening = false
  private reference: ReferenceFrame | null = null
  private tiltReference: OrientationSample | null = null
  private filter = new LowPassFilter()
  private mode: RequestedMode = 'pointer'
  private active: Candidate | null = null
  private candidates: Candidate[] = []
  private stats: Record<Source, SourceStats> = {
    orientation: this.newStats(), absolute: this.newStats(), relative: this.newStats(), gravity: this.newStats(),
  }
  private gravity: GravitySample = { x: null, y: null, z: null }
  private orientationPermission = '尚未请求'
  private motionPermission = '尚未请求'
  private relativeStatus = '尚未尝试'
  private relativeSensor: RelativeSensor | null = null
  private relativeDenied = false
  private relativeActivations = 0
  private lastAuthorizationResult: string | null = null
  private authorizationPending = false
  private authorizationTracking = false
  private authorizationSensor: RelativeSensor | null = null
  private nativeAuthorization: 'idle' | 'requesting' | 'activated' | 'reading' | 'error' | 'suspended' = 'idle'
  private authorizationClick: string | null = null
  private authorizationStart: string | null = null
  private captureAuthorizationStart = false
  private startAttempt = 0
  private environment: SensorEnvironment
  private screenAngle = this.readScreenAngle()
  private lastValidTime = 0
  private lastSendTime = 0
  private rateTime = performance.now()
  private rateSnapshot = { orientation: 0, absolute: 0, gravity: 0, relative: 0, validHz: 0 }
  private timedOut = false
  private manualTouch = false
  private reason = '点击“启用陀螺仪”申请权限并检测可用数据源'

  constructor(conn: ControllerConnection) {
    this.conn = conn
    this.environment = new SensorEnvironment(() => {
      this.renderEnvironment()
      this.publishDiagnostic()
    })
    this.clearCandidates()
    this.text('securityStatus', window.isSecureContext ? '安全上下文：是（HTTPS / 本机）' : '安全上下文：否；传感器需要受信任的 HTTPS')
    this.refreshControlMode()
    document.getElementById('btnStart')?.addEventListener('click', () => this.toggle())
    document.getElementById('btnRetrySensor')?.addEventListener('click', () => this.retrySensors())
    document.getElementById('btnRequestSensorAuthorization')?.addEventListener('click', (event) => this.requestSensorAuthorization(event))
    document.getElementById('btnReset')?.addEventListener('click', () => this.recenter('已归零；请保持当前持机姿势'))
    document.getElementById('btnPrevious')?.addEventListener('click', () => this.conn.send({ type: 'page', direction: 'previous' }))
    document.getElementById('btnNext')?.addEventListener('click', () => this.conn.send({ type: 'page', direction: 'next' }))
    document.getElementById('rangeSensitivity')?.addEventListener('input', () => this.text('sensitivityValue', `${this.sensitivity().toFixed(1)}×`))
    document.getElementById('sensorMode')?.addEventListener('change', () => {
      this.mode = (document.getElementById('sensorMode') as HTMLSelectElement).value as RequestedMode
      this.clearCandidates()
      this.recenter('控制模式已改变；等待下一帧数据自动归零')
      this.lastValidTime = performance.now()
      this.timedOut = false
      this.refreshControlMode()
    })
    document.addEventListener('visibilitychange', () => {
      this.clearCandidates()
      this.recenter(document.hidden ? '页面在后台，已停止发送' : this.running
        ? this.nativeAuthorization !== 'idle' ? '独立授权尝试已暂停；请再次点击“申请浏览器传感器权限”' : '已返回前台；下一帧自动归零'
        : '已返回前台；陀螺仪仍暂停，点击“启用陀螺仪”恢复')
      this.lastValidTime = performance.now()
      this.timedOut = false
      this.refreshControlMode()
      if (document.hidden) {
        this.stopRelative('后台中断')
        if (this.nativeAuthorization !== 'idle') { this.nativeAuthorization = 'suspended' }
        this.refreshControlMode()
      } else if (this.running && this.nativeAuthorization === 'idle') {
        this.startRelative()
      }
      if (!document.hidden) { this.publishDiagnostic() }
    })
    window.addEventListener('orientationchange', () => this.onScreenChange())
    window.screen.orientation?.addEventListener('change', () => this.onScreenChange())
    this.listenTouchTest()
    this.environment.refresh()
    window.setInterval(() => this.updateDiagnostics(), 1000)
  }

  public setConnected(connected: boolean): void {
    if (connected === this.connected) {
      return
    }
    this.connected = connected
    this.recenter(connected ? '电脑已连接；启用后下一帧自动归零' : '电脑连接中断，已停止发送')
    if (connected) { this.publishDiagnostic() }
  }

  private orientationListener = (event: DeviceOrientationEvent): void => this.onOrientation('orientation', event)
  private absoluteListener = (event: Event): void => this.onOrientation('absolute', event as DeviceOrientationEvent)
  private motionListener = (event: DeviceMotionEvent): void => this.onMotion(event)

  private async toggle(trackAuthorization = false): Promise<void> {
    if (this.running) {
      this.pause('已暂停；点击“启用陀螺仪”恢复')
      return
    }
    if (!window.isSecureContext) {
      this.setReason('当前不是安全上下文。请信任本地 CA 后，使用二维码中的 HTTPS 地址打开。')
      return
    }
    if (!trackAuthorization) {
      this.authorizationTracking = false
      this.authorizationSensor = null
    }
    const button = document.getElementById('btnStart') as HTMLButtonElement
    button.disabled = true
    this.nativeAuthorization = 'idle'
    const attempt = ++this.startAttempt
    // Invoke both available permission methods before the first await preserves the user gesture.
    const orientation = typeof DeviceOrientationEvent === 'undefined' ? undefined : DeviceOrientationEvent as PermissionSource
    const motion = typeof DeviceMotionEvent === 'undefined' ? undefined : DeviceMotionEvent as PermissionSource
    const requests = [this.requestPermission('orientation', orientation), this.requestPermission('motion', motion)]
    this.environment.refresh()
    this.running = true
    this.manualTouch = false
    this.clearCandidates()
    this.lastValidTime = performance.now()
    this.timedOut = false
    this.recenter('正在检测方向事件、绝对方向、运动重力与 RelativeOrientationSensor；请缓慢转动和倾斜手机')
    this.text('btnStart', '暂停陀螺仪')
    this.bindLegacyListeners()
    this.startRelative()
    this.publishDiagnostic()
    await Promise.all(requests)
    if (attempt !== this.startAttempt) { return }
    if (this.running && !document.hidden && (typeof orientation?.requestPermission === 'function' || typeof motion?.requestPermission === 'function')) {
      // A sensor started before the permission promises settled can enter an error state.
      // Recreate it once after those requests, without blocking other working sources.
      this.bindLegacyListeners()
      this.stopRelative()
      this.relativeSensor = null
      this.startRelative()
    }
    button.disabled = false
    this.showPermissions()
    this.publishDiagnostic()
  }

  private requestPermission(kind: 'orientation' | 'motion', api: PermissionSource | undefined): Promise<void> {
    const set = (value: string): void => {
      if (kind === 'orientation') {
        this.orientationPermission = value
      } else {
        this.motionPermission = value
      }
      this.showPermissions()
    }
    if (typeof api?.requestPermission !== 'function') {
      set('无网页授权方法；授权状态待查询')
      return Promise.resolve()
    }
    set('请求中')
    try {
      return Promise.resolve(api.requestPermission()).then((permission) => {
        set(permission === 'granted' ? '已允许' : `权限被拒绝：${permission}`)
      }, (error: unknown) => set(`权限请求失败：${this.errorText(error)}`))
    } catch (error) {
      set(`权限请求失败：${this.errorText(error)}`)
      return Promise.resolve()
    }
  }

  private startRelative(): void {
    const sensorWindow = window as Window & {
      RelativeOrientationSensor?: new (options: { frequency: number; referenceFrame: string }) => RelativeSensor
    }
    const Sensor = sensorWindow.RelativeOrientationSensor
    if (typeof Sensor !== 'function') {
      this.relativeStatus = '浏览器未提供 RelativeOrientationSensor'
      this.recordAuthorizationResult('Relative接口未提供；方向/运动结果见权限栏', true)
      return
    }
    this.relativeDenied = false
    try {
      if (!this.relativeSensor) {
        const sensor = new Sensor({ frequency: 60, referenceFrame: 'device' })
        this.relativeSensor = sensor
        if (this.authorizationTracking) { this.authorizationSensor = sensor }
        sensor.onactivate = () => {
          if (this.relativeSensor !== sensor) { return }
          this.relativeDenied = false
          if (this.nativeAuthorization !== 'idle') { this.nativeAuthorization = 'activated' }
          this.relativeActivations += 1
          if (this.authorizationSensor === sensor) { this.recordAuthorizationResult('已真实激活，等待读数') }
          this.relativeStatus = '已激活，等待 reading'
          this.renderEnvironment()
          this.publishDiagnostic()
        }
        sensor.onreading = () => {
          if (this.relativeSensor !== sensor) { return }
          const sample = quaternionOrientation(sensor.quaternion)
          if (sample) { this.relativeDenied = false }
          if (sample && this.nativeAuthorization !== 'idle') { this.nativeAuthorization = 'reading' }
          if (sample && this.authorizationSensor === sensor) { this.recordAuthorizationResult('收到有效reading（非授权状态查询）', true) }
          this.relativeStatus = sample ? '正在读取相对姿态四元数' : '已收到 reading，但四元数无效'
          this.receive('relative', sample)
        }
        sensor.onerror = (event) => {
          if (this.relativeSensor !== sensor) { return }
          const error = event.error
          if (this.authorizationSensor === sensor) {
            this.recordAuthorizationError(error?.name || 'UnknownError', error?.message || '')
          }
          if (this.nativeAuthorization !== 'idle') { this.nativeAuthorization = 'error' }
          this.relativeDenied = error?.name === 'NotAllowedError'
          this.relativeStatus = `接口错误：${error?.name || 'UnknownError'} ${error?.message || ''}`.slice(0, 160)
          if (this.permissionBlocked()) { this.setReason('传感器权限未获准') }
          this.showPermissions()
          this.publishDiagnostic()
        }
      }
      this.relativeStatus = '接口存在，已启动，等待 reading'
      if (this.captureAuthorizationStart) {
        this.authorizationStart = this.userActivationSummary()
        this.captureAuthorizationStart = false
      }
      this.relativeSensor.start()
    } catch (error) {
      if (this.nativeAuthorization !== 'idle') { this.nativeAuthorization = 'error' }
      this.relativeDenied = typeof error === 'object' && error !== null && 'name' in error && (error as { name?: string }).name === 'NotAllowedError'
      this.relativeStatus = `无法启动：${this.errorText(error)}`.slice(0, 160)
      const details = typeof error === 'object' && error !== null ? error as { name?: string; message?: string } : null
      this.recordAuthorizationError(details?.name || 'UnknownError', details?.message || String(error))
      if (this.permissionBlocked()) { this.setReason('传感器权限未获准') }
      this.publishDiagnostic()
    }
    this.showPermissions()
  }

  private requestSensorAuthorization(event: MouseEvent): Promise<void> {
    const trusted = typeof event?.isTrusted === 'boolean' ? event.isTrusted ? '1' : '0' : '?'
    this.authorizationClick = `${trusted}/${this.userActivationSummary()}`
    this.authorizationStart = null
    this.captureAuthorizationStart = true
    const orientation = typeof DeviceOrientationEvent === 'undefined' ? undefined : DeviceOrientationEvent as PermissionSource
    const motion = typeof DeviceMotionEvent === 'undefined' ? undefined : DeviceMotionEvent as PermissionSource
    if (typeof orientation?.requestPermission === 'function' || typeof motion?.requestPermission === 'function') {
      const request = this.retrySensors(true)
      this.publishDiagnostic()
      return request
    }
    const sensorWindow = window as Window & { RelativeOrientationSensor?: unknown }
    if (typeof sensorWindow.RelativeOrientationSensor !== 'function' || !window.isSecureContext) {
      this.captureAuthorizationStart = false
      this.lastAuthorizationResult = window.isSecureContext ? '未发起：没有可用原生接口' : '未发起：非安全上下文'
      this.authorizationTracking = false
      this.authorizationPending = false
      this.authorizationSensor = null
      this.setReason('没有可主动调用的原生传感器授权接口；可继续触控或尝试普通启用。')
      this.renderEnvironment()
      this.publishDiagnostic()
      return Promise.resolve()
    }
    // This is a single-source authorization experiment, not evidence that source competition caused the failure.
    this.startAttempt += 1
    this.stopRelative()
    this.relativeSensor = null
    this.beginAuthorization()
    this.unbindLegacyListeners()
    this.running = true
    this.manualTouch = false
    this.relativeDenied = false
    this.nativeAuthorization = 'requesting'
    this.clearCandidates()
    this.lastValidTime = performance.now()
    this.timedOut = false
    this.text('btnStart', '暂停陀螺仪')
    this.recenter('独立尝试原生授权：仅启动 Relative；是否出现授权框由浏览器决定，返回真实数据前不代表可用。')
    // Start synchronously in the real click before queries, legacy listeners, or any await.
    this.startRelative()
    this.publishDiagnostic()
    this.environment.refresh()
    return Promise.resolve()
  }

  private userActivationSummary(): string {
    const activationNavigator = navigator as Navigator & { userActivation?: { isActive?: boolean; hasBeenActive?: boolean } }
    const flag = (value: boolean | undefined): string => typeof value === 'boolean' ? value ? '1' : '0' : '?'
    try { return `${flag(activationNavigator.userActivation?.isActive)}/${flag(activationNavigator.userActivation?.hasBeenActive)}` }
    catch { return '?/?' }
  }

  private apiSupportSummary(support: string): string {
    return (this.authorizationClick === null ? support
      : `${support}; authClick(T/A/H)=${this.authorizationClick}; authStart(A/H)=${this.authorizationStart ?? '?/?'}`).slice(0, 160)
  }

  private retrySensors(trackAuthorization = false): Promise<void> {
    this.pause('正在重新检测权限与传感器')
    this.relativeSensor = null
    this.relativeDenied = false
    if (trackAuthorization) { this.beginAuthorization() }
    // The new permission calls still run in this click, before toggle reaches its first await.
    return this.toggle(trackAuthorization)
  }

  private beginAuthorization(): void {
    this.lastAuthorizationResult = '已发起，等待真实结果'
    this.authorizationPending = true
    this.authorizationTracking = true
    this.authorizationSensor = null
  }

  private recordAuthorizationResult(result: string, terminal = false): void {
    if (!this.authorizationTracking) { return }
    this.lastAuthorizationResult = result.slice(0, 50)
    this.authorizationPending = false
    if (terminal) { this.authorizationTracking = false }
  }

  private recordAuthorizationError(name: string, message: string): void {
    this.recordAuthorizationResult(`错误 ${name.slice(0, 32)}${message ? `：${message.slice(0, 12)}` : ''}`)
  }

  private relativeReport(): string {
    const history = (this.lastAuthorizationResult ?? '尚未申请').slice(0, 50)
    const separator = '；上次申请：'
    const current = this.relativeStatus.slice(0, 80 - '当前：'.length - separator.length - history.length)
    return `当前：${current}${separator}${history}`
  }

  private bindLegacyListeners(): void {
    this.unbindLegacyListeners()
    // A browser may stop a stream after its first null event. Rebinding on an explicit
    // enable/retry lets it request a fresh stream after the user changes permissions.
    window.addEventListener('deviceorientation', this.orientationListener, false)
    window.addEventListener('deviceorientationabsolute', this.absoluteListener, false)
    window.addEventListener('devicemotion', this.motionListener, false)
    this.listening = true
  }

  private unbindLegacyListeners(): void {
    if (!this.listening) { return }
    window.removeEventListener('deviceorientation', this.orientationListener, false)
    window.removeEventListener('deviceorientationabsolute', this.absoluteListener, false)
    window.removeEventListener('devicemotion', this.motionListener, false)
    this.listening = false
  }

  private stopRelative(interruption?: string): void {
    if (interruption) {
      if (this.authorizationTracking && this.authorizationPending) {
        this.lastAuthorizationResult = `未完成（${interruption}）`
      }
      this.authorizationTracking = false
      this.authorizationPending = false
      this.authorizationSensor = null
    }
    if (this.relativeSensor) {
      try { this.relativeSensor.stop() } catch { /* A stopped or failed sensor needs no further cleanup. */ }
      this.relativeStatus = '已暂停并释放传感器'
    }
  }

  private onOrientation(source: 'orientation' | 'absolute', event: DeviceOrientationEvent): void {
    const clean = (value: number | null): number | null => isFiniteAngle(value) ? value : null
    this.receive(source, { alpha: clean(event.alpha), beta: clean(event.beta), gamma: clean(event.gamma) })
  }

  private onMotion(event: DeviceMotionEvent): void {
    const raw = event.accelerationIncludingGravity
    const clean = (value: number | null | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
    this.gravity = { x: clean(raw?.x), y: clean(raw?.y), z: clean(raw?.z) }
    this.receive('gravity', gravityOrientation(this.gravity))
  }

  private receive(source: Source, sample: OrientationSample | null): void {
    const now = performance.now()
    const stats = this.stats[source]
    stats.events += 1
    stats.totalEvents += 1
    stats.lastEventAt = now
    stats.raw = sample ?? { alpha: null, beta: null, gamma: null }
    if (sample && isValidSample(sample, 'tilt')) {
      stats.valid += 1
    }
    if (!this.running || document.hidden) {
      return
    }
    for (const candidate of this.candidates) {
      if (candidate.source !== source) {
        continue
      }
      if (sample && isValidSample(sample, candidate.mode)) {
        if (now - candidate.lastAt > 1000 || !candidate.streak) {
          candidate.firstAt = now
          candidate.streak = 0
        }
        candidate.sample = sample
        candidate.lastAt = now
        candidate.streak += 1
      } else {
        candidate.streak = 0
      }
    }
    const selected = this.selectSource(now)
    if (!selected || selected.source !== source || selected.lastAt !== now || !selected.sample) {
      return
    }
    this.lastValidTime = now
    this.timedOut = false
    this.refreshControlMode()
    if (!this.connected) {
      return
    }
    const angle = this.readScreenAngle()
    if (angle !== this.screenAngle) {
      this.onScreenChange()
    }
    if (selected.mode === 'pointer' && !this.reference) {
      this.reference = createReference(selected.sample, this.screenAngle)
      this.setReason(`${this.sourceLabel(selected)}已归零；用手机上边缘指向屏幕`)
    }
    if (selected.mode === 'tilt' && !this.tiltReference) {
      this.tiltReference = { ...selected.sample }
      this.setReason(`${this.sourceLabel(selected)}已归零；左右倾斜 / 前后俯仰控制，不支持水平偏航`)
    }
    const angles = selected.mode === 'pointer'
      ? pointerAngles(selected.sample, this.reference as ReferenceFrame, this.screenAngle)
      : tiltAngles(selected.sample, this.tiltReference as OrientationSample, this.screenAngle)
    const filtered = this.filter.update(angles, now)
    if (now - this.lastSendTime < 16) {
      return
    }
    this.lastSendTime = now
    this.conn.send({ type: 'point', point: normalizedPoint(
      filtered, this.sensitivity(),
      (document.getElementById('reverseX') as HTMLInputElement).checked,
      (document.getElementById('reverseY') as HTMLInputElement).checked,
    ) })
  }

  private selectSource(now: number): Candidate | null {
    const available = this.candidates.filter((candidate) => {
      const allowed = this.mode === 'gravity' ? candidate.source === 'gravity' : this.mode !== 'tilt' || candidate.mode === 'tilt'
      return allowed && candidate.sample !== null && now - candidate.lastAt <= 1000
    })
    let selected = available[0] ?? null
    const current = this.active
    if (current && available.indexOf(current) >= 0) {
      // Upgrade only after a stable stream, and hold the current source through brief gaps.
      const upgrade = selected && this.candidates.indexOf(selected) < this.candidates.indexOf(current)
        && selected.streak >= 3 && now - selected.firstAt >= 200
      if (!upgrade) {
        selected = current
      }
    }
    if (selected !== current) {
      this.active = selected
      this.recenter(selected ? `已选择${this.sourceLabel(selected)}；下一帧自动归零` : '当前数据源已停止，正在检测其他可用接口')
    }
    this.text('activeSource', this.running ? `选中源：${selected ? this.sourceLabel(selected) : '无有效数据'}` : '选中源：已暂停')
    this.refreshControlMode()
    return selected
  }

  private clearCandidates(): void {
    const definitions: Array<[Source, OrientationMode]> = [
      ['orientation', 'pointer'], ['absolute', 'pointer'], ['relative', 'pointer'],
      ['orientation', 'tilt'], ['absolute', 'tilt'], ['relative', 'tilt'], ['gravity', 'tilt'],
    ]
    this.candidates = definitions.map(([source, mode]) => ({ source, mode, sample: null, firstAt: 0, lastAt: -Infinity, streak: 0 }))
    this.active = null
  }

  private newStats(): SourceStats {
    return { events: 0, totalEvents: 0, lastEventAt: null, valid: 0, raw: { alpha: null, beta: null, gamma: null } }
  }

  private sourceLabel(candidate: Candidate): string {
    const names = { orientation: '方向事件', absolute: 'absolute 方向事件', relative: 'Relative 相对姿态', gravity: 'Motion 重力倾斜备用' }
    return `${names[candidate.source]}${candidate.source === 'gravity' ? '（无陀螺仪偏航）' : candidate.mode === 'pointer' ? ' · 指向' : ' · 倾斜备用'}`
  }

  private pause(message: string, manualTouch = false): void {
    this.startAttempt += 1
    this.running = false
    this.nativeAuthorization = 'idle'
    this.manualTouch = manualTouch
    this.stopRelative(manualTouch ? '触控中断' : '暂停中断')
    this.clearCandidates()
    this.text('btnStart', '启用陀螺仪')
    this.text('activeSource', '选中源：已暂停')
    this.recenter(message)
  }

  private recenter(message: string): void {
    this.reference = null
    this.tiltReference = null
    this.filter.reset()
    this.lastSendTime = 0
    if (this.connected) {
      this.conn.send({ type: 'reset' })
    }
    this.setReason(message)
  }

  private setReason(message: string): void {
    this.reason = (this.permissionBlocked()
      ? '传感器权限未获准（Relative NotAllowedError）；可点击“申请浏览器传感器权限”或“重试传感器授权”，是否弹窗由浏览器决定。'
      : message).slice(0, 160)
    this.text('sensorStatus', this.reason)
    this.refreshControlMode()
  }

  private refreshControlMode(): void {
    let label: string
    if (document.hidden) {
      label = '后台暂停发送'
    } else if (!this.running) {
      label = this.manualTouch ? '手动触控模式 · 陀螺仪已暂停' : this.listening
        ? '触控模式 · 陀螺仪已暂停' : '触控模式 · 陀螺仪未启用'
    } else if (this.permissionBlocked()) {
      label = '传感器权限未获准'
    } else if (this.nativeAuthorization === 'requesting' && !this.timedOut) {
      label = '正在申请原生传感器授权 · 是否弹窗由浏览器决定'
    } else if (this.nativeAuthorization === 'activated' && !this.active) {
      label = '原生传感器已激活 · 等待真实读数'
    } else if (this.nativeAuthorization === 'error' && !this.active) {
      label = '原生传感器请求失败 · 查看诊断'
    } else if (this.nativeAuthorization === 'suspended') {
      label = '独立授权尝试已暂停 · 请点击申请浏览器传感器权限'
    } else if (this.timedOut) {
      const received = Object.keys(this.stats).some((source) => this.stats[source as Source].totalEvents > 0)
      label = received ? '陀螺仪已启用，尚无有效数据' : '陀螺仪已启用，尚未收到数据'
    } else {
      label = this.active ? `陀螺仪运行中 · ${this.sourceLabel(this.active)}` : '陀螺仪已启用 · 等待数据'
    }
    this.text('controlMode', label)
  }

  private showPermissions(): void {
    this.text('permissionStatus', `方向权限：${this.orientationPermission}；运动权限：${this.motionPermission}`)
    this.text('relativeStatus', `Relative：${this.relativeReport()}`)
    this.renderEnvironment()
  }

  private permissionBlocked(): boolean {
    const working = this.active !== null && performance.now() - this.active.lastAt <= 1000
    return this.running && this.relativeDenied && !working
  }

  private relativeSnapshot(): {
    relativeActivated: boolean | null; relativeHasReading: boolean | null; relativeTimestamp: number | null
  } {
    let relativeActivated: boolean | null = null
    let relativeHasReading: boolean | null = null
    let relativeTimestamp: number | null = null
    try {
      const sensor = this.relativeSensor
      if (typeof sensor?.activated === 'boolean') { relativeActivated = sensor.activated }
      if (typeof sensor?.hasReading === 'boolean') { relativeHasReading = sensor.hasReading }
      if (typeof sensor?.timestamp === 'number' && Number.isFinite(sensor.timestamp)) { relativeTimestamp = sensor.timestamp }
    } catch { /* Unsupported sensor state inspection remains unknown. */ }
    return { relativeActivated, relativeHasReading, relativeTimestamp }
  }

  private renderEnvironment(): void {
    if (!this.environment) { return }
    const environment = this.environment.snapshot()
    const relative = this.relativeSnapshot()
    const state = (value: boolean | null): string => value === null ? '未知' : value ? '是' : '否'
    this.text('sensorEnvironment', [
      `权限：${environment.sensorPermissions}`,
      `策略：${environment.sensorPolicy}；焦点：${state(environment.focused)}`,
      `接口：${this.apiSupportSummary(environment.apiSupport)}；版本：${environment.browserInfo}`,
      `Relative 激活：${state(relative.relativeActivated)}；有读数：${state(relative.relativeHasReading)}；激活事件 ${this.relativeActivations} 次`,
    ].join('\n'))
    this.refreshControlMode()
  }

  private errorText(error: unknown): string {
    return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 120)
  }

  private onScreenChange(): void {
    this.screenAngle = this.readScreenAngle()
    this.recenter('屏幕方向已改变；下一帧自动归零')
  }

  private readScreenAngle(): number {
    const legacyWindow = window as Window & { orientation?: number }
    return window.screen.orientation?.angle ?? legacyWindow.orientation ?? 0
  }

  private sensitivity(): number {
    return Number((document.getElementById('rangeSensitivity') as HTMLInputElement).value)
  }

  private text(id: string, value: string): void {
    const element = document.getElementById(id)
    if (element && element.textContent !== value) { element.textContent = value }
  }

  private diagnosticAge(source: Source, now: number): number | null {
    const lastEvent = this.stats[source].lastEventAt
    return lastEvent === null ? null : Math.min(86400000, Math.max(0, Math.round(now - lastEvent)))
  }

  private buildDiagnostic(now: number) {
    const environment = this.environment.snapshot()
    const raw = this.active?.sample ?? this.stats.orientation.raw
    return {
      secure: window.isSecureContext, running: this.running, requestedMode: this.mode,
      visible: !document.hidden, listenersAttached: this.listening,
      ...environment, apiSupport: this.apiSupportSummary(environment.apiSupport),
      ...this.relativeSnapshot(), relativeActivations: this.relativeActivations,
      activeSource: this.active ? `${this.active.source}:${this.active.mode}` : 'none',
      orientationPermission: this.orientationPermission, motionPermission: this.motionPermission,
      orientationHz: this.rateSnapshot.orientation, absoluteHz: this.rateSnapshot.absolute,
      motionHz: this.rateSnapshot.gravity, relativeHz: this.rateSnapshot.relative,
      relativeStatus: this.relativeReport(), validHz: this.rateSnapshot.validHz,
      orientationEvents: this.stats.orientation.totalEvents, absoluteEvents: this.stats.absolute.totalEvents,
      motionEvents: this.stats.gravity.totalEvents, relativeEvents: this.stats.relative.totalEvents,
      orientationAgeMs: this.diagnosticAge('orientation', now), absoluteAgeMs: this.diagnosticAge('absolute', now),
      motionAgeMs: this.diagnosticAge('gravity', now), relativeAgeMs: this.diagnosticAge('relative', now),
      alpha: raw.alpha, beta: raw.beta, gamma: raw.gamma,
      gravityX: this.gravity.x, gravityY: this.gravity.y, gravityZ: this.gravity.z,
      reason: this.reason,
    }
  }

  private publishDiagnostic(): void {
    // Background lifecycle updates must not overwrite the last actionable foreground error.
    if (document.hidden) { return }
    // Diagnostics need only an open LAN socket; a desktop presence is required only for points.
    this.conn.send({ type: 'diagnostic', diagnostic: this.buildDiagnostic(performance.now()) })
  }

  private updateDiagnostics(): void {
    const now = performance.now()
    if (this.running && !document.hidden) {
      this.selectSource(now)
      if (now - this.lastValidTime > 5000 && !this.timedOut) {
        this.timedOut = true
        this.recenter('浏览器未提供有效传感器数据，可继续触控，展开诊断查看上次申请结果。')
      }
    }
    const seconds = Math.max(0.001, (now - this.rateTime) / 1000)
    for (const source of Object.keys(this.stats)) {
      this.rateSnapshot[source as Source] = Math.round(this.stats[source as Source].events / seconds)
    }
    this.rateSnapshot.validHz = Math.round(Object.keys(this.stats).reduce((sum, source) => sum + this.stats[source as Source].valid, 0) / seconds)
    const hz = (source: Source): number => this.rateSnapshot[source]
    const display = (value: number | null): string => isFiniteAngle(value) ? value.toFixed(1) : '无数据'
    const axes = (sample: OrientationSample): string => `α ${display(sample.alpha)} / β ${display(sample.beta)} / γ ${display(sample.gamma)}`
    const raw = this.stats.orientation.raw
    const selectedRaw = this.active?.sample ?? raw
    const rate = (source: Source): string => `${hz(source)} / ${(this.stats[source].valid / seconds).toFixed(0)} Hz`
    this.text('eventRate', `事件 / 有效：方向 ${rate('orientation')} · absolute ${rate('absolute')} · Motion ${rate('gravity')} · Relative ${rate('relative')}`)
    const history = (source: Source): string => {
      const elapsed = this.diagnosticAge(source, now)
      return `${this.stats[source].totalEvents} 次，${elapsed === null ? '从未收到' : `最后 ${(elapsed / 1000).toFixed(1)} 秒前`}`
    }
    this.text('eventHistory', `累计 / 最后事件：方向 ${history('orientation')}；absolute ${history('absolute')}；Motion ${history('gravity')}；Relative ${history('relative')}`)
    this.text('selectedData', `选中源轴值：${this.active ? axes(selectedRaw) : '无有效数据'}${this.active ? '°' : ''}`)
    this.text('rawData', `方向 ${axes(raw)}°；absolute ${axes(this.stats.absolute.raw)}°`)
    this.text('motionData', `Motion 重力 x ${display(this.gravity.x)} / y ${display(this.gravity.y)} / z ${display(this.gravity.z)} m/s²`)
    this.showPermissions()
    this.publishDiagnostic()
    for (const source of Object.keys(this.stats)) {
      this.stats[source as Source].events = 0
      this.stats[source as Source].valid = 0
    }
    this.rateTime = now
  }

  private listenTouchTest(): void {
    const pad = document.getElementById('touchPad') as HTMLDivElement
    const marker = document.getElementById('touchMarker') as HTMLDivElement | null
    let activePointerId: number | null = null
    let lastPoint: [number, number] | null = null
    const positionMarker = (rect: DOMRect): void => {
      if (!marker || !lastPoint || rect.width <= 0 || rect.height <= 0) { return }
      // Keep the normalized touch location when the viewport folds or rotates.
      marker.style.left = `${((lastPoint[0] + 1) / 2) * rect.width - (pad.clientLeft || 0)}px`
      marker.style.top = `${((lastPoint[1] + 1) / 2) * rect.height - (pad.clientTop || 0)}px`
    }
    const highlight = (dragging: boolean): void => {
      pad.classList.toggle('is-dragging', dragging)
      marker?.classList.toggle('is-dragging', dragging)
    }
    const send = (event: PointerEvent): void => {
      if (activePointerId !== event.pointerId) { return }
      const rect = pad.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) { return }
      const x = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1))
      const y = Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1))
      const horizontal = (x + 1) / 2
      const vertical = (y + 1) / 2
      lastPoint = [x, y]
      if (marker) {
        marker.hidden = false
        // The transmitted point uses the border box; absolute marker offsets start inside its border.
        positionMarker(rect)
      }
      this.text('touchPosition', `触点 X ${Math.round(horizontal * 100)}% · Y ${Math.round(vertical * 100)}%${this.connected ? '' : '（未连接）'}`)
      if (this.connected) { this.conn.send({ type: 'point', point: [x, y] }) }
    }
    const finish = (event: PointerEvent): void => {
      if (activePointerId !== event.pointerId) { return }
      activePointerId = null
      highlight(false)
    }
    pad.addEventListener('pointerdown', (event) => {
      if (activePointerId !== null) { return }
      this.pause('手动触控已暂停陀螺仪；点击“启用陀螺仪”才能恢复传感器控制', true)
      activePointerId = event.pointerId
      pad.setPointerCapture(event.pointerId)
      highlight(true)
      send(event)
    })
    pad.addEventListener('pointermove', send)
    pad.addEventListener('pointerup', finish)
    pad.addEventListener('pointercancel', finish)
    pad.addEventListener('lostpointercapture', finish)
    window.addEventListener('resize', () => positionMarker(pad.getBoundingClientRect()))
  }
}
