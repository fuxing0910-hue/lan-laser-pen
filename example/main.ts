import QRCode from 'qrcode'
import type { IOriginalPointData } from '../src/index'
import { drawLaserPen, drainPoints, setColor, setDelay, setMaxWidth } from '../src/index'
import { connectSocket } from './ws'

const canvas = document.querySelector('#cvs') as HTMLCanvasElement
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
const status = document.querySelector('#status') as HTMLElement
const qr = document.querySelector('#qr-code') as HTMLImageElement
const link = document.querySelector('#client-url') as HTMLAnchorElement
const addresses = document.querySelector('#addresses') as HTMLSelectElement
let points: IOriginalPointData[] = []
let point: [number, number] = [0, 0]
let color: [number, number, number] = [255, 0, 0]
let visible = false
let lastPointAt = 0
let paintPending = false

const trailDurationMs = 500
setDelay(trailDurationMs)
setMaxWidth(8)
function resize() {
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(canvas.clientWidth * ratio)
  canvas.height = Math.round(canvas.clientHeight * ratio)
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  points = []
  requestPaint()
}
function requestPaint() {
  if (!paintPending) { paintPending = true; requestAnimationFrame(paint) }
}
function paint() {
  paintPending = false
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  ctx.clearRect(0, 0, width, height)
  points = drainPoints(points)
  setColor(...color)
  if (points.length >= 2) {
    // Continue fading after motion stops rather than abruptly clearing a frozen trail.
    ctx.save()
    ctx.globalAlpha = Math.max(0, 1 - (Date.now() - points[points.length - 1].time) / trailDurationMs)
    if (points.length >= 3) {
      drawLaserPen(ctx, points)
    } else {
      ctx.strokeStyle = `rgb(${color.join(',')})`
      ctx.lineWidth = 5
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      ctx.lineTo(points[1].x, points[1].y)
      ctx.stroke()
    }
    ctx.restore()
  }
  // Keep a stationary dot visible; a trail alone disappears when the phone is still.
  if (visible && performance.now() - lastPointAt < 2500) {
    const x = Math.max(8, Math.min(width - 8, (point[0] + 1) * width / 2))
    const y = Math.max(8, Math.min(height - 8, (point[1] + 1) * height / 2))
    ctx.save()
    ctx.fillStyle = `rgb(${color.join(',')})`
    ctx.shadowColor = ctx.fillStyle
    ctx.shadowBlur = 12
    ctx.beginPath()
    ctx.arc(x, y, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  if (points.length) {requestPaint()}
}

async function init() {
  const response = await fetch('/api/config', { cache: 'no-store' })
  if (!response.ok) {throw new Error('配置读取失败')}
  const config: { room: string; port: number; addresses: string[] } = await response.json()
  const hosts = config.addresses
  for (const address of hosts) {addresses.add(new Option(address, address))}
  if (hosts.includes(location.hostname)) {addresses.value = location.hostname}
  const updateQr = async () => {
    if (!addresses.value) {
      status.textContent = '未找到局域网 IPv4，请连接 Wi-Fi / 热点后重启。'
      return
    }
    const url = `https://${addresses.value}:${config.port}/client.html?id=${encodeURIComponent(config.room)}`
    link.href = url
    link.textContent = url
    qr.src = await QRCode.toDataURL(url, { margin: 2, width: 210, errorCorrectionLevel: 'M' })
  }
  addresses.addEventListener('change', () => { updateQr().catch(console.error) })
  await updateQr()
  document.querySelector('#copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link.href) } catch { link.focus() }
  })
  connectSocket('main', {
    room: config.room,
    onStatus: state => {
      status.textContent = state === 'connected' ? '局域网服务已连接，等待手机。' : '局域网服务连接中…'
      if (state !== 'connected') { visible = false; points = []; requestPaint() }
    },
    onMessage: message => {
      if (message.type === 'presence') {
        visible = false
        points = []
        status.textContent = message.connected ? '手机已连接，可触摸定位或在设置中启用陀螺仪。' : '等待手机扫码连接。'
        ;(document.querySelector('#sensorSummary') as HTMLElement).textContent = message.connected
          ? '手机已连接，等待本次传感器诊断。' : '等待手机连接并报告传感器状态。'
        ;(document.querySelector('#sensorDetails') as HTMLElement).textContent = ''
        requestPaint()
      } else if (message.type === 'point' && message.point) {
        point = message.point
        lastPointAt = performance.now()
        visible = true
        points.push({ x: (point[0] + 1) * canvas.clientWidth / 2, y: (point[1] + 1) * canvas.clientHeight / 2, time: Date.now() })
        if (points.length > 256) { points.splice(0, points.length - 256) }
        requestPaint()
      } else if (message.type === 'reset') {
        points = []; point = [0, 0]; visible = true; lastPointAt = performance.now(); requestPaint()
      } else if (message.type === 'color' && message.color) {
        color = message.color; requestPaint()
      } else if (message.type === 'page') {
        status.textContent = '翻页指令已收到。Canva 翻页需启动 Windows 叠加程序，并保持 Canva 为前台窗口。'
      } else if (message.type === 'diagnostic' && message.diagnostic) {
        const data = message.diagnostic
        const hz = (value: number | undefined) => typeof value === 'number' ? value.toFixed(0) : '?'
        const state = !data.running ? '传感器未启用 / 已暂停' : data.visible === false ? '已启用 · 后台停止发送' : '传感器已启用'
        const age = (value: number | null | undefined) => value === null ? '从未收到' : typeof value === 'number' ? `${(value / 1000).toFixed(1)} 秒前` : '旧版未报告'
        const flag = (value: boolean | null | undefined) => typeof value === 'boolean' ? value ? '是' : '否' : '未知'
        const history = (name: string, count: number | undefined, elapsed: number | null | undefined) => `${name}累计 ${count ?? '?'} 次，最后事件：${age(elapsed)}`
        const reportLabel = message.connected === false ? '上次诊断（手机已断开） · ' : ''
        ;(document.querySelector('#sensorSummary') as HTMLElement).textContent =
          `${reportLabel}${data.secure ? '安全上下文正常' : '手机 HTTPS 尚未受信任'} · ${state} · 方向 ${hz(data.orientationHz)} Hz / 绝对方向 ${hz(data.absoluteHz)} Hz / 运动 ${hz(data.motionHz)} Hz / 相对姿态 ${hz(data.relativeHz)} Hz · 来源 ${data.activeSource || '等待数据'}`
        ;(document.querySelector('#sensorDetails') as HTMLElement).textContent = [
          data.updatedAt ? `记录时间：${new Date(data.updatedAt).toLocaleString('zh-CN', { hour12: false })}` : '',
          `页面：${data.visible === undefined ? '旧版未报告' : data.visible ? '前台' : '后台'}；事件监听：${data.listenersAttached === undefined ? '旧版未报告' : data.listenersAttached ? '已注册' : '尚未启用'}`,
          `方向权限：${data.orientationPermission || '未知'}；运动权限：${data.motionPermission || '未知'}`,
          `相对姿态接口：${data.relativeStatus || '未知'}`,
          `焦点：${flag(data.focused)}；Relative 激活：${flag(data.relativeActivated)}；有读数：${flag(data.relativeHasReading)}；累计激活 ${data.relativeActivations ?? '?'} 次；时间戳 ${data.relativeTimestamp ?? '无'}`,
          `底层权限：${data.sensorPermissions || '旧版未报告'}`,
          `页面策略：${data.sensorPolicy || '旧版未报告'}`,
          `接口：${data.apiSupport || '旧版未报告'}`,
          `浏览器版本摘要：${data.browserInfo || '旧版未报告'}`,
          history('方向', data.orientationEvents, data.orientationAgeMs),
          history('absolute', data.absoluteEvents, data.absoluteAgeMs),
          history('Motion', data.motionEvents, data.motionAgeMs),
          history('Relative', data.relativeEvents, data.relativeAgeMs),
          `最近读数 α ${data.alpha ?? '无数据'} · β ${data.beta ?? '无数据'} · γ ${data.gamma ?? '无数据'}`,
          `最近重力 X ${data.gravityX ?? '无数据'} · Y ${data.gravityY ?? '无数据'} · Z ${data.gravityZ ?? '无数据'}`,
          data.reason || '',
        ].filter(Boolean).join('\n')
      }
    },
  })
}

window.addEventListener('resize', resize)
window.setInterval(requestPaint, 500)
resize()
init().catch(error => { status.textContent = `启动失败：${error.message}。请用 npm start 提供的 HTTPS 地址打开。` })
