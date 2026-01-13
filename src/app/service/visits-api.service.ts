// src/app/service/visits-api.service.ts
import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

export type ApiEnvelope<T> = {
  status: number; // 200.., 401/403/429, 0 = red/timeout
  visitorId?: string; // X-Visitor-Id del backend (si viene)
  data?: T | null;
  error?: any;
};

export type ApiResult<T> = ApiEnvelope<T>;

export type VisitEventRequest = {
  page: string;
  type: string;
  topic?: string | null;
  ref?: string | null;
  meta?: Record<string, any>;
};

type FetchPolicy = {
  timeoutMs?: number;
  dedupe?: boolean;
  dedupeKey?: string;            // clave estable opcional
  cacheTtlMs?: number;
  allowStaleOnError?: boolean;
  withCredentials?: boolean;
  includeVidInKey?: boolean;     // ✅ por defecto true para endpoints dependientes del VID
};

type CacheEntry = { ts: number; value: any };

@Injectable({ providedIn: 'root' })
export class VisitsApiService {
  private readonly API_BASE = String((environment as any).apiBase || '').replace(/\/$/, '');

  private inflight = new Map<string, Promise<ApiEnvelope<any> | null>>();
  private cache = new Map<string, CacheEntry>();

  endpoints(pageKey: string) {
    const q = encodeURIComponent(pageKey);
    return {
      issue: `${this.API_BASE}/api/public/visits/issue?page=${q}`,
      track: `${this.API_BASE}/api/public/visits/track?page=${q}`,
      me: `${this.API_BASE}/api/public/visits/me?page=${q}`,
      insights: `${this.API_BASE}/api/public/visits/insights/me?page=${q}`,
      total: `${this.API_BASE}/api/public/visits/total?page=${q}`,
      online: `${this.API_BASE}/api/public/visits/online?page=${q}`,
      event: `${this.API_BASE}/api/public/visits/event`,
      linkIssue: `${this.API_BASE}/api/public/visits/link/issue?page=${q}`,
      linkConsume: `${this.API_BASE}/api/public/visits/link/consume?page=${q}`,
    };
  }

  sseUrl = (pageKey: string, signedVid: string): string => {
    const q = encodeURIComponent(pageKey);
    const v = (signedVid || '').trim();
    if (!v) return '';
    // ✅ EventSource no permite headers, por eso /stream usa ?vid=
    return `${this.API_BASE}/api/public/visits/stream?page=${q}&vid=${encodeURIComponent(v)}`;
  };

  openSse(url: string): EventSource {
    return new EventSource(url);
  }

  async issueVid(pageKey: string): Promise<ApiEnvelope<{ vid?: string; exp?: number }> | null> {
    const url = this.endpoints(pageKey).issue;

    const res = await this.apiFetch<{ vid?: string; exp?: number }>(
      url,
      '', // sin header => backend emite identidad
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 0, allowStaleOnError: false, includeVidInKey: false }
    );

    const bodyVid = (res?.data as any)?.vid ? String((res!.data as any).vid) : '';
    if (res && !res.visitorId && bodyVid) res.visitorId = bodyVid;

    return res;
  }

  /** Llave estable: evita mezclar cache/dedupe entre identidades distintas */
  private makeKey(method: string, url: string, policy: FetchPolicy, visitorId?: string): string {
    const base = policy.dedupeKey ? `${method}::${url}::${policy.dedupeKey}` : `${method}::${url}`;
    const include = policy.includeVidInKey !== false; // ✅ default true
    if (!include) return base;

    const vid = String(visitorId || '').trim();
    if (!vid) return base;

    // ✅ no metas el token completo (puede ser largo), usa un “fingerprint” corto
    const fp = vid.length > 18 ? `${vid.slice(0, 10)}…${vid.slice(-6)}` : vid;
    return `${base}::vid=${fp}`;
  }

  async apiFetch<T>(
    url: string,
    visitorId: string,
    options: RequestInit = {},
    policy: FetchPolicy = {}
  ): Promise<ApiEnvelope<T> | null> {
    const method = (options.method || 'GET').toUpperCase();
    const key = this.makeKey(method, url, policy, visitorId);

    const ttl = Math.max(0, Number(policy.cacheTtlMs || 0));
    if (ttl > 0) {
      const c = this.cache.get(key);
      if (c && Date.now() - c.ts <= ttl) return c.value as ApiEnvelope<T>;
    }

    if (policy.dedupe) {
      const inF = this.inflight.get(key);
      if (inF) return (await inF) as ApiEnvelope<T> | null;
    }

    const run = (async () => {
      const headers = new Headers(options.headers || {});

      const bodyIsString = typeof options.body === 'string';
      if (!headers.has('Content-Type') && bodyIsString) {
        headers.set('Content-Type', 'application/json');
      }

      const vid = (visitorId || '').trim();
      if (vid) headers.set('X-Visitor-Id', vid);

      const ac = new AbortController();
      const timeout = Math.max(900, Number(policy.timeoutMs || 6500));
      const t = setTimeout(() => ac.abort(), timeout);

      try {
        const res = await fetch(url, {
          ...options,
          headers,
          signal: ac.signal,
          cache: 'no-store',
          credentials: policy.withCredentials ? 'include' : options.credentials ?? 'same-origin',
        });

        const status = res.status;
        const headerVid = res.headers.get('X-Visitor-Id') || undefined;

        if (status === 204) {
          const env: ApiEnvelope<T> = { status, visitorId: headerVid, data: null };
          if (ttl > 0) this.cache.set(key, { ts: Date.now(), value: env });
          return env;
        }

        const ct = (res.headers.get('content-type') || '').toLowerCase();
        let data: any = null;

        if (ct.includes('application/json')) {
          try {
            data = await res.json();
          } catch {
            data = null;
          }
        } else {
          try {
            data = await res.text();
          } catch {
            data = null;
          }
        }

        const env: ApiEnvelope<T> = {
          status,
          visitorId: headerVid,
          data: (data as T) ?? null,
          error: status >= 400 ? data : undefined,
        };

        // ✅ cache solo respuestas OK
        if (ttl > 0 && status >= 200 && status < 300) {
          this.cache.set(key, { ts: Date.now(), value: env });
        }

        return env;
      } catch (e: any) {
        if (policy.allowStaleOnError && ttl > 0) {
          const c = this.cache.get(key);
          if (c) return c.value as ApiEnvelope<T>;
        }
        return { status: 0, visitorId: undefined, data: null, error: e } as ApiEnvelope<T>;
      } finally {
        clearTimeout(t);
      }
    })();

    if (policy.dedupe) this.inflight.set(key, run);
    const out = await run;
    if (policy.dedupe) this.inflight.delete(key);

    return out;
  }

  async linkIssue(pageKey: string, vid: string) {
    const url = this.endpoints(pageKey).linkIssue;
    return this.apiFetch<{ page: string; code: string; ttlSec: number }>(
      url,
      vid,
      { method: 'POST' },
      { timeoutMs: 6500, dedupe: false, cacheTtlMs: 0, allowStaleOnError: false }
    );
  }

  async linkConsume(pageKey: string, code: string) {
    const base = this.endpoints(pageKey).linkConsume;
    const url = `${base}&code=${encodeURIComponent(code)}`;
    return this.apiFetch<{ vid: string; exp: number }>(
      url,
      '', // consume no requiere header
      { method: 'POST' },
      { timeoutMs: 6500, dedupe: false, cacheTtlMs: 0, allowStaleOnError: false, includeVidInKey: false }
    );
  }
}
