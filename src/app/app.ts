// src/app/app.ts
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';

import { StorageService } from './service/storage.service';
import { TipsService } from './service/tips.service';
import { TipsApiService, SecurityTip } from './service/tips-api.service';
import { VisitsApiService } from './service/visits-api.service';
import { CanvasFxService } from './service/canvas-fx.service';
import { MindService } from './service/mind.service';
import { AudioService } from './service/audio.service';
import { OfflineSyncService } from './service/offline-sync.service';
import { ConnectivityService } from './service/connectivity.service';
import { SseService, VisitDecisionResponse } from './service/sse.service';

import { Pair, Tip, Topic, VisitInsightsResponse, VisitProfileResponse } from './models/models';
import { getRefFromUrl } from './utils/utils';
import { BumpKind, bumpToState, computeCardVisuals } from './ui/card-visuals';

type TipWithId = Tip & {
  id?: string;
  _id?: string;
  nivel?: number;
  tags?: string[];
  activo?: boolean;
};
type VisitEventType = 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC';

const DEFAULT_DECISION: VisitDecisionResponse = {
  mode: 'NORMAL',
  maxTipsAllowed: 999,
  allowShare: true,
  allowNewTip: true,
  systemMessage: '',
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('fxCanvas') fxCanvas?: ElementRef<HTMLCanvasElement>;

  @HostBinding('class') hostClass = 'appRoot';
  @HostBinding('style.--card-glow') hostGlow = '10';

  private sync = inject(OfflineSyncService);
  private storage = inject(StorageService);
  private tipsSrv = inject(TipsService);
  private tipsApi = inject(TipsApiService);
  private api = inject(VisitsApiService);
  private fx = inject(CanvasFxService);
  private mind = inject(MindService);
  private audioSrv = inject(AudioService);
  private net = inject(ConnectivityService);
  private sse = inject(SseService);

  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  private readonly PAGE_KEY = 'visits';

  topic: Topic = 'seguridad';
  hint = '';
  currentTip: TipWithId | null = null;

  profile: VisitProfileResponse | null = null;
  insights: (VisitInsightsResponse & { _ts?: number }) | null = null;

  totalToday = 0;
  historyCount = 0;

  toastMsg = '';
  toastVisible = false;
  private tToast?: ReturnType<typeof setTimeout>;

  progress = { x: 0, nextLevel: 2, nextGoal: 100, pct: 0, left: 100 };

  actionRows: { label: string; value: number }[] = [];
  hourRows: { key: string; value: number }[] = [];
  peakHourLabel = '—';
  topActionLabel = '—';
  healthHint = '—';

  headerKpis: Array<{ icon: string; label: string; value: string; kind?: 'online' }> = [];

  decision: VisitDecisionResponse = { ...DEFAULT_DECISION };

  onlineNow = 0;
  sseAlive = false;

  private visitorId = '';
  private ref = 'direct';

  private tMe?: ReturnType<typeof setInterval>;
  private tInsights?: ReturnType<typeof setInterval>;
  private tTotal?: ReturnType<typeof setInterval>;
  private tFlush?: ReturnType<typeof setInterval>;

  private tBumpReset?: ReturnType<typeof setTimeout>;

  // cache por topic (sticky tip)
  private lastTipByTopic: Partial<Record<Topic, TipWithId>> = {};

  private mindSub?: Subscription;
  private sseSub?: Subscription;
  private sseOnlineSub?: Subscription;
  private sseProfileSub?: Subscription;
  private sseInsightsSub?: Subscription;
  private sseDecisionSub?: Subscription;
  private sseTotalSub?: Subscription;

  visitorAlias = 'SB-ANON';
  profileLabel = 'Visitor';
  profileBadge = 'Perfil público';

  avatarBg = 'linear-gradient(135deg, rgba(120,92,255,.45), rgba(0,255,209,.28))';
  avatarRing = 'rgba(255,255,255,.18)';

  cardTier: 'BRONZE' | 'SILVER' | 'GOLD' | 'NEBULA' = 'BRONZE';
  cardSkinClass = 'tier-bronze';
  cardSigil = '◎';
  cardState: 'IDLE' | 'LISTEN' | 'THINK' | 'SPEAK' = 'IDLE';

  private userInteracted = false;
  private destroyed = false;

  private readonly TRACK_FLAG_PREFIX = 'sb_tracked_today::';

  /* ===================== View helpers ===================== */

  private syncHostClass() {
    const tier = this.cardSkinClass || 'tier-bronze';
    const state = `state-${(this.cardState || 'IDLE').toLowerCase()}`;
    this.hostClass = `appRoot ${tier} ${state}`;
  }
  get difficultyView(): string {
    return this.difficultyLabel((this.currentTip as any)?.nivel);
  }

  get musicState() {
    return this.audioSrv.state;
  }

  get musicLabel(): string {
    const s = this.musicState;
    return s === 'ON' ? '🔊 Audio: ON' : s === 'OFF' ? '🔇 Audio: OFF' : '🔊 Audio: AUTO';
  }

  get decisionLabel(): string {
    const m = this.decision?.mode || 'NORMAL';
    return m === 'FOCUS' ? 'FOCUS' : m === 'REST' ? 'REST' : m === 'REDUCED' ? 'REDUCED' : 'NORMAL';
  }

  get canNewTip(): boolean {
    return !!this.decision?.allowNewTip;
  }

  get canShare(): boolean {
    return !!this.decision?.allowShare;
  }

  get totalView(): string {
    return String(this.totalToday);
  }

  get streakView(): string {
    const v = (this.profile as any)?.streak;
    return v === null || v === undefined ? '—' : String(v);
  }

  get levelView(): string {
    const v = (this.profile as any)?.level;
    return v === null || v === undefined ? '—' : String(v);
  }

  get visitorIdFull(): string {
    return this.visitorId || '—';
  }

  get visitorIdShort(): string {
    const v = this.visitorId || '';
    return v.length > 14 ? `${v.slice(0, 10)}…${v.slice(-4)}` : v || '—';
  }

  private isSignedVid(v: string): boolean {
    const s = String(v || '').trim();
    return !!s && s.includes('.') && s.length > 20;
  }

  /* ===================== UI actions ===================== */

  async copyVisitorId(): Promise<void> {
    this.userInteracted = true;

    const safeId =
      String(this.visitorAlias || '').trim() || String(this.visitorIdShort || '').trim();
    if (!safeId) {
      this.toast('Aún no hay ID público disponible.');
      this.mind.ingest('ERROR', this.topic, false, {
        where: 'copyVisitorId',
        reason: 'missing_public_id',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(safeId);
      this.toast('ID público copiado.');
      this.mind.ingest('COPY_VISITOR_ID', this.topic, true, {
        what: 'publicVisitorId',
        value: safeId,
      });
    } catch (e: any) {
      try {
        const ok = this.legacyCopyToClipboard(safeId);
        if (ok) {
          this.toast('ID público copiado.');
          this.mind.ingest('COPY_VISITOR_ID', this.topic, true, {
            what: 'publicVisitorId',
            value: safeId,
            fallback: true,
          });
          return;
        }
      } catch {}

      this.toast('No se pudo copiar (permiso del navegador).');
      this.mind.ingest('ERROR', this.topic, false, {
        where: 'copyVisitorId',
        reason: 'clipboard_denied',
        message: String(e?.message || e),
      });
    }
  }

  private legacyCopyToClipboard(text: string): boolean {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'true');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.left = '-1000px';
    document.body.appendChild(ta);

    ta.focus();
    ta.select();

    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      document.body.removeChild(ta);
    }
    return ok;
  }

  async toggleMusic(): Promise<void> {
    this.userInteracted = true;

    const cur = this.audioSrv.state;
    const next = cur === 'OFF' ? 'ON' : cur === 'ON' ? 'AUTO' : 'OFF';
    this.audioSrv.state = next;

    const prefs = this.storage.getPrefs();
    this.storage.setPrefs({ ...prefs, musicState: next });

    await this.audioSrv.userKick();

    this.toast(`Audio: ${next}`);
    this.mind.ingest('SESSION_TICK', this.topic, true, { music: next, seconds: 2 });
    this.ui();
  }

  async setTopic(t: Topic): Promise<void> {
    this.userInteracted = true;

    const next = (t || '').toString().trim() as Topic;
    if (!next) return;

    const prev = this.topic;
    const changed = next !== prev;

    this.topic = next;
    this.tipsSrv.setTopic(next);

    if (changed) {
      const prefs = this.storage.getPrefs();
      this.storage.setPrefs({ ...prefs, topic: next });
      await this.emitVisitEvent('TOPIC', { topic: next });
    }

    const cached = this.lastTipByTopic[next] ?? this.storage.getLastTipForTopic<TipWithId>(next);
    if (cached) {
      this.currentTip = cached;
      this.bumpCardState('TOPIC');
      this.ui();
      return;
    }

    // ✅ Backend-first: obtener tip desde el backend (si hay VID válido); si no, esperar a ngAfterViewInit

    const ok = await this.pickNewTipFromBackend(next);
    if (!ok) {
      this.toast('No se pudo obtener tip (sin sesión o sin conexión).');
      return;
    }

    this.bumpCardState('TOPIC');
    this.ui();
  }

  async onNewTip(): Promise<void> {
    this.userInteracted = true;

    if (!this.canNewTip) {
      this.toast('Acción limitada por el modo actual.');
      return;
    }

    const ok = await this.pickNewTipFromBackend(this.topic);
    if (!ok) {
      this.toast('No se pudo obtener tip (verifique conexión).');
      return;
    }

    const tipId = this.getTipId(this.currentTip) || null;

    await this.emitVisitEvent('NEW_TIP', {
      ref: tipId,
      title: this.currentTip?.title || null,
    });

    this.bumpCardState('NEW_TIP');
    this.ui();
  }

  async onCopy(): Promise<void> {
    this.userInteracted = true;

    const tip = this.currentTip;
    if (!tip) {
      this.toast('No hay tip para copiar.');
      return;
    }

    const tipId = this.getTipId(tip) || 'unknown';
    const text = this.formatTipForCopy(tip);

    try {
      await navigator.clipboard.writeText(text);
      this.toast('Tip copiado.');

      this.tipsSrv.copyTip(tip as any, true);
      await this.emitVisitEvent('COPY_TIP', { ref: tipId });

      this.bumpCardState('COPY_TIP');
      this.ui();
    } catch {
      this.toast('No se pudo copiar (permiso del navegador).');
      this.tipsSrv.copyTip(tip as any, false);
    }
  }

  async onShare(): Promise<void> {
    this.userInteracted = true;

    const tip = this.currentTip;
    if (!tip) {
      this.toast('No hay tip para compartir.');
      return;
    }

    if (!this.canShare) {
      this.toast('Acción limitada por el modo actual.');
      return;
    }

    const tipId = this.getTipId(tip) || 'unknown';
    const text = this.formatTipForCopy(tip);

    const canNativeShare = typeof (navigator as any)?.share === 'function';

    try {
      let channel: 'native' | 'clipboard' = 'clipboard';

      if (canNativeShare) {
        await (navigator as any).share({
          title: tip.title || 'SystemBlacklem · Tips',
          text,
          url: location.href,
        });
        channel = 'native';
        this.toast('Compartido.');
      } else {
        await navigator.clipboard.writeText(text);
        channel = 'clipboard';
        this.toast('Copiado para compartir.');
      }

      this.tipsSrv.shareTip(tip as any, true, channel);
      await this.emitVisitEvent('SHARE_TIP', { ref: tipId });

      this.bumpCardState('SHARE_TIP');
      this.ui();
    } catch {
      this.toast('No se pudo compartir.');
      this.tipsSrv.shareTip(tip as any, false);
    }
  }

  /* ===================== Lifecycle ===================== */

  ngOnInit(): void {
    this.ref = getRefFromUrl(location.href);
    this.audioSrv.setBlockedHandler((msg) => this.toast(msg));

    this.visitorId = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    this.buildProfileUI(this.visitorId);

    const prefs = this.storage.getPrefs();
    this.topic = (prefs.topic ?? 'seguridad') as Topic;
    this.historyCount = this.storage.getTipHistoryIds().length;

    const ms = (prefs as any)?.musicState;
    if (ms === 'ON' || ms === 'OFF' || ms === 'AUTO') this.audioSrv.state = ms;

    this.lastTipByTopic = this.storage.getLastTipByTopic<TipWithId>() ?? {};

    this.mindSub = this.mind.observe().subscribe((state) => {
      this.fx.setMode(this.mind.getFxMode(state.mood));
      this.hint = this.mind.getToneLine(state, this.topic);
      this.pushAudioHint();
      this.ui();
    });

    this.sseSub = this.sse.alive$.subscribe((alive) => {
      this.sseAlive = alive;
      if (alive) this.tipsSrv.sseUp();
      else this.tipsSrv.sseDown();

      this.applyIdentityVisuals('ONLINE', 'SSE');
      this.pushAudioHint();
      this.ui();
    });

    this.sseOnlineSub = this.sse.onlineNow$.subscribe((n) => {
      this.onlineNow = Number(n || 0);
      this.applyIdentityVisuals('ONLINE', 'SSE');
      this.pushAudioHint();
      this.ui();
    });

    this.sseProfileSub = this.sse.profile$.subscribe((p) => {
      if (!p) return;
      const prevLevel = Number((this.profile as any)?.level ?? 0);
      const prevStreak = Number((this.profile as any)?.streak ?? 0);

      this.profile = p;
      this.computeProgress(prevLevel, prevStreak);
      this.applyIdentityVisuals('PROFILE');
      this.pushAudioHint();
      this.ui();
    });

    this.sseInsightsSub = this.sse.insights$.subscribe((ins) => {
      if (!ins) return;
      this.insights = ins;
      this.deriveInsightsUI();
      this.pushAudioHint();
      this.ui();
    });

    this.sseDecisionSub = this.sse.decision$.subscribe((d) => {
      if (!d) return;
      this.decision = d;
      this.pushAudioHint();
      this.ui();
    });

    this.sseTotalSub = this.sse.total$.subscribe((t) => {
      if (typeof t !== 'number') return;
      this.totalToday = t;
      this.ui();
    });

    this.tipsSrv.setTopic(this.topic);

    // ✅ Tip sticky (solo lectura). Si no existe, lo pedimos en ngAfterViewInit cuando ya exista VID válido.
    const cached =
      this.lastTipByTopic[this.topic] ?? this.storage.getLastTipForTopic<TipWithId>(this.topic);
    if (cached) this.currentTip = cached;

    this.updateCardVisuals();
    this.ui();
  }

  async ngAfterViewInit(): Promise<void> {
    if (this.fxCanvas?.nativeElement) {
      this.fx.bind(this.fxCanvas.nativeElement);
      this.fx.start();
    }

    await this.safeHandshake();

    this.visitorId = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    this.buildProfileUI(this.visitorId);

    if (!this.isSignedVid(this.visitorId)) {
      this.profileBadge = 'Sesión inválida (VID no firmado)';
      this.ui();
      return;
    }

    if (!this.wasTrackedToday()) {
      await this.trackSafe();
      this.markTrackedToday();
    }

    await this.loadMeSafe();
    await this.loadTotalSafe();
    await this.loadInsightsSafe(true);

    // ✅ Si no hay tip (o si es la primera visita), obtener uno del backend ya con VID válido
    if (!this.currentTip) {
      await this.pickNewTipFromBackend(this.topic);
    }

    this.sse.start(this.PAGE_KEY);

    this.tMe = setInterval(() => void this.loadMeSafe(), 55_000);
    this.tInsights = setInterval(() => void this.loadInsightsSafe(false), 90_000);
    this.tTotal = setInterval(() => void this.loadTotalSafe(), 60_000);
    this.tFlush = setInterval(() => void this.safeHandshake(), 70_000);

    this.ui();
  }

  ngOnDestroy(): void {
    this.destroyed = true;

    this.fx.stop();
    this.sse.stop();

    this.mindSub?.unsubscribe();
    this.sseSub?.unsubscribe();
    this.sseOnlineSub?.unsubscribe();
    this.sseProfileSub?.unsubscribe();
    this.sseInsightsSub?.unsubscribe();
    this.sseDecisionSub?.unsubscribe();
    this.sseTotalSub?.unsubscribe();

    this.tMe && clearInterval(this.tMe);
    this.tInsights && clearInterval(this.tInsights);
    this.tTotal && clearInterval(this.tTotal);
    this.tFlush && clearInterval(this.tFlush);

    this.tToast && clearTimeout(this.tToast);
    this.tBumpReset && clearTimeout(this.tBumpReset);

    this.audioSrv.destroy();
  }

  /* ===================== API pulls (fallback/compat) ===================== */

  private apiEndpoints() {
    return this.api.endpoints(this.PAGE_KEY);
  }

  private syncVisitorId(newVid?: string) {
    const v = String(newVid || '').trim();
    if (!v || v === this.visitorId) return;

    this.visitorId = v;
    this.storage.setVisitorId(v, this.PAGE_KEY);
    this.buildProfileUI(v);
  }

  private async safeHandshake(): Promise<void> {
    try {
      await this.sync.handshakeAndFlush(this.PAGE_KEY);
    } catch {
      // no-op (offline)
    }
  }

  private async loadMeSafe() {
    if (this.net.shouldPauseHeavyWork()) return;

    await this.safeHandshake();

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { me } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitProfileResponse>(
      me,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 12_000, allowStaleOnError: true },
    );
    if (!res || res.status === 0) return;
    if (res.status === 401 || res.status === 403) return;

    if (res.visitorId && this.isSignedVid(res.visitorId)) this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    const prevLevel = Number((this.profile as any)?.level ?? 0);
    const prevStreak = Number((this.profile as any)?.streak ?? 0);

    this.profile = d;
    this.computeProgress(prevLevel, prevStreak);
    this.applyIdentityVisuals('PROFILE');
    this.pushAudioHint();
    this.ui();
  }

  private async trackSafe() {
    if (this.net.shouldPauseHeavyWork()) return;

    await this.safeHandshake();

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { track } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitProfileResponse>(
      track,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 0, allowStaleOnError: false },
    );
    if (!res || res.status === 0) return;
    if (res.status === 401 || res.status === 403) return;

    if (res.visitorId && this.isSignedVid(res.visitorId)) this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    const prevLevel = Number((this.profile as any)?.level ?? 0);
    const prevStreak = Number((this.profile as any)?.streak ?? 0);

    this.profile = d;
    this.computeProgress(prevLevel, prevStreak);
    this.applyIdentityVisuals('PROFILE');
    this.pushAudioHint();
    this.ui();
  }

  private async loadTotalSafe() {
    if (this.net.shouldPauseHeavyWork()) return;

    await this.safeHandshake();

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { total } = this.apiEndpoints();
    const res = await this.api.apiFetch<{ total: number }>(
      total,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 5200, dedupe: true, cacheTtlMs: 12_000, allowStaleOnError: true },
    );
    if (!res || res.status === 0) return;
    if (res.status === 401 || res.status === 403) return;

    if (res.visitorId && this.isSignedVid(res.visitorId)) this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    this.ui(() => {
      this.totalToday = Number((d as any).total ?? 0);
    });
  }

  private async loadInsightsSafe(force: boolean) {
    const now = Date.now();
    const last = Number(this.insights?._ts || 0);
    if (!force && now - last < 60_000) return;

    if (this.net.shouldPauseHeavyWork()) return;

    await this.safeHandshake();

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { insights } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitInsightsResponse>(
      insights,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 15_000, allowStaleOnError: true },
    );
    if (!res || res.status === 0) return;
    if (res.status === 401 || res.status === 403) return;

    if (res.visitorId && this.isSignedVid(res.visitorId)) this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    this.insights = { ...(d as any), _ts: now };
    this.deriveInsightsUI();
    this.pushAudioHint();
    this.ui();
  }

  /* ===================== Tips (Backend-first) ===================== */

  private mapSecurityTipToUiTip(st: SecurityTip, fallbackTopic: Topic): TipWithId {
    const topic = (String(st.topic || '').trim() as Topic) || fallbackTopic;

    const steps = String(st.texto || '')
      .split(/\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const tag0 = Array.isArray(st.tags) ? st.tags.find(Boolean) : undefined;
    const title = tag0 ? `${tag0}` : `Tip`;

    const tip: TipWithId = {
      id: String((st as any).id || (st as any)._id || '').trim(),
      topic,
      title,
      steps,

      // ✅ IMPORTANTE: guarde el nivel para poder mostrar “Dificultad”
      nivel: Number((st as any).nivel ?? 1) || 1,

      // (opcional) si luego lo quiere mostrar en UI
      tags: Array.isArray((st as any).tags) ? (st as any).tags : [],
      activo: (st as any).activo !== false,
    } as any;

    return tip;
  }

  private applyTip(tip: TipWithId, source: 'backend' | 'cache') {
    this.currentTip = tip;
    this.historyCount = this.storage.getTipHistoryIds().length;

    // cache RAM + persistencia sticky
    this.lastTipByTopic[this.topic] = tip;
    this.storage.setLastTipForTopic(this.topic, tip);

    // ✅ “fuente única” para historial/stats/mind/audio
    this.tipsSrv.registerTipShown(this.topic, tip as any);

    if (source === 'backend' && this.userInteracted) {
      navigator.vibrate?.(18);
    }
  }

  /** Devuelve true si logra obtener y aplicar un tip. */
  private async pickNewTipFromBackend(topic: Topic): Promise<boolean> {
    try {
      if (this.destroyed) return false;
      if (this.net.shouldPauseHeavyWork()) return false;

      await this.safeHandshake();

      const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
      if (this.isSignedVid(latest)) this.syncVisitorId(latest);
      if (!this.isSignedVid(this.visitorId)) return false;

      const res = await this.tipsApi.nextTip(this.PAGE_KEY, this.visitorId, topic);
      if (!res || res.status === 0) return false;
      if (res.status === 401 || res.status === 403) return false;

      if (res.visitorId && this.isSignedVid(res.visitorId)) this.syncVisitorId(res.visitorId);

      const st = res.data ?? null;
      if (!st?.id || !st?.texto) return false;

      const tip = this.mapSecurityTipToUiTip(st, topic);
      if (!this.getTipId(tip)) return false;

      this.applyTip(tip, 'backend');
      this.ui();
      return true;
    } catch {
      return false;
    }
  }

  private difficultyLabel(n: any): string {
    const nivel = Math.max(1, Number(n ?? 1));
    if (nivel === 1) return 'Básica';
    if (nivel === 2) return 'Intermedia';
    if (nivel === 3) return 'Avanzada';
    return 'Experta';
  }

  /* ===================== Emisión de eventos (alineado backend) ===================== */

  private async emitVisitEvent(type: VisitEventType, meta?: Record<string, any>): Promise<void> {
    await this.safeHandshake();

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    await this.sync.trackEvent(this.PAGE_KEY, {
      type,
      topic: this.topic,
      ref: meta?.['ref'] ?? null,
      meta: {
        ...(meta ?? {}),
        urlRef: this.ref,
      },
    });

    if (!this.sseAlive) {
      await this.loadMeSafe();
      await this.loadTotalSafe();
    }
  }

  /* ===================== Helpers existentes ===================== */

  private toast(msg: string) {
    this.toastMsg = msg;
    this.toastVisible = true;
    this.ui();

    if (this.tToast) clearTimeout(this.tToast);
    this.tToast = setTimeout(() => {
      this.toastVisible = false;
      this.ui();
    }, 1600);
  }

  private getTipId(tip: TipWithId | null): string {
    if (!tip) return '';
    const id = (tip as any).id ?? (tip as any)._id ?? '';
    return String(id || '').trim();
  }

  private formatTipForCopy(t: TipWithId): string {
    const title = (t as any).title ? `• ${(t as any).title}` : '• Tip';
    const steps = ((t as any).steps || [])
      .map((s: string, i: number) => `${i + 1}) ${s}`)
      .join('\n');
    return `${title}\n\n${steps}\n\nSystemBlacklem · Tips`;
  }

  private computeProgress(prevLevel?: number, prevStreak?: number) {
    const level = Math.max(1, Number((this.profile as any)?.level ?? 1));
    const xp = Math.max(0, Number((this.profile as any)?.xp ?? 0));
    const streak = Number((this.profile as any)?.streak ?? 0);

    const base = (level - 1) * 100;
    const inLevel = Math.max(0, xp - base);

    this.progress = {
      x: xp,
      nextLevel: level + 1,
      nextGoal: level * 100,
      pct: Math.min(100, Math.round((inLevel / 100) * 100)),
      left: Math.max(0, level * 100 - xp),
    };

    this.updateCardVisuals();

    if (typeof prevLevel === 'number' && level > prevLevel) {
      void this.audioSrv.sfx('LEVEL_UP', { strength: 1 });
    }
    if (typeof prevStreak === 'number' && streak > prevStreak) {
      void this.audioSrv.sfx('STREAK_UP', { strength: 0.95 });
    }
  }

  private deriveInsightsUI() {
    const ins = this.insights;

    const nice = (key: string) =>
      key === 'NEW_TIP'
        ? 'Nuevos tips'
        : key === 'TIP_VIEW'
          ? 'Vistos'
          : key === 'COPY_TIP'
            ? 'Copias'
            : key === 'SHARE_TIP'
              ? 'Compartidos'
              : key === 'TOPIC'
                ? 'Cambios tema'
                : '—';

    // =========================
    // Acciones (por tipo)
    // actionCountsLast7: [{ key: "COPY_TIP", value: 9 }, ...]
    // =========================
    const actions = Array.isArray(ins?.actionCountsLast7) ? ins!.actionCountsLast7.slice(0, 5) : [];
    this.actionRows = actions.map((a) => {
      const key = String((a as any)?.key ?? '').trim();
      const value = Number((a as any)?.value ?? 0) || 0;
      return { label: nice(key), value };
    });

    // =========================
    // Horas pico
    // peakHoursLast7: [{ key: "20:00", value: 85 }, ...]
    // =========================
    const hours = Array.isArray(ins?.peakHoursLast7) ? ins!.peakHoursLast7.slice(0, 5) : [];
    this.hourRows = hours.map((h) => {
      const key = String((h as any)?.key ?? '').trim();
      const value = Number((h as any)?.value ?? 0) || 0;
      return { key: key || '—', value };
    });

    // Labels de resumen
    this.peakHourLabel = this.hourRows[0]?.key ?? '—';
    this.topActionLabel = this.actionRows[0]?.label ?? '—';
    this.healthHint = this.actionRows.length ? 'Buen balance' : 'Inicie con 1 tip';
  }

  private refreshHeaderKpis() {
    this.headerKpis = [
      { icon: '👁️', label: 'Visitas', value: this.totalView },
      { icon: '', label: 'Online', value: String(this.onlineNow), kind: 'online' },
      { icon: '🔥', label: 'Racha', value: this.streakView },
      { icon: '⭐', label: 'Nivel', value: this.levelView },
    ];
  }

  private todayKey(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  private trackFlagKey(): string {
    return `${this.TRACK_FLAG_PREFIX}${this.PAGE_KEY}::${this.todayKey()}`;
  }

  private wasTrackedToday(): boolean {
    try {
      return sessionStorage.getItem(this.trackFlagKey()) === '1';
    } catch {
      return false;
    }
  }

  private markTrackedToday(): void {
    try {
      sessionStorage.setItem(this.trackFlagKey(), '1');
    } catch {}
  }

  private updateCardVisuals() {
    const pct = Number(this.progress?.pct ?? 0);
    const v = computeCardVisuals(this.profile, pct);

    this.cardTier = v.tier;
    this.cardSkinClass = v.skinClass;
    this.cardSigil = v.sigil;

    this.hostGlow = String(v.glow);
    this.syncHostClass();
  }

  private applyIdentityVisuals(
    reason: 'PROFILE' | 'PROGRESS' | 'ONLINE' | 'ACTION',
    actionType?: VisitEventType | 'SSE',
  ) {
    if (reason === 'PROFILE' || reason === 'PROGRESS') {
      this.updateCardVisuals();
      return;
    }

    if (reason === 'ONLINE') {
      this.cardState = this.sseAlive ? 'LISTEN' : 'IDLE';
      this.syncHostClass();
      return;
    }

    if (reason === 'ACTION' && actionType) {
      this.bumpCardState(actionType);
    }
  }

  private bumpCardState(kind: 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC' | 'SSE') {
    this.cardState = bumpToState(kind as BumpKind);
    this.syncHostClass();
    this.ui();

    if (this.tBumpReset) clearTimeout(this.tBumpReset);
    this.tBumpReset = setTimeout(() => {
      this.cardState = this.sseAlive ? 'LISTEN' : 'IDLE';
      this.syncHostClass();
      this.ui();
    }, 900);
  }

  private ui(fn?: () => void) {
    this.zone.run(() => {
      fn?.();
      this.refreshHeaderKpis();
      this.cdr.markForCheck();
    });
  }

  private buildProfileUI(visitorId: string) {
    const vid = String(visitorId || '').trim();

    this.profileLabel = 'Visitor';
    this.profileBadge = 'Perfil público';

    if (!vid) {
      this.visitorAlias = 'SB-ANON';
      this.avatarBg = 'linear-gradient(135deg, rgba(120,92,255,.45), rgba(0,255,209,.28))';
      this.avatarRing = 'rgba(255,255,255,.18)';
      this.updateCardVisuals();
      return;
    }

    this.visitorAlias = this.makeAlias(vid);
    this.updateCardVisuals();
  }

  private makeAlias(id: string): string {
    const raw = String(id || '').trim();

    const clean = raw
      .replace(/^Visitorv_?/i, '')
      .replace(/^Visitor_?/i, '')
      .replace(/^VID_?/i, '')
      .replace(/[^a-zA-Z0-9]/g, '');

    if (!clean) return 'SB-ANON';

    const a = clean.slice(0, 4).toUpperCase();
    const b = clean.slice(-4);
    return `SB-${a}·${b}`;
  }

  private pushAudioHint() {
    const mh = this.mind.getAudioHint();
    const mode = this.decision.mode;

    const focusScore = mode === 'FOCUS' ? Math.max(mh.focusScore, 0.85) : mh.focusScore;
    const stressScore =
      mode === 'REST'
        ? Math.min(1, mh.stressScore + 0.15)
        : mode === 'REDUCED'
          ? Math.min(1, mh.stressScore + 0.08)
          : mh.stressScore;

    this.audioSrv.setHint({
      sseAlive: this.sseAlive,
      onlineNow: this.onlineNow,
      mode,
      focusScore,
      stressScore,
    });
  }

  // trackBy
  trackByKpi = (_: number, k: { label: string; kind?: 'online' }) =>
    `${k.kind ?? 'kpi'}:${k.label}`;
  trackByStep = (i: number, s: string) => `${i}:${s}`;
  trackByAction = (_: number, a: { label: string }) => a.label;
  trackByHour = (_: number, h: Pair) => h.key;
}
