// src/app/service/sse.service.ts
import { Injectable, NgZone, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { VisitsApiService } from './visits-api.service';
import { StorageService } from './storage.service';
import { ConnectivityService } from './connectivity.service';

type StreamMsg = { type?: string; onlineNow?: number; [k: string]: any };

@Injectable({ providedIn: 'root' })
export class SseService {
  private zone = inject(NgZone);
  private api = inject(VisitsApiService);
  private storage = inject(StorageService);
  private net = inject(ConnectivityService);

  private es?: EventSource;
  private stopFlag = false;
  private reconnectTimer: any = null;

  private readonly _alive$ = new BehaviorSubject<boolean>(false);
  readonly alive$ = this._alive$.asObservable();

  private readonly _onlineNow$ = new BehaviorSubject<number>(0);
  readonly onlineNow$ = this._onlineNow$.asObservable();

  /** Inicia SSE y reconecta con backoff si el backend reinicia o se satura. */
  start(pageKey: string): void {
    this.stopFlag = false;
    this.connect(pageKey);
  }

  stop(): void {
    this.stopFlag = true;
    this._alive$.next(false);
    this.clearTimers();
    try { this.es?.close(); } catch {}
    this.es = undefined;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(pageKey: string): void {
    if (this.stopFlag) return;

    const visitorId = this.storage.getVisitorId();
    const url = this.api.endpoints(pageKey, visitorId).stream;

    this.zone.runOutsideAngular(() => {
      try { this.es?.close(); } catch {}
      this.es = this.api.openSse(url);

      this.es.onopen = () => {
        this.net.reportOk();
        this.zone.run(() => this._alive$.next(true));
      };

      // Mensaje genérico (si tu backend manda JSON en `data`)
      this.es.onmessage = (ev) => {
        if (!ev?.data) return;
        let msg: StreamMsg | null = null;
        try { msg = JSON.parse(ev.data) as StreamMsg; } catch { msg = null; }
        if (!msg) return;

        // Actualiza onlineNow si viene
        if (typeof msg.onlineNow === 'number') {
          // evita renders excesivos: solo actualiza si cambia
          const cur = this._onlineNow$.value;
          if (cur !== msg.onlineNow) this.zone.run(() => this._onlineNow$.next(msg!.onlineNow!));
        }
      };

      this.es.onerror = () => {
        this.net.reportFail('SSE_ERROR');
        this.zone.run(() => this._alive$.next(false));

        try { this.es?.close(); } catch {}
        this.es = undefined;

        // backoff + jitter para no martillar al backend
        const wait = this.net.nextBackoffMs(350, 30_000);
        this.clearTimers();
        this.reconnectTimer = setTimeout(() => this.connect(pageKey), wait);
      };
    });
  }
}
