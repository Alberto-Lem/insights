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

  get snapshot(): NetState {
    return this._state$.value;
  }

  reportOk(latencyMs?: number): void {
    this.lastOkAt = Date.now();
    this.failStreak = 0;

    // si venías de OFFLINE/DEGRADED, vuelve a ONLINE
    if (this._state$.value !== 'ONLINE') this._state$.next('ONLINE');
  }

  reportFail(statusOrError?: any): void {
    this.lastFailAt = Date.now();
    this.failStreak = Math.min(50, this.failStreak + 1);

    // reglas simples: 1-2 fallos => DEGRADED, muchos fallos => OFFLINE
    const next: NetState = this.failStreak >= 4 ? 'OFFLINE' : 'DEGRADED';
    if (this._state$.value !== next) this._state$.next(next);
  }

  /** Backoff recomendado para SSE / reintentos controlados */
  nextBackoffMs(base = 250, cap = 30_000): number {
    const exp = Math.min(8, this.failStreak); // 2^0..2^8
    const raw = Math.min(cap, base * Math.pow(2, exp));
    const jitter = 0.6 + Math.random() * 0.8; // 0.6..1.4
    return Math.round(raw * jitter);
  }

  /** Útil para pausar “insights/me/online” cuando el backend está mal */
  shouldPauseHeavyWork(): boolean {
    return this.snapshot === 'OFFLINE';
  }
}
