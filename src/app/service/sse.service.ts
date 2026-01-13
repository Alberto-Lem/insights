// src/app/service/sse.service.ts
import { Injectable, NgZone, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { VisitsApiService } from './visits-api.service';
import { StorageService } from './storage.service';
import { ConnectivityService } from './connectivity.service';
import type { VisitInsightsResponse, VisitProfileResponse } from '../models/models';

type StreamMsg = { type?: string; visitorId?: string; [k: string]: any };

type DecisionMode = 'NORMAL' | 'REDUCED' | 'REST' | 'FOCUS';
export type VisitDecisionResponse = {
  mode: DecisionMode;
  maxTipsAllowed: number;
  allowShare: boolean;
  allowNewTip: boolean;
  systemMessage: string;
};

@Injectable({ providedIn: 'root' })
export class SseService {
  private zone = inject(NgZone);
  private api = inject(VisitsApiService);
  private storage = inject(StorageService);
  private net = inject(ConnectivityService);

  private es?: EventSource;
  private stopFlag = false;
  private reconnectTimer: any = null;
  private pollTimer: any = null;

  private pageKey = 'visits';

  private readonly _alive$ = new BehaviorSubject<boolean>(false);
  readonly alive$ = this._alive$.asObservable();

  private readonly _onlineNow$ = new BehaviorSubject<number>(0);
  readonly onlineNow$ = this._onlineNow$.asObservable();

  private readonly _profile$ = new BehaviorSubject<VisitProfileResponse | null>(null);
  readonly profile$ = this._profile$.asObservable();

  private readonly _insights$ = new BehaviorSubject<(VisitInsightsResponse & { _ts?: number }) | null>(null);
  readonly insights$ = this._insights$.asObservable();

  private readonly _decision$ = new BehaviorSubject<VisitDecisionResponse | null>(null);
  readonly decision$ = this._decision$.asObservable();

  private readonly _total$ = new BehaviorSubject<number | null>(null);
  readonly total$ = this._total$.asObservable();

  private isSignedVid(v: string): boolean {
    const s = String(v || '').trim();
    return !!s && s.includes('.') && s.length > 20;
  }

  start(pageKey: string): void {
    this.pageKey = String(pageKey || 'visits').trim() || 'visits';
    this.stopFlag = false;
    this.startPollingOnline(this.pageKey);
    this.connect(this.pageKey);
  }

  stop(): void {
    this.stopFlag = true;
    this._alive$.next(false);
    this.clearTimers();
    this.detach();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private detach(): void {
    try { this.es?.close(); } catch {}
    this.es = undefined;
  }

  private applyVisitorIdIfPresent(msg: any) {
    const vid = String(msg?.visitorId || '').trim();
    if (this.isSignedVid(vid)) this.storage.setVisitorId(vid, this.pageKey);
  }

  private startPollingOnline(pageKey: string): void {
    const onlineUrl = this.api.endpoints(pageKey).online;

    const tick = async () => {
      if (this.stopFlag) return;
      if (this.net.shouldPauseHeavyWork()) return;

      const vid = this.storage.getVisitorId(pageKey);
      if (!this.isSignedVid(vid)) return;

      const res = await this.api.apiFetch<{ online: number }>(
        onlineUrl,
        vid,
        { method: 'GET' },
        { timeoutMs: 4500, dedupe: true, cacheTtlMs: 9000, allowStaleOnError: true }
      );

      if (!res || res.status === 0) return;

      if (res.visitorId && this.isSignedVid(res.visitorId)) {
        this.storage.setVisitorId(res.visitorId, pageKey);
      }

      const online = Number((res.data as any)?.online ?? NaN);
      if (!Number.isFinite(online)) return;

      if (this._onlineNow$.value !== online) {
        this.zone.run(() => this._onlineNow$.next(online));
      }
    };

    this.pollTimer = setInterval(() => void tick(), 12_000);
    void tick();
  }

  private connect(pageKey: string): void {
    if (this.stopFlag) return;
    if (this.net.shouldPauseHeavyWork()) return;

    const vid = this.storage.getVisitorId(pageKey);

    // ✅ si no hay token firmado, no intente SSE (evita 401 infinito)
    if (!this.isSignedVid(vid)) {
      this.zone.run(() => this._alive$.next(false));
      return;
    }

    const url = this.api.sseUrl(pageKey, vid);
    if (!url) return;

    this.zone.runOutsideAngular(() => {
      this.detach();
      this.es = this.api.openSse(url);

      this.es.onopen = () => {
        this.net.reportOk();
        this.zone.run(() => this._alive$.next(true));
      };

      // ✅ IMPORTANTE: escuchar eventos nombrados según backend
      this.es.addEventListener('hello', (ev: any) => this.onNamed('hello', ev));
      this.es.addEventListener('online', (ev: any) => this.onNamed('online', ev));
      this.es.addEventListener('total', (ev: any) => this.onNamed('total', ev));
      this.es.addEventListener('profile', (ev: any) => this.onNamed('profile', ev));
      this.es.addEventListener('insights', (ev: any) => this.onNamed('insights', ev));
      this.es.addEventListener('decision', (ev: any) => this.onNamed('decision', ev));

      // fallback: si el server manda default message
      this.es.onmessage = (ev) => {
        this.onRawMessage(ev);
      };

      this.es.onerror = () => {
        this.net.reportFail('SSE_ERROR');
        this.zone.run(() => this._alive$.next(false));
        this.detach();

        const latest = this.storage.getVisitorId(pageKey);
        if (!this.isSignedVid(latest)) return;

        const wait = this.net.nextBackoffMs(650, 30_000);
        if (this.reconnectTimer) return;

        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect(pageKey);
        }, wait);
      };
    });
  }

  private parse(ev: any): StreamMsg | null {
    const txt = String(ev?.data || '').trim();
    if (!txt) return null;
    try {
      return JSON.parse(txt) as StreamMsg;
    } catch {
      return null;
    }
  }

  private onRawMessage(ev: any) {
    if (this.stopFlag) return;
    const msg = this.parse(ev);
    if (!msg) return;
    this.applyVisitorIdIfPresent(msg);

    // si llega online por default
    const online = typeof (msg as any).onlineNow === 'number'
      ? Number((msg as any).onlineNow)
      : (typeof (msg as any).online === 'number' ? Number((msg as any).online) : NaN);

    if (Number.isFinite(online) && this._onlineNow$.value !== online) {
      this.zone.run(() => this._onlineNow$.next(online));
    }
  }

  private onNamed(kind: string, ev: any) {
    if (this.stopFlag) return;

    const msg = this.parse(ev);
    if (!msg) return;

    this.applyVisitorIdIfPresent(msg);
    this.net.reportOk();

    if (kind === 'online') {
      const online = Number((msg as any)?.onlineNow ?? (msg as any)?.online ?? NaN);
      if (Number.isFinite(online) && this._onlineNow$.value !== online) {
        this.zone.run(() => this._onlineNow$.next(online));
      }
      return;
    }

    if (kind === 'total') {
      const total = Number((msg as any)?.totalTodayUnique ?? (msg as any)?.total ?? NaN);
      if (Number.isFinite(total)) this.zone.run(() => this._total$.next(total));
      return;
    }

    if (kind === 'profile') {
      const p = (msg as any) as VisitProfileResponse;
      if (p && typeof (p as any).xp === 'number') {
        this.zone.run(() => this._profile$.next(p));
      }
      return;
    }

    if (kind === 'insights') {
      const ins = (msg as any) as VisitInsightsResponse;
      if (ins && typeof (ins as any).activeDaysLast7 === 'number') {
        this.zone.run(() => this._insights$.next({ ...(ins as any), _ts: Date.now() }));
      }
      return;
    }

    if (kind === 'decision') {
      const d = (msg as any) as VisitDecisionResponse;
      if (d && typeof (d as any).mode === 'string') {
        this.zone.run(() => this._decision$.next(d));
      }
      return;
    }

    // hello: no obligatorio para UI, pero útil para debug
  }
}
