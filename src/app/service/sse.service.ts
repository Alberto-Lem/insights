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

  // ✅ NUEVO: watchdog
  private watchdogTimer: any = null;
  private lastSeenAt = 0;

  private pageKey = 'visits';

  private readonly _alive$ = new BehaviorSubject<boolean>(false);
  readonly alive$ = this._alive$.asObservable();

  private readonly _onlineNow$ = new BehaviorSubject<number>(0);
  readonly onlineNow$ = this._onlineNow$.asObservable();

  private readonly _profile$ = new BehaviorSubject<VisitProfileResponse | null>(null);
  readonly profile$ = this._profile$.asObservable();

  private readonly _insights$ = new BehaviorSubject<
    (VisitInsightsResponse & { _ts?: number }) | null
  >(null);
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

    // ✅ watchdog activo
    this.startWatchdog();
  }

  stop(): void {
    this.stopFlag = true;
    this._alive$.next(false);

    this.clearTimers();
    this.stopWatchdog();
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
    try {
      this.es?.close();
    } catch {}
    this.es = undefined;
  }

  private markSeen() {
    this.lastSeenAt = Date.now();
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.lastSeenAt = Date.now();

    const CHECK_MS = 1500;
    const DEAD_MS_FOREGROUND = 70_000; // backend ping ~25s
    const DEAD_MS_BACKGROUND = 140_000; // throttling en background

    this.watchdogTimer = setInterval(() => {
      if (this.stopFlag) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (this._alive$.value !== false) {
          this.zone.run(() => this._alive$.next(false));
        }
        return;
      }

      if (this._alive$.value === false && !this.es && !this.net.shouldPauseHeavyWork()) {
        const vid = this.storage.getVisitorId(this.pageKey);
        if (this.isSignedVid(vid)) {
          this.scheduleReconnect(900);
        }
        return;
      }

      const now = Date.now();
      const deadMs = document.hidden ? DEAD_MS_BACKGROUND : DEAD_MS_FOREGROUND;

      const silentFor = now - (this.lastSeenAt || 0);

      if (this._alive$.value === true && silentFor > deadMs) {
        this.zone.run(() => this._alive$.next(false));
        this.net.reportFail('SSE_SILENCE');

        // reset duro + reconexión
        this.detach();
        this.scheduleReconnect(650);
      }
    }, CHECK_MS);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(baseWaitMs = 650) {
    if (this.stopFlag) return;
    if (this.reconnectTimer) return;

    const pageKey = this.pageKey;
    const wait = this.net.nextBackoffMs(baseWaitMs, 30_000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(pageKey);
    }, wait);
  }

  private applyVisitorIdIfPresent(msg: any) {
    const vid = String(msg?.visitorId || '').trim();
    if (this.isSignedVid(vid)) this.storage.setVisitorId(vid, this.pageKey);
  }
  private startPollingOnline(pageKey: string): void {
    const onlineUrl = this.api.endpoints(pageKey).online;

    const tick = async () => {
      if (this.stopFlag) return;

      // ✅ si está pausado, NO “muera en silencio”: reprograme para cuando se destrabe
      if (this.net.shouldPauseHeavyWork()) {
        // opcional: si quiere reflejar “no vivo” cuando está en pausa prolongada
        // (mantiene coherencia con UI de “conectando”)
        // if (this._alive$.value !== false) this.zone.run(() => this._alive$.next(false));
        return;
      }

      const vid = this.storage.getVisitorId(pageKey);
      if (!this.isSignedVid(vid)) return;

      const res = await this.api.apiFetch<{ online: number }>(
        onlineUrl,
        vid,
        { method: 'GET' },
        { timeoutMs: 4500, dedupe: true, cacheTtlMs: 9000, allowStaleOnError: true }
      );

      // ✅ caída dura / timeout
      if (!res || res.status === 0) {
        this.net.reportFail('ONLINE_POLL_NET');
        // opcional: si quiere que el “conectando” se refleje más rápido
        // if (this._alive$.value !== false) this.zone.run(() => this._alive$.next(false));
        return;
      }

      // ✅ auth inválida: no lo trate como OK (evita “falsos verdes”)
      if (res.status === 401 || res.status === 403) {
        this.net.reportFail(res.status);
        return;
      }

      // ✅ OK real
      this.net.reportOk();

      // aplicar token retornado por header si viene
      if (res.visitorId && this.isSignedVid(res.visitorId)) {
        this.storage.setVisitorId(res.visitorId, pageKey);
      }

      const online = Number((res.data as any)?.online ?? NaN);
      if (!Number.isFinite(online)) return;

      if (this._onlineNow$.value !== online) {
        this.zone.run(() => this._onlineNow$.next(online));
      }
    };

    // ✅ importante: no duplique intervalos si start() se llama más de una vez
    if (this.pollTimer) clearInterval(this.pollTimer);

    this.pollTimer = setInterval(() => void tick(), 12_000);
    void tick();
  }

  private connect(pageKey: string): void {
    if (this.stopFlag) return;

    // ✅ si está pausado, NO salga silenciosamente: programe reintento
    if (this.net.shouldPauseHeavyWork()) {
      // refleje UI como “no vivo” (opcional, pero ayuda a no quedar en “conectando” eterno)
      if (this._alive$.value !== false) this.zone.run(() => this._alive$.next(false));

      // programe reconexión (no busy-loop)
      this.scheduleReconnect(1200);
      return;
    }

    const vid = this.storage.getVisitorId(pageKey);

    // ✅ si no hay token firmado, no intente SSE (evita 401 infinito)
    if (!this.isSignedVid(vid)) {
      this.zone.run(() => this._alive$.next(false));
      return;
    }

    const url = this.api.sseUrl(pageKey, vid);
    if (!url) {
      // si por alguna razón no hay url, intente más tarde
      this.scheduleReconnect(1500);
      return;
    }

    this.zone.runOutsideAngular(() => {
      // ✅ evite sockets duplicados
      this.detach();

      // ✅ reset de marca de vida al iniciar intento real
      this.markSeen();

      this.es = this.api.openSse(url);

      this.es.onopen = () => {
        this.markSeen();
        this.net.reportOk();
        this.zone.run(() => this._alive$.next(true));
      };

      // ✅ escuchar ping (backend heartbeat)
      this.es.addEventListener('ping', (ev: any) => this.onNamed('ping', ev));

      // ✅ otros eventos nombrados
      this.es.addEventListener('hello', (ev: any) => this.onNamed('hello', ev));
      this.es.addEventListener('online', (ev: any) => this.onNamed('online', ev));
      this.es.addEventListener('total', (ev: any) => this.onNamed('total', ev));
      this.es.addEventListener('profile', (ev: any) => this.onNamed('profile', ev));
      this.es.addEventListener('insights', (ev: any) => this.onNamed('insights', ev));
      this.es.addEventListener('decision', (ev: any) => this.onNamed('decision', ev));

      // fallback: si el server manda default message
      this.es.onmessage = (ev) => this.onRawMessage(ev);

      this.es.onerror = () => {
        // ✅ marque fallo + UI
        this.net.reportFail('SSE_ERROR');
        if (this._alive$.value !== false) this.zone.run(() => this._alive$.next(false));

        // ✅ cierre el socket roto (evita estado “pegado”)
        this.detach();

        // ✅ si quedó sin token válido, no reconecte
        const latest = this.storage.getVisitorId(pageKey);
        if (!this.isSignedVid(latest)) return;

        // ✅ si está “pausado” en este instante, igual programe reintento
        this.scheduleReconnect(650);
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

    this.markSeen();
    this.applyVisitorIdIfPresent(msg);

    const online =
      typeof (msg as any).onlineNow === 'number'
        ? Number((msg as any).onlineNow)
        : typeof (msg as any).online === 'number'
        ? Number((msg as any).online)
        : NaN;

    if (Number.isFinite(online) && this._onlineNow$.value !== online) {
      this.zone.run(() => this._onlineNow$.next(online));
    }
  }

  private onNamed(kind: string, ev: any) {
    if (this.stopFlag) return;

    // ✅ ping puede venir con JSON simple; si falla parse, igual cuenta como vida
    const msg = this.parse(ev);
    this.markSeen();

    if (!msg) {
      // si ping viene no-json, igual marque vida
      this.net.reportOk();
      return;
    }

    this.applyVisitorIdIfPresent(msg);
    this.net.reportOk();

    if (kind === 'ping') {
      // no necesita actualizar UI, solo mantiene la conexión “viva”
      return;
    }

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
      const p = msg as any as VisitProfileResponse;
      if (p && typeof (p as any).xp === 'number') {
        this.zone.run(() => this._profile$.next(p));
      }
      return;
    }

    if (kind === 'insights') {
      const ins = msg as any as VisitInsightsResponse;
      if (ins && typeof (ins as any).activeDaysLast7 === 'number') {
        this.zone.run(() => this._insights$.next({ ...(ins as any), _ts: Date.now() }));
      }
      return;
    }

    if (kind === 'decision') {
      const d = msg as any as VisitDecisionResponse;
      if (d && typeof (d as any).mode === 'string') {
        this.zone.run(() => this._decision$.next(d));
      }
      return;
    }
  }
}
