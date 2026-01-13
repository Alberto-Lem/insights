// src/app/service/offline-sync.service.ts
import { Injectable, inject } from '@angular/core';
import { StorageService, PendingVisitEvent } from './storage.service';
import { VisitsApiService, VisitEventRequest, ApiResult } from './visits-api.service';
import { ConnectivityService } from './connectivity.service';
import { randomId } from '../utils/utils';

type EventType = PendingVisitEvent['type'];

@Injectable({ providedIn: 'root' })
export class OfflineSyncService {
  private storage = inject(StorageService);
  private api = inject(VisitsApiService);
  private net = inject(ConnectivityService);

  private flushing = false;
  private handshaking = false;
  private lastHandshakeAt = 0;

  private authPausedUntil = 0;

  private isAuthPaused(): boolean {
    return Date.now() < this.authPausedUntil;
  }

  private pauseAuth(ms: number) {
    const until = Date.now() + Math.max(800, ms);
    this.authPausedUntil = Math.max(this.authPausedUntil, until);
  }

  private backoffMs(base = 1200, max = 18_000): number {
    return this.net.nextBackoffMs(base, max);
  }

  private isSignedVid(v: string): boolean {
    const s = String(v || '').trim();
    return !!s && s.includes('.') && s.length > 20;
  }

  /**
   * Handshake canónico:
   * 1) Si no hay VID firmado -> /issue
   * 2) Luego llama /me para refrescar header (si expiró y backend re-firma)
   * 3) Flush de cola (si aplica)
   */
  async handshakeAndFlush(pageKey: string): Promise<void> {
    if (this.net.shouldPauseHeavyWork()) return;
    if (this.isAuthPaused()) return;
    if (this.handshaking) return;

    this.handshaking = true;

    try {
      const now = Date.now();
      if (now - this.lastHandshakeAt < 7000) return;
      this.lastHandshakeAt = now;

      let vid = this.storage.getVisitorId(pageKey);

      // A) emitir si no hay token firmado
      if (!this.isSignedVid(vid)) {
        const issued = await this.api.issueVid(pageKey);
        if (!issued || issued.status === 0) {
          this.net.reportFail('ISSUE_FAIL');
          return;
        }

        const token = String(issued.visitorId || (issued.data as any)?.vid || '').trim();
        if (this.isSignedVid(token)) {
          this.storage.setVisitorId(token, pageKey);
          vid = token;
        } else {
          return;
        }
      }

      // B) /me para permitir refresh del header
      const meUrl = this.api.endpoints(pageKey).me;
      const meRes = await this.api.apiFetch<any>(
        meUrl,
        vid,
        { method: 'GET' },
        { timeoutMs: 6500, dedupe: true, cacheTtlMs: 10_000, allowStaleOnError: true }
      );

      if (!meRes || meRes.status === 0) {
        this.net.reportFail('ME_FAIL');
        return;
      }

      this.net.reportOk();

      // aplicar token retornado por header
      if (this.isSignedVid(String(meRes.visitorId || '').trim())) {
        this.storage.setVisitorId(String(meRes.visitorId).trim(), pageKey);
        vid = String(meRes.visitorId).trim();
      }

      if (meRes.status === 401 || meRes.status === 403) {
        this.pauseAuth(this.backoffMs(1600, 22_000));
        return;
      }

      await this.flushQueue(pageKey);
    } finally {
      this.handshaking = false;
    }
  }

  /**
   * API pública única para emitir eventos desde la App.
   * - Siempre encola primero.
   * - Luego intenta enviar (si se puede).
   */
  async trackEvent<TResp = any>(
    pageKey: string,
    payload: Omit<VisitEventRequest, 'page' | 'meta'> & { meta?: Record<string, any> }
  ): Promise<ApiResult<TResp> | null> {
    const metaBase = this.storage.getClientMeta();

    const ev: PendingVisitEvent = {
      id: `e_${randomId(18)}`,
      page: pageKey,
      type: payload.type as EventType,
      topic: payload.topic ?? null,
      ref: payload.ref ?? null,
      meta: {
        tz: metaBase.tz,
        tzOffsetMin: metaBase.tzOffsetMin,
        lang: metaBase.lang,
        ...(payload.meta ?? {}),
      },
      ts: Date.now(),
      tries: 0,
    };

    this.storage.enqueueEvent(ev);

    if (this.net.shouldPauseHeavyWork() || this.isAuthPaused()) return null;

    const res = await this.trySendOne<TResp>(pageKey, ev);

    if (res && res.status >= 200 && res.status < 300) {
      this.storage.dropByIds([ev.id]);
      this.net.reportOk();
      return res;
    }

    // 401/403: pausa auth y handshake
    if (res && (res.status === 401 || res.status === 403)) {
      this.net.reportFail(res.status);
      this.pauseAuth(this.backoffMs(1500, 22_000));
      await this.handshakeAndFlush(pageKey);
      return res;
    }

    // 429 o 5xx: backend saturado
    if (res && (res.status === 429 || (res.status >= 500 && res.status < 600))) {
      this.net.reportFail(res.status);
      this.pauseAuth(this.backoffMs(2000, 30_000));
      return res;
    }

    if (!res || res.status === 0) {
      this.net.reportFail('NET');
    }

    return res;
  }

  async flushQueue(pageKey: string): Promise<void> {
    if (this.isAuthPaused()) return;
    if (this.net.shouldPauseHeavyWork()) return;
    if (this.flushing) return;

    this.flushing = true;

    try {
      const batchSize = 8;

      for (let round = 0; round < 8; round++) {
        if (this.net.shouldPauseHeavyWork() || this.isAuthPaused()) break;

        const pending = this.storage.peekMany(batchSize);
        if (!pending.length) break;

        const results: Array<{ id: string; ok: boolean; status: number }> = [];

        for (const ev of pending) {
          if (this.net.shouldPauseHeavyWork() || this.isAuthPaused()) break;

          const r = await this.trySendOne<any>(pageKey, ev);

          if (r && r.status >= 200 && r.status < 300) {
            results.push({ id: ev.id, ok: true, status: r.status });
            continue;
          }

          if (r && (r.status === 401 || r.status === 403)) {
            this.pauseAuth(this.backoffMs(1600, 22_000));
            results.push({ id: ev.id, ok: false, status: r.status });
            break;
          }

          if (r && (r.status === 429 || (r.status >= 500 && r.status < 600))) {
            this.pauseAuth(this.backoffMs(2200, 30_000));
            results.push({ id: ev.id, ok: false, status: r.status });
            break;
          }

          results.push({ id: ev.id, ok: false, status: r?.status ?? 0 });
          if (!r || r.status === 0) break;
        }

        const okIds = results.filter(x => x.ok).map(x => x.id);
        if (okIds.length) this.storage.dropByIds(okIds);

        const failIds = results.filter(x => !x.ok).map(x => x.id);
        if (failIds.length) this.storage.bumpTries(failIds);

        const anyHardFail = results.some(x => x.status === 0);
        const anyAuthFail = results.some(x => x.status === 401 || x.status === 403);
        const anyOverload = results.some(x => x.status === 429 || (x.status >= 500 && x.status < 600));
        if (anyHardFail || anyAuthFail || anyOverload) break;
      }

      if (this.isAuthPaused()) {
        await this.handshakeAndFlush(pageKey);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async trySendOne<TResp = any>(pageKey: string, ev: PendingVisitEvent): Promise<ApiResult<TResp>> {
    let vid = this.storage.getVisitorId(pageKey);
    if (!this.isSignedVid(vid)) {
      return { status: 0, data: null, error: 'NO_SIGNED_VID' } as ApiResult<TResp>;
    }

    const url = this.api.endpoints(ev.page).event;

    const body: VisitEventRequest = {
      page: ev.page,
      type: ev.type,
      topic: ev.topic ?? null,
      ref: ev.ref ?? null,
      meta: { ...(ev.meta ?? {}), eventId: ev.id, ts: ev.ts },
    };

    const res = await this.api.apiFetch<TResp>(
      url,
      vid,
      { method: 'POST', body: JSON.stringify(body) },
      { timeoutMs: 5200, dedupe: false, cacheTtlMs: 0, allowStaleOnError: false }
    );

    // aplicar token retornado por header
    if (res?.visitorId && this.isSignedVid(String(res.visitorId))) {
      this.storage.setVisitorId(String(res.visitorId), pageKey);
      vid = String(res.visitorId);
    }

    return (res ?? ({ status: 0, data: null } as ApiResult<TResp>));
  }
}
