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
  focusScore?: number; // 0..1
  stressScore?: number; // 0..1
  audioIntensity?: number; // ✅ 0..1 (control global de intensidad/energía del audio)
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

@Injectable({ providedIn: 'root' })
export class AudioService {
  // Persistir en StorageService desde App (como ya haces)
  state: 'ON' | 'OFF' | 'AUTO' = 'AUTO';

  private ctx?: AudioContext;
  private master?: GainNode;
  private limiter?: DynamicsCompressorNode;

  private unlocked = false;
  private booting = false;

  private lastHint: SysSfxHint = {
    sseAlive: false,
    onlineNow: 0,
    mode: 'NORMAL',
    focusScore: 0.6,
    stressScore: 0.35,
  };

  // Notificación (toast) controlada por App
  private onBlocked?: (msg: string) => void;
  private lastBlockedToastAt = 0;

  // ✅ Nuevo: si se intentó usar audio sin gesto, marcamos “pendiente”
  private pendingUnlock = false;

  setBlockedHandler(fn?: (msg: string) => void) {
    this.onBlocked = fn;
  }

  setHint(h: SysSfxHint) {
    this.lastHint = {
      ...this.lastHint,
      ...h,
      focusScore:
        typeof h.focusScore === 'number' ? clamp01(h.focusScore) : this.lastHint.focusScore,
      stressScore:
        typeof h.stressScore === 'number' ? clamp01(h.stressScore) : this.lastHint.stressScore,
      audioIntensity:
        typeof h.audioIntensity === 'number'
          ? clamp01(h.audioIntensity)
          : this.lastHint.audioIntensity,
    };
  }

  toggle() {
    this.state = this.state === 'OFF' ? 'AUTO' : this.state === 'AUTO' ? 'ON' : 'OFF';
  }

  stop() {
    this.state = 'OFF';
  }

  /** ✅ App debe llamarlo SOLO desde gesto real: click/tap/keydown */
  async userKick(): Promise<boolean> {
    if (this.state === 'OFF') return false;

    const ok = await this.bootFromGesture();
    if (!ok) this.notifyBlocked();

    // Si se desbloqueó y estaba pendiente, limpiar bandera
    if (ok) this.pendingUnlock = false;

    return ok;
  }

  /** ✅ Para que App muestre un hint si el usuario nunca tocó la pantalla */
  needsUserGesture(): boolean {
    return this.state !== 'OFF' && !this.unlocked && this.pendingUnlock;
  }

  /** Boot SOLO cuando hay gesto real */
  private async bootFromGesture(): Promise<boolean> {
    if (this.unlocked && this.ctx?.state === 'running') return true;
    if (this.booting) return this.unlocked;

    this.booting = true;
    try {
      const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as
        | typeof AudioContext
        | undefined;

      if (!Ctx) {
        this.unlocked = false;
        return false;
      }

      if (!this.ctx) this.ctx = new Ctx();

      // Resume: solo funciona con gesto
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch {
          this.unlocked = false;
          return false;
        }
      }

      if (this.ctx.state !== 'running') {
        this.unlocked = false;
        return false;
      }

      if (!this.master) {
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.7;

        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -14;
        this.limiter.knee.value = 20;
        this.limiter.ratio.value = 8;
        this.limiter.attack.value = 0.003;
        this.limiter.release.value = 0.12;

        this.master.connect(this.limiter);
        this.limiter.connect(this.ctx.destination);
      }

      // ping inaudible (Safari/iOS)
      this.ping();

      this.unlocked = true;
      return true;
    } finally {
      this.booting = false;
    }
  }

  private notifyBlocked() {
    const now = Date.now();
    if (now - this.lastBlockedToastAt < 1600) return;
    this.lastBlockedToastAt = now;
    this.onBlocked?.('🔇 Audio bloqueado: toque/clic en la página para habilitar sonido.');
  }

  private ping() {
    if (!this.ctx || !this.master) return;
    const now = this.ctx.currentTime;

    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();

    o.type = 'sine';
    o.frequency.setValueAtTime(220, now);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.00012, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.03);

    o.connect(g);
    g.connect(this.master);

    o.start(now);
    o.stop(now + 0.035);
  }

  destroy(): void {
    try {
      this.ctx?.close();
    } catch {}
    this.ctx = undefined;
    this.master = undefined;
    this.limiter = undefined;
    this.unlocked = false;
    this.booting = false;
    this.onBlocked = undefined;
    this.pendingUnlock = false;
  }

  /**
   * ✅ SFX sin romper:
   * - OFF: nada
   * - AUTO: si no está desbloqueado, no intenta boot; solo marca pending + toast (controlado)
   * - ON: si no está desbloqueado, también exige gesto (pending)
   */
  async sfx(ev: SysSfxEvent, meta?: { strength?: number }): Promise<void> {
    if (this.state === 'OFF') return;

    // No hay unlock => NO intente crear/resumir aquí (evita warning del navegador)
    if (!this.unlocked || this.ctx?.state !== 'running') {
      this.pendingUnlock = true;

      // AUTO: no insistir; ON: igual requiere gesto
      this.notifyBlocked();
      return;
    }

    if (!this.ctx || !this.master) return;

    const now = this.ctx.currentTime;
    const stress = clamp01(this.lastHint.stressScore ?? 0.35);
    const focus = clamp01(this.lastHint.focusScore ?? 0.6);

    const base = 0.16 + (1 - stress) * 0.08; // 0.16..0.24
    const strength = clamp01(meta?.strength ?? 0.8);
    const amp = base * (0.55 + 0.75 * strength) * (0.85 + 0.25 * focus);

    switch (ev) {
      case 'APP_READY':
        return this.beep(now, 440, 0.045, amp * 0.75, 'triangle');
      case 'TOPIC_CHANGE':
        return this.chirp(now, 520, 780, 0.09, amp, 'sine');
      case 'NEW_TIP':
        return this.doubleBeep(now, 660, 880, amp * 0.95);
      case 'COPY':
        return this.tick(now, amp * 0.75);
      case 'SHARE':
        return this.triple(now, 740, 920, 1100, amp);
      case 'ONLINE_PULSE':
        return this.beep(now, 540, 0.03, amp * 0.45, 'sine');
      case 'SSE_UP':
        return this.rise(now, 420, 980, 0.12, amp * 0.95);
      case 'SSE_DOWN':
        return this.fall(now, 740, 260, 0.14, amp * 0.9);
      case 'STREAK_UP':
        return this.rise(now, 520, 1240, 0.18, amp);
      case 'LEVEL_UP':
        return this.sparkle(now, amp * 1.05);
      case 'ERROR':
        return this.buzz(now, amp * 0.85);
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

  private chirp(
    t: number,
    hz0: number,
    hz1: number,
    dur: number,
    amp: number,
    type: OscillatorType
  ) {
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
    this.chirp(t, 700, 1200, 0.06, amp * 0.85, 'sine');
    this.chirp(t + 0.07, 900, 1600, 0.07, amp * 0.95, 'sine');
    return this.chirp(t + 0.155, 1200, 2200, 0.09, amp, 'sine');
  }

  private buzz(t: number, amp: number) {
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

    o1.start(t);
    o2.start(t);
    o1.stop(t + 0.18);
    o2.stop(t + 0.18);

    return Promise.resolve();
  }
}
