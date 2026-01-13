// src/app/service/connectivity.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type NetState = 'ONLINE' | 'DEGRADED' | 'OFFLINE';

@Injectable({ providedIn: 'root' })
export class ConnectivityService {
  private readonly _state$ = new BehaviorSubject<NetState>('ONLINE');
  readonly state$ = this._state$.asObservable();

  private failStreak = 0;
  private lastOkAt = Date.now();
  private lastFailAt = 0;

  private readonly OFFLINE_AFTER_MS = 25_000;
  private readonly FAIL_DECAY_WINDOW_MS = 8_000;

  constructor() {
    try {
      window.addEventListener('online', () => this.reportOk());
      window.addEventListener('offline', () => this.forceOffline('BROWSER_OFFLINE'));

      const c: any = (navigator as any)?.connection;
      (this as any)._conn = c;

      const onChange = () => {
        const effectiveType = String(c?.effectiveType || '').toLowerCase();
        const saveData = !!c?.saveData;
        if (saveData || effectiveType.includes('2g') || effectiveType.includes('slow-2g')) {
          if (this._state$.value === 'ONLINE') this._state$.next('DEGRADED');
        }
      };

      if (c?.addEventListener) c.addEventListener('change', onChange);
      else if (typeof c?.onchange !== 'undefined') c.onchange = onChange;
    } catch {}
  }

  get snapshot(): NetState {
    return this._state$.value;
  }

  reportOk(_latencyMs?: number): void {
    this.lastOkAt = Date.now();
    this.failStreak = 0;
    if (this._state$.value !== 'ONLINE') this._state$.next('ONLINE');
  }

  reportFail(_statusOrError?: any): void {
    const now = Date.now();

    const prevFail = this.lastFailAt;
    this.lastFailAt = now;

    if (prevFail > 0 && (now - prevFail) > this.FAIL_DECAY_WINDOW_MS) {
      this.failStreak = Math.max(0, this.failStreak - 1);
    }
    this.failStreak = Math.min(50, this.failStreak + 1);

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.forceOffline('NAV_OFFLINE');
      return;
    }

    const sinceOk = now - this.lastOkAt;
    const next: NetState =
      sinceOk >= this.OFFLINE_AFTER_MS || this.failStreak >= 6 ? 'OFFLINE' : 'DEGRADED';

    if (this._state$.value !== next) this._state$.next(next);
  }

  private forceOffline(_reason?: string) {
    this.lastFailAt = Date.now();
    this.failStreak = Math.max(this.failStreak, 7);
    if (this._state$.value !== 'OFFLINE') this._state$.next('OFFLINE');
  }

  nextBackoffMs(base = 350, cap = 30_000): number {
    const exp = Math.min(9, this.failStreak);
    const raw = Math.min(cap, base * Math.pow(2, exp));
    const jitter = 0.65 + Math.random() * 0.75;
    return Math.round(raw * jitter);
  }

  /** En OFFLINE pause todo lo pesado; en DEGRADED siga, pero con menos agresividad (lo decide el caller). */
  shouldPauseHeavyWork(): boolean {
    return this.snapshot === 'OFFLINE';
  }

  /** Útil para “adaptar frecuencia” en DEGRADED. */
  isDegraded(): boolean {
    return this.snapshot === 'DEGRADED';
  }
}
