// src/app/service/audio.service.ts
import { Injectable } from '@angular/core';
import { AudioEngine, AudioContextHint, UserSignal } from '../audio/audio-engine';
import { AudioProfile } from '../audio/types-adio';

export type MusicState = 'AUTO' | 'ON' | 'OFF';

@Injectable({ providedIn: 'root' })
export class AudioService {
  private engine = new AudioEngine();

  private _state: MusicState = 'AUTO';
  private _banner = false;

  private lastProfile: AudioProfile = 'bienestar';
  private lastHint: AudioContextHint = { mode: 'NORMAL', sseAlive: true, onlineNow: 0 };

  /** UI: estado actual */
  get state(): MusicState { return this._state; }

  /** UI: mostrar banner si el navegador bloqueó */
  get showBanner(): boolean { return this._banner; }

  /** Útil para debug */
  get contextState(): AudioContextState | 'none' {
    return this.engine.contextState;
  }

  async init(): Promise<boolean> {
    return this.engine.init();
  }

  /**
   * Inicia audio de forma segura:
   * - intenta resumeContext
   * - valida que exista salida (RMS > umbral) en una ventana corta
   * Si falla, deja AUTO + banner para que el usuario presione “Habilitar”.
   */
  async start(profile: AudioProfile, hint?: AudioContextHint, meta?: { userIntent?: boolean }): Promise<boolean> {
    if (this._state === 'OFF' && !meta?.userIntent) return false;

    this.lastProfile = profile;
    if (hint) this.lastHint = { ...this.lastHint, ...hint };

    const ok = await this.engine.start(profile, this.lastHint);
    if (!ok) {
      this._state = 'AUTO';
      this._banner = true;
      return false;
    }

    // ✅ Verificación real: si no hay RMS, considérelo “bloqueado o mudo”
    const audible = await this.waitForAudible(650, 0.003);
    if (!audible) {
      this._state = 'AUTO';
      this._banner = true;
      this.engine.stop();
      return false;
    }

    this._state = 'ON';
    this._banner = false;
    return true;
  }

  stop(): void {
    this.engine.stop();
    this._state = 'OFF';
    this._banner = false;
  }

  toggle(profile: AudioProfile, hint?: AudioContextHint): Promise<boolean> | void {
    if (this._state === 'ON') return this.stop();
    return this.start(profile, hint, { userIntent: true });
  }

  /** Ajusta perfil sin forzar “play” */
  setProfile(profile: AudioProfile, hint?: AudioContextHint): void {
    this.lastProfile = profile;
    if (hint) this.lastHint = { ...this.lastHint, ...hint };

    this.engine.setProfile(profile, this.lastHint);
  }

  /** Ajusta hint sin forzar “play” */
  setContextHint(hint: AudioContextHint): void {
    this.lastHint = { ...this.lastHint, ...hint };
    this.engine.setContextHint(this.lastHint);
  }

  /** Señales (likes, views, etc.) */
  signal(s: UserSignal): void {
    this.engine.onUserSignal(s);
  }

  /** “Color” de seed sin interpretarlo como TIP_VIEW */
  tipChanged(seedKey: string): void {
    this.engine.onTipChanged(seedKey);
  }

  /** Instala auto-kick: primer gesto intenta arrancar si está en AUTO */
  installAutoKick(getProfile: () => AudioProfile, getHint: () => AudioContextHint): void {
    const kick = () => {
      if (this._state === 'AUTO') void this.start(getProfile(), getHint(), { userIntent: true });
      window.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
    };
    window.addEventListener('pointerdown', kick, { passive: true });
    window.addEventListener('keydown', kick);
  }

  async destroy(): Promise<void> {
    await this.engine.destroy();
  }

  private waitForAudible(ms: number, threshold: number): Promise<boolean> {
    const start = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const rms = this.engine.readRms();
        if (rms >= threshold) return resolve(true);
        if (performance.now() - start >= ms) return resolve(false);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }
}
