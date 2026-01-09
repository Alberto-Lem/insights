import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class VisitsApiService {
  private readonly API_BASE = 'https://api.systemblacklem.com';

  endpoints(pageKey: string, visitorId?: string) {
    const page = encodeURIComponent(pageKey);
    const vid = visitorId ? `&vid=${encodeURIComponent(visitorId)}` : '';
    const qp = `?page=${page}${vid}`;

    return {
      track: `${this.API_BASE}/api/public/visits/track${qp}`,
      me: `${this.API_BASE}/api/public/visits/me${qp}`,
      insights: `${this.API_BASE}/api/public/visits/insights/me${qp}`,
      event: `${this.API_BASE}/api/public/visits/event`, // POST con header X-Visitor-Id

      // realtime
      stream: `${this.API_BASE}/api/public/visits/stream${qp}`,
      online: `${this.API_BASE}/api/public/visits/online${qp}`,
    };
  }

  async apiFetch<T>(url: string, visitorId: string, options: RequestInit = {}): Promise<T | null> {
    const headers = new Headers(options.headers || {});
    headers.set('X-Visitor-Id', visitorId);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const res = await fetch(url, { cache: 'no-store', ...options, headers });
    if (res.status === 204) return null;

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  openSse(url: string): EventSource {
    return new EventSource(url);
  }
}
