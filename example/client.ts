import { RemoteController } from './RemoteController'
import { connectSocket } from './ws'

const statusDom = document.getElementById('status') as HTMLDivElement
const room = new URL(window.location.href).searchParams.get('id')

if (!room) {
  statusDom.textContent = '缺少配对编号；请扫描电脑页面生成的二维码。'
  document.querySelectorAll('button').forEach(button => { button.disabled = true })
  ;(document.getElementById('touchPosition') as HTMLOutputElement).textContent = '请先扫码配对'
  ;(document.getElementById('controlMode') as HTMLElement).textContent = '尚未配对，请扫描电脑二维码'
} else {
  let controller: RemoteController | null = null
  const socket = connectSocket('client', {
    room,
    onStatus(status) {
      const labels = { connecting: '正在连接局域网服务器…', connected: '服务器已连接，等待电脑端…', disconnected: '连接已断开，正在重连…' }
      statusDom.textContent = labels[status]
      if (status !== 'connected') {
        controller?.setConnected(false)
        ;(document.getElementById('latency') as HTMLParagraphElement).textContent = '局域网服务器 RTT：等待连接'
      }
    },
    onMessage(message) {
      if (message.type === 'presence') {
        const connected = message.connected === true
        statusDom.textContent = connected ? '电脑已连接 · 仅局域网通信' : '等待电脑端上线…'
        controller?.setConnected(connected)
      } else if (message.type === 'error') {
        statusDom.textContent = String(message.message || '连接错误')
        controller?.setConnected(false)
      } else if (message.type === 'pong' && typeof message.sentAt === 'number' && Number.isFinite(message.sentAt)) {
        const roundTrip = Math.max(0, performance.now() - message.sentAt)
        ;(document.getElementById('latency') as HTMLParagraphElement).textContent = `局域网服务器 RTT：${Math.round(roundTrip)} ms（非端到端延迟）`
      }
    },
  })
  controller = new RemoteController(socket)
  window.setInterval(() => socket.send({ type: 'ping', sentAt: performance.now() }), 2000)
}
