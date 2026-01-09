import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class VisitsApiService {
  private readonly API_BASE = 'https://api.systemblacklem.com';

  endpoints(pageKey: string) {
    const q = encodeURIComponent(pageKey);
    return {
      track: `${this.API_BASE}/api/public/visits/track?page=${q}`,
      me: `${this.API_BASE}/api/public/visits/me?page=${q}`,
      event: `${this.API_BASE}/api/public/visits/event`,
      insights: `${this.API_BASE}/api/public/visits/insights/me?page=${q}`,

      // ✅ realtime
      stream: `${this.API_BASE}/api/public/visits/stream?page=${q}`,
      online: `${this.API_BASE}/api/public/visits/online?page=${q}`,
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
}
