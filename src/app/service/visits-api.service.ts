// src/app/service/visits-api.service.ts
import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';

export type ApiResult<T> = {
  data: T | null;
  visitorId?: string;
  status: number;
};

export type VisitEventRequest = {
  page: string;
  type: 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC';
  topic?: string | null;
  ref?: string | null;
  meta?: Record<string, any>;
};

@Injectable({ providedIn: 'root' })
export class VisitsApiService {
  private storage = inject(StorageService);

  /**
   * ✅ Mejora clave:
   * - Evite hardcode a localhost en producción.
   * - Permite override por window.__SB_API_BASE__ (útil en GitHub Pages).
   */
  private readonly API_BASE =
    (window as any).__SB_API_BASE__ ||
    'https://api.systemblacklem.com';

  endpoints(pageKey: string, visitorId?: string) {
    const page = encodeURIComponent(pageKey);
    const vid = visitorId ? `&vid=${encodeURIComponent(visitorId)}` : '';
    const qp = `?page=${page}${vid}`;

    return {
      track: `${this.API_BASE}/api/public/visits/track${qp}`,
      me: `${this.API_BASE}/api/public/visits/me${qp}`,
      insights: `${this.API_BASE}/api/public/visits/insights/me${qp}`,
      event: `${this.API_BASE}/api/public/visits/event`,
      stream: `${this.API_BASE}/api/public/visits/stream${qp}`,
      online: `${this.API_BASE}/api/public/visits/online${qp}`,
      total: `${this.API_BASE}/api/public/visits/total?page=${page}`,
    };
  }

  async apiFetch<T>(url: string, visitorId: string, options: RequestInit = {}): Promise<ApiResult<T>> {
    const headers = new Headers(options.headers || {});
    if (visitorId) headers.set('X-Visitor-Id', visitorId);

    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    try {
      const res = await fetch(url, { cache: 'no-store', ...options, headers });

      const vidHeader =
        res.headers.get('X-Visitor-Id') ||
        res.headers.get('X-VisitorId') ||
        undefined;

      if (vidHeader) this.storage.setVisitorId(vidHeader);

      if (res.status === 204) return { data: null, visitorId: vidHeader, status: res.status };

      const text = await res.text();
      if (!text) return { data: null, visitorId: vidHeader, status: res.status };

      const parsed = JSON.parse(text) as T;
      return { data: parsed, visitorId: vidHeader, status: res.status };
    } catch {
      return { data: null, status: 0 };
    }
  }

  /** ✅ Única forma recomendada de enviar eventos (agrega tz/lang automáticamente). */
  async sendEvent<TResp>(
    pageKey: string,
    payload: Omit<VisitEventRequest, 'page' | 'meta'> & { meta?: Record<string, any> }
  ): Promise<ApiResult<TResp>> {
    const visitorId = this.storage.getVisitorId();
    const metaBase = this.storage.getClientMeta();

    if (!payload?.type) return { data: null, status: 0 };

    const req: VisitEventRequest = {
      page: pageKey,
      type: payload.type,
      topic: payload.topic ?? null,
      ref: payload.ref ?? null,
      meta: {
        tz: metaBase.tz,
        tzOffsetMin: metaBase.tzOffsetMin,
        lang: metaBase.lang,
        ...payload.meta,
      },
    };

    const url = this.endpoints(pageKey, visitorId).event;
    return this.apiFetch<TResp>(url, visitorId, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  openSse(url: string): EventSource {
    return new EventSource(url);
  }
}
