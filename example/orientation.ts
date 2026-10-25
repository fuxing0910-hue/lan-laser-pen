export type OrientationMode = 'pointer' | 'tilt'
export type Point = [number, number]
export type Vector = [number, number, number]

export interface OrientationSample {
  alpha: number | null
  beta: number | null
  gamma: number | null
}

export function isFiniteAngle(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isValidSample(sample: OrientationSample, mode: OrientationMode): boolean {
  return isFiniteAngle(sample.beta) && isFiniteAngle(sample.gamma) && (mode === 'tilt' || isFiniteAngle(sample.alpha))
}

export interface GravitySample {
  x: number | null
  y: number | null
  z: number | null
}

export function gravityOrientation(gravity: GravitySample | null): OrientationSample | null {
  if (!gravity || !isFiniteAngle(gravity.x) || !isFiniteAngle(gravity.y) || !isFiniteAngle(gravity.z)) {
    return null
  }
  const { x, y, z } = gravity
  const length = Math.sqrt(x * x + y * y + z * z)
  // A zero vector is not a direction. Reject free fall and extreme acceleration.
  if (length < 2 || length > 20) {
    return null
  }
  return {
    alpha: null,
    beta: (Math.atan2(y, Math.sqrt(x * x + z * z)) * 180) / Math.PI,
    gamma: (Math.atan2(-x, z) * 180) / Math.PI,
  }
}

export function quaternionOrientation(quaternion: ArrayLike<number> | null): OrientationSample | null {
  if (!quaternion || quaternion.length !== 4) {
    return null
  }
  const values = [quaternion[0], quaternion[1], quaternion[2], quaternion[3]]
  if (!values.every((value) => isFiniteAngle(value))) {
    return null
  }
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
  if (length < 0.000001) {
    return null
  }
  const [x, y, z, w] = values.map((value) => value / length)
  const r21 = Math.max(-1, Math.min(1, 2 * (y * z + w * x)))
  const beta = Math.asin(r21)
  // Convert the quaternion to the same Z-X'-Y'' convention as orientation events.
  const singular = Math.abs(r21) > 0.999999
  const alpha = singular
    ? Math.atan2(2 * (x * y + w * z), 1 - 2 * (y * y + z * z))
    : Math.atan2(-2 * (x * y - w * z), 1 - 2 * (x * x + z * z))
  const gamma = singular ? 0 : Math.atan2(-2 * (x * z - w * y), 1 - 2 * (x * x + y * y))
  const degrees = 180 / Math.PI
  return { alpha: alpha * degrees, beta: beta * degrees, gamma: gamma * degrees }
}

export function shortestAngle(value: number, reference: number): number {
  return ((((value - reference) % 360) + 540) % 360) - 180
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// DeviceOrientation uses intrinsic Z-X'-Y'' rotations in the natural device frame.
export function rotateVector(sample: OrientationSample, vector: Vector): Vector {
  if (!isValidSample(sample, 'pointer')) {
    throw new Error('A full orientation sample requires three finite angles.')
  }
  const radians = Math.PI / 180
  const a = (sample.alpha as number) * radians
  const b = (sample.beta as number) * radians
  const g = (sample.gamma as number) * radians
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const cb = Math.cos(b)
  const sb = Math.sin(b)
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const x = cg * vector[0] + sg * vector[2]
  const y = vector[1]
  const z = -sg * vector[0] + cg * vector[2]
  const tiltedY = cb * y - sb * z
  const tiltedZ = sb * y + cb * z
  return [ca * x - sa * tiltedY, sa * x + ca * tiltedY, tiltedZ]
}

export interface ReferenceFrame {
  sample: OrientationSample
  forward: Vector
  right: Vector
  up: Vector
}

export function createReference(sample: OrientationSample, screenAngle: number): ReferenceFrame {
  const angle = (screenAngle * Math.PI) / 180
  return {
    sample: { ...sample },
    forward: rotateVector(sample, [Math.sin(angle), Math.cos(angle), 0]),
    right: rotateVector(sample, [Math.cos(angle), -Math.sin(angle), 0]),
    up: rotateVector(sample, [0, 0, 1]),
  }
}

export function pointerAngles(sample: OrientationSample, reference: ReferenceFrame, screenAngle: number): Point {
  const angle = (screenAngle * Math.PI) / 180
  const forward = rotateVector(sample, [Math.sin(angle), Math.cos(angle), 0])
  // Keep the point at an edge if the phone points behind the calibrated plane.
  const depth = Math.max(0.001, dot(forward, reference.forward))
  return [
    (Math.atan2(dot(forward, reference.right), depth) * 180) / Math.PI,
    (-Math.atan2(dot(forward, reference.up), depth) * 180) / Math.PI,
  ]
}

export function tiltAngles(sample: OrientationSample, reference: OrientationSample, screenAngle: number): Point {
  if (!isValidSample(sample, 'tilt') || !isValidSample(reference, 'tilt')) {
    throw new Error('Tilt mode requires finite beta and gamma.')
  }
  const x = shortestAngle(sample.gamma as number, reference.gamma as number)
  const y = shortestAngle(sample.beta as number, reference.beta as number)
  const angle = (screenAngle * Math.PI) / 180
  return [x * Math.cos(angle) + y * Math.sin(angle), -x * Math.sin(angle) + y * Math.cos(angle)]
}

export class LowPassFilter {
  private value: Point = [0, 0]
  private previousTime: number | null = null

  public reset(): void {
    this.value = [0, 0]
    this.previousTime = null
  }

  public update(target: Point, now: number, timeConstantMs = 80): Point {
    const elapsed = this.previousTime === null ? 16 : clamp(now - this.previousTime, 0, 1000)
    this.previousTime = now
    // An exponential coefficient keeps the cutoff independent of event rate.
    const weight = 1 - Math.exp(-elapsed / timeConstantMs)
    this.value = [
      this.value[0] + weight * (target[0] - this.value[0]),
      this.value[1] + weight * (target[1] - this.value[1]),
    ]
    return [this.value[0], this.value[1]]
  }
}

export function normalizedPoint(angles: Point, sensitivity: number, reverseX: boolean, reverseY: boolean): Point {
  // This continuous dead zone suppresses tiny jitter without a jump at its edge.
  const normalize = (value: number): number =>
    clamp((Math.sign(value) * Math.max(0, Math.abs(value) - 0.1) * sensitivity) / 25, -1, 1)
  return [normalize(angles[0]) * (reverseX ? -1 : 1), normalize(angles[1]) * (reverseY ? -1 : 1)]
}
