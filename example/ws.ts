export interface SocketMessage {
  type: string
  point?: [number, number]
  color?: [number, number, number]
  connected?: boolean
  direction?: 'next' | 'previous'
  message?: string
  sentAt?: number
  diagnostic?: {
    secure: boolean
    running: boolean
    visible?: boolean
    listenersAttached?: boolean
    focused?: boolean | null
    sensorPermissions?: string
    sensorPolicy?: string
    apiSupport?: string
    browserInfo?: string
    relativeActivated?: boolean | null
    relativeHasReading?: boolean | null
    relativeActivations?: number
    relativeTimestamp?: number | null
    updatedAt?: string
    requestedMode?: string
    activeSource?: string
    orientationPermission?: string
    motionPermission?: string
    relativeStatus?: string
    reason?: string
    orientationHz?: number
    absoluteHz?: number
    motionHz?: number
    relativeHz?: number
    validHz?: number
    orientationEvents?: number
    absoluteEvents?: number
    motionEvents?: number
    relativeEvents?: number
    orientationAgeMs?: number | null
    absoluteAgeMs?: number | null
    motionAgeMs?: number | null
    relativeAgeMs?: number | null
    alpha?: number | null
    beta?: number | null
    gamma?: number | null
    gravityX?: number | null
    gravityY?: number | null
    gravityZ?: number | null
  }
}

export function connectSocket(role: 'main' | 'client', options: {
  room: string
  onMessage?: (message: SocketMessage) => void
  onStatus?: (status: 'connecting' | 'connected' | 'disconnected') => void
}) {
  let socket: WebSocket
  let retry = 500
  let stopped = false
  let retryTimer = 0
  let session = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => (`0${value.toString(16)}`).slice(-2)).join('')
  if (role === 'client') {
    try {
      const key = `laser-pen-session:${options.room}`
      session = sessionStorage.getItem(key) || session
      sessionStorage.setItem(key, session)
    } catch { /* A private browser may disable storage; reconnects still share this instance. */ }
  }
  const connect = () => {
    if (stopped) {return}
    options.onStatus?.('connecting')
    const url = new URL('/ws', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('role', role)
    url.searchParams.set('room', options.room)
    url.searchParams.set('session', session)
    socket = new WebSocket(url.toString())
    socket.onopen = () => { retry = 500; options.onStatus?.('connected') }
    socket.onmessage = event => {
      try { options.onMessage?.(JSON.parse(event.data)) } catch (error) { console.error(error) }
    }
    socket.onerror = () => socket.close()
    socket.onclose = event => {
      options.onStatus?.('disconnected')
      if (event.code === 1008) {stopped = true}
      if (!stopped) {
        retryTimer = window.setTimeout(connect, retry)
        retry = Math.min(5000, retry * 2)
      }
    }
  }
  connect()
  return {
    send(data: object): boolean {
      // Drop old positions instead of replaying a queue after reconnecting.
      if (socket.readyState !== WebSocket.OPEN || ((data as { type?: string }).type === 'point' && socket.bufferedAmount > 4096)) {return false}
      socket.send(JSON.stringify(data))
      return true
    },
    close() { stopped = true; clearTimeout(retryTimer); socket.close() },
  }
}
