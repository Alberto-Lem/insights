// src/app/service/visits-api.service.ts
import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { ConnectivityService } from './connectivity.service';

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

type FetchPolicy = {
  timeoutMs?: number;              // corta fetch colgado (backend saturado)
  dedupe?: boolean;                // evita duplicar requests iguales en vuelo
  cacheTtlMs?: number;             // cachea GET (me/insights/online/total)
  allowStaleOnError?: boolean;     // si falla backend, devuelve último cache
  cacheKey?: string;               // clave custom si deseas
};

type CacheEntry = { exp: number; value: any };

@Injectable({ providedIn: 'root' })
export class VisitsApiService {
  private storage = inject(StorageService);
  private net = inject(ConnectivityService);

  private readonly API_BASE =
    (window as any).__SB_API_BASE__ ||
    'https://api.systemblacklem.com';

  // caché en memoria (rápido)
  private memCache = new Map<string, CacheEntry>();

  // requests en vuelo (dedupe)
  private inflight = new Map<string, Promise<any>>();

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

  private cacheGet<T>(key: string): T | null {
    const now = Date.now();
    const m = this.memCache.get(key);
    if (m && m.exp > now) return m.value as T;

    // fallback localStorage (opcional, barato y seguro por try/catch)
    try {
      const raw = localStorage.getItem(`sb_http_cache::${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEntry;
      if (parsed?.exp > now) {
        this.memCache.set(key, parsed);
        return parsed.value as T;
      }
    } catch {}
    return null;
  }

  private cacheSet(key: string, value: any, ttlMs: number): void {
    const exp = Date.now() + Math.max(200, ttlMs);
    const entry: CacheEntry = { exp, value };
    this.memCache.set(key, entry);
    try {
      localStorage.setItem(`sb_http_cache::${key}`, JSON.stringify(entry));
    } catch {}
  }

  private buildReqKey(url: string, visitorId: string, options: RequestInit): string {
    const method = (options.method || 'GET').toUpperCase();
    const body = typeof options.body === 'string' ? options.body : '';
    return `${method}::${url}::vid=${visitorId || ''}::b=${body}`;
  }

  async apiFetch<T>(
    url: string,
    visitorId: string,
    options: RequestInit = {},
    policy: FetchPolicy = {}
  ): Promise<ApiResult<T>> {
    const method = (options.method || 'GET').toUpperCase();
    const timeoutMs = policy.timeoutMs ?? 8_000;

    const headers = new Headers(options.headers || {});
    if (visitorId) headers.set('X-Visitor-Id', visitorId);

    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const reqKey = this.buildReqKey(url, visitorId, options);
    const cacheKey = policy.cacheKey ?? reqKey;

    // ✅ caché solo para GET
    const canCache = method === 'GET' && (policy.cacheTtlMs ?? 0) > 0;

    // si backend está OFFLINE, devuelve cache si existe (sin pegar a la red)
    if (this.net.shouldPauseHeavyWork() && canCache) {
      const cached = this.cacheGet<T>(cacheKey);
      if (cached !== null) return { data: cached, status: 200, visitorId };
      return { data: null, status: 0 };
    }

    // ✅ dedupe: si ya hay request igual en vuelo, reutiliza promesa
    if (policy.dedupe !== false) {
      const existing = this.inflight.get(reqKey);
      if (existing) return existing as Promise<ApiResult<T>>;
    }

    const run = (async (): Promise<ApiResult<T>> => {
      // cache hit inmediato
      if (canCache) {
        const cached = this.cacheGet<T>(cacheKey);
        if (cached !== null) return { data: cached, status: 200, visitorId };
      }

      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t0 = performance.now();

      const timer = ctrl
        ? window.setTimeout(() => ctrl.abort(), Math.max(800, timeoutMs))
        : 0;

      try {
        const res = await fetch(url, {
          cache: 'no-store',
          ...options,
          headers,
          signal: ctrl?.signal,
        });

        const latency = Math.round(performance.now() - t0);
        this.net.reportOk(latency);

        const vidHeader =
          res.headers.get('X-Visitor-Id') ||
          res.headers.get('X-VisitorId') ||
          undefined;

        if (vidHeader) this.storage.setVisitorId(vidHeader);

        if (res.status === 204) return { data: null, visitorId: vidHeader, status: res.status };

        const text = await res.text();
        if (!text) return { data: null, visitorId: vidHeader, status: res.status };

        let parsed: T | null = null;
        try {
          parsed = JSON.parse(text) as T;
        } catch {
          // si el backend devuelve texto no JSON, no rompas la app
          parsed = null;
        }

        // cachea respuesta buena
        if (canCache && res.ok && parsed !== null) {
          this.cacheSet(cacheKey, parsed, policy.cacheTtlMs!);
        }

        return { data: parsed, visitorId: vidHeader, status: res.status };
      } catch (err: any) {
        this.net.reportFail(err);

        // ✅ stale-on-error: si falla, entrega último cache si existe
        if (canCache && policy.allowStaleOnError !== false) {
          const cached = this.cacheGet<T>(cacheKey);
          if (cached !== null) return { data: cached, status: 200, visitorId };
        }
        return { data: null, status: 0 };
      } finally {
        if (timer) window.clearTimeout(timer);
      }
    })();

    if (policy.dedupe !== false) {
      this.inflight.set(reqKey, run);
      run.finally(() => this.inflight.delete(reqKey));
    }

    return run;
  }

  /** ✅ Única forma recomendada de enviar eventos (NO cache / NO reintento agresivo). */
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

    // timeout corto para POST: si está saturado, no bloquees UI
    return this.apiFetch<TResp>(url, visitorId, {
      method: 'POST',
      body: JSON.stringify(req),
    }, {
      timeoutMs: 4_500,
      dedupe: false,
      cacheTtlMs: 0,
      allowStaleOnError: false,
    });
  }

  openSse(url: string): EventSource {
    // Nota: EventSource no permite headers; por eso ya incluyes vid/page en querystring.
    return new EventSource(url);
  }
}
