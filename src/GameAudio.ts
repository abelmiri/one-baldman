import type { Vector3Like } from 'three'

type Loop = { gain: GainNode; filter: BiquadFilterNode; tone: OscillatorNode }
type Voice = { sources: AudioScheduledSourceNode[]; nodes: AudioNode[] }
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

/** Procedural effects: no downloads, and no audio context before a user gesture. */
export class GameAudio {
  private context?: AudioContext
  private master?: GainNode
  private compressor?: DynamicsCompressorNode
  private noise?: AudioBuffer
  private laser?: Loop
  private flight?: Loop
  private loopSources: AudioScheduledSourceNode[] = []
  private voices = new Set<Voice>()
  private active = false
  private muted = false
  private disposed = false
  private lastImpact = -Infinity
  private lastDebris = -Infinity

  constructor() {
    window.addEventListener('pointerdown', this.unlock, true)
    window.addEventListener('keydown', this.unlock, true)
  }

  private unlock = () => {
    if (this.disposed || this.muted) return
    if (!this.context) {
      try {
        const context = new AudioContext({ latencyHint: 'interactive' })
        this.context = context
        this.master = context.createGain()
        this.master.gain.value = .65
        this.compressor = context.createDynamicsCompressor()
        this.compressor.threshold.value = -15
        this.compressor.ratio.value = 5
        this.master.connect(this.compressor).connect(context.destination)
        this.noise = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
        const samples = this.noise.getChannelData(0)
        for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
        this.laser = this.createLoop('sawtooth', 110, 'bandpass', 1500, .055)
        this.flight = this.createLoop('sine', 42, 'lowpass', 400, .1)
      } catch {
        // Audio support/device failures must never prevent gameplay.
        this.releaseGraph()
        return
      }
    }
    if (this.context?.state !== 'running') void this.context?.resume().catch(() => {})
  }

  private createLoop(type: OscillatorType, frequency: number, filterType: BiquadFilterType, cutoff: number, toneLevel: number): Loop {
    const context = this.context!
    const gain = context.createGain()
    gain.gain.value = 0
    gain.connect(this.master!)
    const filter = context.createBiquadFilter()
    filter.type = filterType
    filter.frequency.value = cutoff
    filter.Q.value = .7
    filter.connect(gain)
    const noise = context.createBufferSource()
    noise.buffer = this.noise!
    noise.loop = true
    noise.connect(filter)
    const tone = context.createOscillator()
    tone.type = type
    tone.frequency.value = frequency
    const mix = context.createGain()
    mix.gain.value = toneLevel
    tone.connect(mix).connect(gain)
    noise.start()
    tone.start()
    this.loopSources.push(noise, tone)
    return { gain, filter, tone }
  }

  update(playing: boolean, laser: boolean, hitting: boolean, airborne: boolean, speed: number) {
    this.active = playing
    const context = this.context
    if (!context || !this.laser || !this.flight) return
    if (!playing || this.muted) { this.stop(); return }
    const now = context.currentTime
    const travel = clamp(speed / 110)
    this.laser.gain.gain.setTargetAtTime(laser ? (hitting ? .28 : .19) : 0, now, .035)
    this.laser.filter.frequency.setTargetAtTime(hitting ? 2300 : 1500, now, .06)
    this.laser.tone.frequency.setTargetAtTime(hitting ? 138 : 110, now, .04)
    this.flight.gain.gain.setTargetAtTime(airborne ? .07 + travel * .65 : 0, now, .12)
    this.flight.filter.frequency.setTargetAtTime(350 + travel * 2300, now, .15)
    this.flight.tone.frequency.setTargetAtTime(42 + travel * 50, now, .15)
  }

  /** Relative speed selects a soft landing thud or a heavy crash with debris. */
  impact(point: Vector3Like, speed: number, listener: Vector3Like, right: Vector3Like, debris = false) {
    const context = this.context
    if (!context || context.state !== 'running' || !this.active || this.muted || speed < 1.4) return
    const now = context.currentTime
    if (now - (debris ? this.lastDebris : this.lastImpact) < (debris ? .12 : .085) || this.voices.size >= 10) return
    const dx = point.x - listener.x, dy = point.y - listener.y, dz = point.z - listener.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance > 160) return
    if (debris) this.lastDebris = now
    else this.lastImpact = now
    const power = clamp(speed / 35)
    const heavy = !debris && speed >= 12
    const duration = debris ? .32 : heavy ? .65 : .22
    const level = (debris ? .28 : .18 + power * .5) / (1 + distance / 24)
    const output = context.createGain()
    output.gain.setValueAtTime(0, now)
    output.gain.linearRampToValueAtTime(level, now + .004)
    output.gain.exponentialRampToValueAtTime(.0001, now + duration)
    const pan = context.createStereoPanner()
    pan.pan.value = clamp((dx * right.x + dy * right.y + dz * right.z) / Math.max(distance, 1), -.85, .85)
    output.connect(pan).connect(this.master!)

    const noise = context.createBufferSource()
    noise.buffer = this.noise!
    noise.playbackRate.value = .75 + Math.random() * .5
    const filter = context.createBiquadFilter()
    filter.type = debris ? 'bandpass' : 'lowpass'
    filter.frequency.value = debris ? 1800 : heavy ? 1600 : 650
    filter.Q.value = .65
    noise.connect(filter).connect(output)
    const thump = context.createOscillator()
    thump.frequency.setValueAtTime((heavy ? 130 : 95) + Math.random() * 20, now)
    thump.frequency.exponentialRampToValueAtTime(heavy ? 28 : 45, now + duration)
    const bass = context.createGain()
    bass.gain.value = debris ? .12 : .65
    thump.connect(bass).connect(output)
    const voice: Voice = { sources: [noise, thump], nodes: [noise, filter, thump, bass, output, pan] }
    this.voices.add(voice)
    noise.onended = () => {
      voice.nodes.forEach(node => node.disconnect())
      this.voices.delete(voice)
    }
    noise.start(now, Math.random() * .8)
    thump.start(now)
    noise.stop(now + duration)
    thump.stop(now + duration)
  }

  setMuted(muted: boolean) {
    const wasMuted = this.muted
    this.muted = muted
    if (muted) this.stop()
    else if (wasMuted) this.unlock()
  }

  stop() {
    const context = this.context
    if (!context) return
    for (const loop of [this.laser, this.flight]) {
      if (!loop) continue
      loop.gain.gain.cancelScheduledValues(context.currentTime)
      loop.gain.gain.setValueAtTime(0, context.currentTime)
    }
    for (const voice of this.voices) {
      voice.sources.forEach(source => { source.onended = null; source.stop() })
      voice.nodes.forEach(node => node.disconnect())
    }
    this.voices.clear()
    this.lastImpact = this.lastDebris = -Infinity
    this.active = false
  }

  private releaseGraph() {
    this.stop()
    this.loopSources.forEach(source => { source.stop(); source.disconnect() })
    this.loopSources.length = 0
    this.master?.disconnect()
    this.compressor?.disconnect()
    if (this.context) void this.context.close().catch(() => {})
    this.context = undefined
    this.master = undefined
    this.compressor = undefined
    this.noise = undefined
    this.laser = this.flight = undefined
  }

  dispose() {
    this.disposed = true
    window.removeEventListener('pointerdown', this.unlock, true)
    window.removeEventListener('keydown', this.unlock, true)
    this.releaseGraph()
  }
}
