type SensorPermission = 'accelerometer' | 'gyroscope' | 'magnetometer'
type PermissionValue = 'granted' | 'denied' | 'prompt' | 'unknown:pending' | 'unknown:unsupported' | 'unknown:error' | 'unknown:timeout'

interface PermissionStatusReader {
  state: string
  onchange?: (() => void) | null
  addEventListener?: (type: string, callback: () => void) => void
  removeEventListener?: (type: string, callback: () => void) => void
}

interface PolicyReader {
  features?: () => string[]
  allowedFeatures?: () => string[]
  allowsFeature?: (feature: string) => boolean
}

const permissionNames: SensorPermission[] = ['accelerometer', 'gyroscope', 'magnetometer']

export interface SensorEnvironmentSnapshot {
  sensorPermissions: string
  sensorPolicy: string
  apiSupport: string
  browserInfo: string
  focused: boolean | null
}

export function browserSummary(userAgent: string): string {
  // Export only these product/version tokens, never the complete UA or device identifiers.
  const tokens: string[] = []
  for (const name of ['HuaweiBrowser', 'ArkWeb', 'HarmonyOS', 'OpenHarmony', 'Android', 'Chrome', 'Safari', 'Version', 'OS']) {
    const match = new RegExp(`\\b${name}[ /]([0-9][0-9._]{0,31})`, 'i').exec(userAgent)
    if (match) { tokens.push(`${name}/${match[1]}`) }
  }
  const osExposed = tokens.some((token) => /^(HarmonyOS|OpenHarmony|Android|OS)\//.test(token))
  return (tokens.length ? `UA披露：${tokens.join('; ')}${osExposed ? '' : '; 系统版本未披露'}` : '浏览器 / 系统版本未披露').slice(0, 240)
}

export function policySummary(policy: PolicyReader | undefined): string {
  return permissionNames.map((name) => {
    let value = 'unknown'
    if (policy) {
      try {
        const recognized = typeof policy.features === 'function' ? policy.features().indexOf(name) >= 0 : null
        const allowed = typeof policy.allowsFeature === 'function' ? policy.allowsFeature(name) : null
        const inAllowlist = typeof policy.allowedFeatures === 'function' && policy.allowedFeatures().indexOf(name) >= 0
        if (recognized !== false && (allowed === true || inAllowlist)) {
          value = 'allowed'
        } else if (recognized === true && allowed === false) {
          value = 'blocked'
        }
      } catch { /* Unsupported policy inspection stays unknown instead of reporting a denial. */ }
    }
    return `${name}=${value}`
  }).join('; ').slice(0, 160)
}

export class SensorEnvironment {
  private values: Record<SensorPermission, PermissionValue> = {
    accelerometer: 'unknown:pending', gyroscope: 'unknown:pending', magnetometer: 'unknown:pending',
  }
  private revision = 0
  private cleanup: Array<() => void> = []
  private onChange: () => void

  constructor(onChange: () => void) { this.onChange = onChange }

  public refresh(): Promise<void> {
    const revision = ++this.revision
    for (const cleanup of this.cleanup) {
      try { cleanup() } catch { /* Failed listener cleanup must not prevent a new read-only query. */ }
    }
    this.cleanup = []
    const permissionNavigator = navigator as Navigator & {
      permissions?: { query: (descriptor: { name: string }) => Promise<PermissionStatusReader> }
    }
    const permissions = permissionNavigator.permissions
    const queries = permissionNames.map((name) => {
      this.values[name] = 'unknown:pending'
      return new Promise<void>((resolve) => {
        let settled = false
        let timer = 0
        const finish = (value: PermissionValue, status?: PermissionStatusReader): void => {
          if (settled) { return }
          settled = true
          window.clearTimeout(timer)
          if (revision === this.revision) {
            this.values[name] = value
            if (status) { this.watch(name, status, revision) }
            this.onChange()
          }
          resolve()
        }
        if (typeof permissions?.query !== 'function') {
          finish('unknown:unsupported')
          return
        }
        timer = window.setTimeout(() => finish('unknown:timeout'), 1500)
        try {
          // This reads permission state; it never requests or grants permission.
          Promise.resolve(permissions.query({ name })).then((status) => {
            if (status && typeof status.state === 'string') {
              finish(this.permissionValue(status.state), status)
            } else {
              finish('unknown:error')
            }
          }, () => finish('unknown:error'))
        } catch { finish('unknown:error') }
      })
    })
    return Promise.all(queries).then(() => undefined)
  }

  public snapshot(): SensorEnvironmentSnapshot {
    const policyDocument = document as Document & { permissionsPolicy?: PolicyReader; featurePolicy?: PolicyReader }
    const sensorWindow = window as Window & { RelativeOrientationSensor?: unknown }
    let focused: boolean | null = null
    try { focused = typeof document.hasFocus === 'function' ? document.hasFocus() : null } catch { /* Keep unknown. */ }
    const policy = policyDocument.permissionsPolicy ?? policyDocument.featurePolicy
    const apiSupport = `orientation=${typeof DeviceOrientationEvent !== 'undefined'}; motion=${typeof DeviceMotionEvent !== 'undefined'}; relative=${typeof sensorWindow.RelativeOrientationSensor === 'function'}; permissions=${typeof navigator.permissions?.query === 'function'}; policy=${Boolean(policy)}`
    return {
      sensorPermissions: permissionNames.map((name) => `${name}=${this.values[name]}`).join('; ').slice(0, 160),
      sensorPolicy: policySummary(policy), apiSupport: apiSupport.slice(0, 160),
      browserInfo: browserSummary(navigator.userAgent || ''), focused,
    }
  }

  private permissionValue(value: string): PermissionValue {
    return value === 'granted' || value === 'denied' || value === 'prompt' ? value : 'unknown:error'
  }

  private watch(name: SensorPermission, status: PermissionStatusReader, revision: number): void {
    const update = (): void => {
      if (revision === this.revision) {
        this.values[name] = this.permissionValue(status.state)
        this.onChange()
      }
    }
    try {
      if (typeof status.addEventListener === 'function') {
        status.addEventListener('change', update)
        this.cleanup.push(() => status.removeEventListener?.('change', update))
      } else {
        status.onchange = update
        this.cleanup.push(() => { if (status.onchange === update) { status.onchange = null } })
      }
    } catch { /* A valid permission reading remains useful without change notifications. */ }
  }
}
