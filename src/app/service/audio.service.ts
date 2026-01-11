import { Injectable } from '@angular/core';

export type SysSfxEvent =
  | 'APP_READY'
  | 'TOPIC_CHANGE'
  | 'NEW_TIP'
  | 'COPY'
  | 'SHARE'
  | 'ONLINE_PULSE'
  | 'SSE_UP'
  | 'SSE_DOWN'
  | 'STREAK_UP'
  | 'LEVEL_UP'
  | 'ERROR';

export type SysSfxHint = {
  sseAlive?: boolean;
  onlineNow?: number;
  mode?: 'NORMAL' | 'REDUCED' | 'REST' | 'FOCUS' | string;
  focusScore?: number;   // 0..1
  stressScore?: number;  // 0..1
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

@Injectable({ providedIn: 'root' })
export class AudioService {
  // UI
  state: 'ON' | 'OFF' | 'AUTO' = 'AUTO';
  showBanner = false;

  private ctx?: AudioContext;
  private master?: GainNode;
  private limiter?: DynamicsCompressorNode;

  private unlocked = false;
  private lastHint: SysSfxHint = { sseAlive: false, onlineNow: 0, mode: 'NORMAL', focusScore: 0.6, stressScore: 0.35 };

  /** Instala el gesto para desbloquear audio. */
  installAutoKick(onKick?: () => void | Promise<void>) {
    const kick = async () => {
      const ok = await this.boot();
      if (!ok) {
        this.showBanner = true;
        return;
      }
      this.showBanner = false;
      await onKick?.();
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
    };
    window.addEventListener('pointerdown', kick, { passive: true });
    window.addEventListener('keydown', kick);
  }

  async boot(): Promise<boolean> {
    if (this.unlocked && this.ctx) return true;

    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) return false;

    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    // master
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;

    // limiter suave
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -14;
    this.limiter.knee.value = 20;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.12;

    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    this.unlocked = true;
    return true;
  }

  destroy(): void {
    try { this.ctx?.close(); } catch {}
    this.ctx = undefined;
    this.master = undefined;
    this.limiter = undefined;
    this.unlocked = false;
  }

  setHint(h: SysSfxHint) {
    this.lastHint = {
      ...this.lastHint,
      ...h,
      focusScore: typeof h.focusScore === 'number' ? clamp01(h.focusScore) : this.lastHint.focusScore,
      stressScore: typeof h.stressScore === 'number' ? clamp01(h.stressScore) : this.lastHint.stressScore,
    };
  }

  toggle() {
    this.state = this.state === 'OFF' ? 'AUTO' : this.state === 'AUTO' ? 'ON' : 'OFF';
  }

  stop() {
    this.state = 'OFF';
  }

  /** Llamada única: reproduce un SFX corto para un evento del sistema */
  async sfx(ev: SysSfxEvent, meta?: { strength?: number }): Promise<void> {
    if (this.state === 'OFF') return;

    // AUTO: si no está desbloqueado, no intente sonar (evita spam/errores)
    if (this.state === 'AUTO' && !this.unlocked) return;

    const ok = await this.boot();
    if (!ok || !this.ctx || !this.master) return;

    const now = this.ctx.currentTime;
    const stress = clamp01(this.lastHint.stressScore ?? 0.35);
    const focus = clamp01(this.lastHint.focusScore ?? 0.6);

    // volumen base adaptativo: más estrés => menos agresivo
    const base = 0.16 + (1 - stress) * 0.08; // 0.16..0.24
    const strength = clamp01(meta?.strength ?? 0.8);
    const amp = base * (0.55 + 0.75 * strength) * (0.85 + 0.25 * focus);

    // router por evento
    switch (ev) {
      case 'APP_READY':      return this.beep(now, 440, 0.045, amp * 0.75, 'triangle');
      case 'TOPIC_CHANGE':   return this.chirp(now, 520, 780, 0.09, amp, 'sine');
      case 'NEW_TIP':        return this.doubleBeep(now, 660, 880, amp * 0.95);
      case 'COPY':           return this.tick(now, amp * 0.75);
      case 'SHARE':          return this.triple(now, 740, 920, 1100, amp);
      case 'ONLINE_PULSE':   return this.beep(now, 540, 0.03, amp * 0.45, 'sine');
      case 'SSE_UP':         return this.rise(now, 420, 980, 0.12, amp * 0.95);
      case 'SSE_DOWN':       return this.fall(now, 740, 260, 0.14, amp * 0.9);
      case 'STREAK_UP':      return this.rise(now, 520, 1240, 0.18, amp);
      case 'LEVEL_UP':       return this.sparkle(now, amp * 1.05);
      case 'ERROR':          return this.buzz(now, amp * 0.85);
    }
  }

  /* ===================== SFX primitives ===================== */

  private env(g: GainNode, t: number, dur: number, peak: number) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.02, dur));
  }

  private beep(t: number, hz: number, dur: number, amp: number, type: OscillatorType) {
    if (!this.ctx || !this.master) return Promise.resolve();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    this.env(g, t, dur, amp);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.03);
    return Promise.resolve();
  }

  private chirp(t: number, hz0: number, hz1: number, dur: number, amp: number, type: OscillatorType) {
    if (!this.ctx || !this.master) return Promise.resolve();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(hz0, t);
    o.frequency.exponentialRampToValueAtTime(hz1, t + dur);
    this.env(g, t, dur, amp);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.04);
    return Promise.resolve();
  }

  private doubleBeep(t: number, aHz: number, bHz: number, amp: number) {
    this.beep(t, aHz, 0.045, amp, 'triangle');
    return this.beep(t + 0.06, bHz, 0.05, amp * 0.95, 'triangle');
  }

  private triple(t: number, aHz: number, bHz: number, cHz: number, amp: number) {
    this.beep(t, aHz, 0.04, amp * 0.85, 'sine');
    this.beep(t + 0.055, bHz, 0.045, amp * 0.95, 'sine');
    return this.beep(t + 0.115, cHz, 0.055, amp, 'sine');
  }

  private rise(t: number, hz0: number, hz1: number, dur: number, amp: number) {
    return this.chirp(t, hz0, hz1, dur, amp, 'sine');
  }

  private fall(t: number, hz0: number, hz1: number, dur: number, amp: number) {
    return this.chirp(t, hz0, hz1, dur, amp, 'triangle');
  }

  private tick(t: number, amp: number) {
    // click suave con ruido filtrado
    if (!this.ctx || !this.master) return Promise.resolve();

    const len = Math.floor(this.ctx.sampleRate * 0.03);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const f = this.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.setValueAtTime(1200, t);

    const g = this.ctx.createGain();
    this.env(g, t, 0.03, amp * 0.8);

    src.connect(f);
    f.connect(g);
    g.connect(this.master);

    src.start(t);
    src.stop(t + 0.04);
    return Promise.resolve();
  }

  private sparkle(t: number, amp: number) {
    // 3 chirps rápidos tipo “nivel arriba”
    this.chirp(t, 700, 1200, 0.06, amp * 0.85, 'sine');
    this.chirp(t + 0.07, 900, 1600, 0.07, amp * 0.95, 'sine');
    return this.chirp(t + 0.155, 1200, 2200, 0.09, amp, 'sine');
  }

  private buzz(t: number, amp: number) {
    // error discreto: seno + square bajando
    if (!this.ctx || !this.master) return Promise.resolve();

    const o1 = this.ctx.createOscillator();
    const o2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    o1.type = 'sine';
    o2.type = 'square';

    o1.frequency.setValueAtTime(320, t);
    o2.frequency.setValueAtTime(160, t);

    o1.frequency.exponentialRampToValueAtTime(120, t + 0.12);
    o2.frequency.exponentialRampToValueAtTime(80, t + 0.12);

    this.env(g, t, 0.14, amp);

    o1.connect(g);
    o2.connect(g);
    g.connect(this.master);

    o1.start(t); o2.start(t);
    o1.stop(t + 0.18); o2.stop(t + 0.18);

    return Promise.resolve();
  }
}
