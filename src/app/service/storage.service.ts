// src/app/service/storage.service.ts
import { Injectable } from '@angular/core';
import type { Topic, TipStatsMap, TipStat } from '../models/models';
import type { MemoryEvent, MindState } from '../core/mind.types';

export type Prefs = { topic?: Topic; musicState?: 'AUTO' | 'ON' | 'OFF' };

export type ClientMeta = {
  tz?: string;
  tzOffsetMin?: number;
  lang?: string;
};

export type PendingVisitEvent = {
  id: string;
  page: string;
  type: 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC';
  topic?: string | null;
  ref?: string | null;
  meta?: Record<string, unknown>;
  ts: number;
  tries: number;
};

@Injectable({ providedIn: 'root' })
export class StorageService {
  readonly PREF_KEY = 'sb_visits_prefs_v1';
  readonly HISTORY_KEY = 'sb_tip_history_v2';
  readonly LAST_TIP_BY_TOPIC_KEY = 'sb_last_tip_by_topic_v1';
  readonly VISITOR_KEY_PREFIX = 'sb_visitor_id_v1:';
  readonly TIP_STATS_KEY = 'sb_tip_stats_v1';

  readonly MIND_STATE_KEY = 'sb_mind_state_v1';
  readonly MIND_EVENTS_KEY = 'sb_mind_events_v1';

  readonly CLIENT_META_KEY = 'sb_client_meta_v1';
  readonly PENDING_EVENTS_KEY = 'sb_pending_events_v1';

  private mem = new Map<string, unknown>();
  private writeTimers = new Map<string, any>();
  private pendingWrites = new Map<string, string>();

  constructor() {
    // ✅ multi-tab: si otra pestaña cambia localStorage, invalide cache local
    try {
      window.addEventListener('storage', (ev) => {
        const k = String(ev?.key || '');
        if (!k) return;
        this.mem.delete(k);
      });
    } catch {}
  }

  safeGet<T>(key: string): T | null {
    try {
      if (this.mem.has(key)) return this.mem.get(key) as T;

      const raw = localStorage.getItem(key);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as T;
      this.mem.set(key, parsed as unknown);
      return parsed;
    } catch {
      return null;
    }
  }

  safeSet(key: string, value: unknown): void {
    try {
      const raw = JSON.stringify(value);
      localStorage.setItem(key, raw);
      this.mem.set(key, value);
    } catch {}
  }

  safeSetThrottled(key: string, value: unknown, delayMs = 350): void {
    try {
      const raw = JSON.stringify(value);
      this.mem.set(key, value);
      this.pendingWrites.set(key, raw);

      if (this.writeTimers.has(key)) return;

      const t = setTimeout(() => {
        this.writeTimers.delete(key);
        const pending = this.pendingWrites.get(key);
        if (!pending) return;
        this.pendingWrites.delete(key);
        try {
          localStorage.setItem(key, pending);
        } catch {}
      }, Math.max(80, delayMs));

      this.writeTimers.set(key, t);
    } catch {}
  }

  // ================= Prefs / Tips =================

  getPrefs(): Prefs {
    return this.safeGet<Prefs>(this.PREF_KEY) ?? { topic: 'seguridad', musicState: 'AUTO' };
  }

  setPrefs(p: Prefs): void {
    this.safeSet(this.PREF_KEY, p);
  }

  getTipHistoryIds(): string[] {
    return this.safeGet<string[]>(this.HISTORY_KEY) ?? [];
  }

  pushTipHistoryId(id: string, max = 40): string[] {
    const h = this.getTipHistoryIds();
    const next = [id, ...h.filter((x) => x !== id)].slice(0, max);
    this.safeSet(this.HISTORY_KEY, next);
    return next;
  }

  getTipStats(): TipStatsMap {
    return this.safeGet<TipStatsMap>(this.TIP_STATS_KEY) ?? {};
  }

  bumpTipStat(id: string, kind: 'seen' | 'copied' | 'shared'): void {
    const all = this.getTipStats();
    const cur: TipStat = all[id] ?? { seen: 0, copied: 0, shared: 0 };

    cur[kind] = (cur[kind] ?? 0) + 1;
    if (kind === 'seen') cur.lastSeen = Date.now();

    all[id] = cur;
    this.safeSetThrottled(this.TIP_STATS_KEY, all, 500);
  }

  // ================= VisitorId (por page) =================

  private visitorKey(pageKey?: string): string {
    const p =
      String(pageKey || 'visits')
        .trim()
        .toLowerCase() || 'visits';
    return `${this.VISITOR_KEY_PREFIX}${p}`;
  }

  getVisitorId(pageKey?: string): string {
    const stored = this.safeGet<string>(this.visitorKey(pageKey));
    if (typeof stored === 'string') {
      const s = stored.trim();
      if (s.length >= 10) return s;
    }
    return '';
  }

  setVisitorId(v: string, pageKey?: string): void {
    const next = String(v ?? '').trim();
    if (!next) return;
    this.safeSet(this.visitorKey(pageKey), next);
  }

  // ================= Client meta =================

  getClientMeta(): ClientMeta {
    const cached = this.safeGet<ClientMeta>(this.CLIENT_META_KEY);
    if (cached && (cached.tz || cached.lang || typeof cached.tzOffsetMin === 'number'))
      return cached;

    const tz =
      (Intl?.DateTimeFormat?.().resolvedOptions?.().timeZone as string | undefined) || undefined;

    const meta: ClientMeta = {
      tz,
      tzOffsetMin: new Date().getTimezoneOffset(),
      lang: (navigator?.language || 'es') as string,
    };

    this.safeSet(this.CLIENT_META_KEY, meta);
    return meta;
  }

  setClientMeta(m: ClientMeta): void {
    this.safeSet(this.CLIENT_META_KEY, m);
  }

  // ✅ Tip “sticky” por topic (persistente)
  getLastTipByTopic<TTip = any>(): Partial<Record<Topic, TTip>> {
    return this.safeGet<Partial<Record<Topic, TTip>>>(this.LAST_TIP_BY_TOPIC_KEY) ?? {};
  }

  setLastTipForTopic<TTip = any>(topic: Topic, tip: TTip): void {
    if (!topic || !tip) return;
    const all = this.getLastTipByTopic<TTip>();
    all[topic] = tip;
    this.safeSetThrottled(this.LAST_TIP_BY_TOPIC_KEY, all, 450);
  }

  getLastTipForTopic<TTip = any>(topic: Topic): TTip | null {
    const all = this.getLastTipByTopic<TTip>();
    return (all?.[topic] as TTip) ?? null;
  }

  // ================= Mind =================

  getMindState(): MindState | null {
    return this.safeGet<MindState>(this.MIND_STATE_KEY);
  }

  setMindState(s: MindState): void {
    this.safeSetThrottled(this.MIND_STATE_KEY, s, 450);
  }

  getMindEvents(): MemoryEvent[] {
    return this.safeGet<MemoryEvent[]>(this.MIND_EVENTS_KEY) ?? [];
  }

  pushMindEvent(ev: MemoryEvent, max = 80): MemoryEvent[] {
    const all = this.getMindEvents();
    const next = [ev, ...all].slice(0, max);
    this.safeSetThrottled(this.MIND_EVENTS_KEY, next, 650);
    return next;
  }

  // ================= Pending events =================

  getPendingEvents(): PendingVisitEvent[] {
    return this.safeGet<PendingVisitEvent[]>(this.PENDING_EVENTS_KEY) ?? [];
  }

  setPendingEvents(list: PendingVisitEvent[]): void {
    this.safeSetThrottled(this.PENDING_EVENTS_KEY, list, 650);
  }

  enqueueEvent(ev: PendingVisitEvent, max = 120): void {
    const all = this.getPendingEvents();
    const next = [...all, ev].slice(-max);
    this.setPendingEvents(next);
  }

  peekMany(n: number): PendingVisitEvent[] {
    const all = this.getPendingEvents();
    return all.slice(0, Math.max(0, n));
  }

  bumpTries(ids: string[]): void {
    const set = new Set(ids);
    const all = this.getPendingEvents();
    const next = all.map((e) => (set.has(e.id) ? { ...e, tries: (e.tries ?? 0) + 1 } : e));
    this.setPendingEvents(next);
  }

  dropByIds(ids: string[]): void {
    const set = new Set(ids);
    const all = this.getPendingEvents();
    const next = all.filter((e) => !set.has(e.id));
    this.setPendingEvents(next);
  }
}
