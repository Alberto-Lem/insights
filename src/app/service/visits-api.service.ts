import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class VisitsApiService {
  private readonly API_BASE = 'https://api.systemblacklem.com';

  endpoints(pageKey: string, visitorId?: string) {
    const page = encodeURIComponent(pageKey);

    // ✅ para SSE: EventSource no manda headers, por eso pasamos visitorId en query
    const vid = visitorId ? `&vid=${encodeURIComponent(visitorId)}` : '';

    return {
      track: `${this.API_BASE}/api/public/visits/track?page=${page}`,
      me: `${this.API_BASE}/api/public/visits/me?page=${page}`,
      event: `${this.API_BASE}/api/public/visits/event`,
      insights: `${this.API_BASE}/api/public/visits/insights/me?page=${page}`,

      // ✅ realtime
      stream: `${this.API_BASE}/api/public/visits/stream?page=${page}${vid}`,
      online: `${this.API_BASE}/api/public/visits/online?page=${page}${vid}`,
    };
  }

  async apiFetch<T>(
    url: string,
    visitorId: string,
    options: RequestInit = {}
  ): Promise<T | null> {
    const headers = new Headers(options.headers || {});
    headers.set('X-Visitor-Id', visitorId);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, { cache: 'no-store', ...options, headers });
    if (res.status === 204) return null;

    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  openSse(url: string): EventSource {
    // EventSource NO soporta headers personalizados
    return new EventSource(url);
  }
}
