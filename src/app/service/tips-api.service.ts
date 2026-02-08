// src/app/service/tips-api.service.ts
import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';
import { VisitsApiService, ApiEnvelope } from './visits-api.service';

export type SecurityTip = {
  id: string;
  topic: string;
  nivel: number;
  texto: string;
  tags?: string[];
  activo?: boolean;
};

@Injectable({ providedIn: 'root' })
export class TipsApiService {
  private readonly API_BASE = String((environment as any).apiBase || '').replace(/\/$/, '');

  constructor(private visitsApi: VisitsApiService) {}

  async nextTip(pageKey: string, vid: string, topic = 'seguridad'): Promise<ApiEnvelope<SecurityTip> | null> {
    const qTopic = encodeURIComponent((topic || 'seguridad').trim());
    const url = `${this.API_BASE}/api/public/tips/next?topic=${qTopic}`;

    // ✅ usa apiFetch para mandar X-Visitor-Id automáticamente
    return this.visitsApi.apiFetch<SecurityTip>(
      url,
      vid,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 0, allowStaleOnError: false }
    );
  }
}
