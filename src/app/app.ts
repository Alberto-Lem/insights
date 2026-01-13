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
import { VisitsApiService } from './service/visits-api.service';
import { CanvasFxService } from './service/canvas-fx.service';
import { MindService } from './service/mind.service';
import { AudioService } from './service/audio.service';
import { OfflineSyncService } from './service/offline-sync.service';
import { ConnectivityService } from './service/connectivity.service';
import { SseService, VisitDecisionResponse } from './service/sse.service';

import { Tip, Topic, VisitInsightsResponse, VisitProfileResponse } from './models/models';
import { getRefFromUrl } from './utils/utils';
import { BumpKind, bumpToState, computeCardVisuals } from './ui/card-visuals';

type TipWithId = Tip & { id?: string; _id?: string };
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

  private readonly TRACK_FLAG_PREFIX = 'sb_tracked_today::';

  /* ===================== View helpers ===================== */

  private syncHostClass() {
    const tier = this.cardSkinClass || 'tier-bronze';
    const state = `state-${(this.cardState || 'IDLE').toLowerCase()}`;
    this.hostClass = `appRoot ${tier} ${state}`;
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

    // ✅ Copiar SOLO un identificador público seguro (alias), NO el token firmado
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

      // ✅ Evento correcto (no COPY_TIP)
      this.mind.ingest('COPY_VISITOR_ID', this.topic, true, {
        what: 'publicVisitorId',
        value: safeId,
      });
    } catch (e: any) {
      // Fallback por si clipboard falla (Safari/permiso)
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

  /** Fallback clásico (cuando navigator.clipboard no está disponible o falla). */
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

    // ✅ gesto real: desbloquea audio aquí
    await this.audioSrv.userKick();

    this.toast(`Audio: ${next}`);
    this.mind.ingest('SESSION_TICK', this.topic, true, { music: next, seconds: 2 });
    this.ui();
  }

  async setTopic(t: Topic): Promise<void> {
    this.userInteracted = true;

    const next = (t || '').toString().trim() as Topic;
    if (!next) return;

    this.topic = next;
    this.tipsSrv.setTopic(next);

    const prefs = this.storage.getPrefs();
    this.storage.setPrefs({ ...prefs, topic: next });

    // ✅ emitir al backend (cola + envío)
    await this.emitVisitEvent('TOPIC', { topic: next });

    this.pickNewTip();
    this.bumpCardState('TOPIC');
    this.ui();
  }

  async onNewTip(): Promise<void> {
    this.userInteracted = true;

    if (!this.canNewTip) {
      this.toast('Acción limitada por el modo actual.');
      return;
    }

    this.pickNewTip();
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

      // ✅ stats/mind/audio: TipsService es fuente única
      this.tipsSrv.copyTip(tip as any, true);

      await this.emitVisitEvent('COPY_TIP', { ref: tipId });

      this.bumpCardState('COPY_TIP');
      this.ui();
    } catch (e) {
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

    // ✅ type-guard correcto (evita TS2774)
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

      // ✅ 1 sola fuente para stats/mind/audio
      this.tipsSrv.shareTip(tip as any, true, channel);

      // ✅ backend aligned
      await this.emitVisitEvent('SHARE_TIP', { ref: tipId });

      this.bumpCardState('SHARE_TIP');
      this.ui();
    } catch (e) {
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

    this.mindSub = this.mind.observe().subscribe((state) => {
      this.fx.setMode(this.mind.getFxMode(state.mood));
      this.hint = this.mind.getToneLine(state, this.topic);
      this.pushAudioHint();
      this.ui();
    });

    // SSE estado
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

    // ✅ NUEVO: streams de backend (profile/insights/decision/total)
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
    this.pickNewTip();

    this.updateCardVisuals();
    this.ui();
  }

  async ngAfterViewInit(): Promise<void> {
    if (this.fxCanvas?.nativeElement) {
      this.fx.bind(this.fxCanvas.nativeElement);
      this.fx.start();
    }

    // Handshake único
    await this.sync.handshakeAndFlush(this.PAGE_KEY);

    this.visitorId = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    this.buildProfileUI(this.visitorId);

    if (!this.isSignedVid(this.visitorId)) {
      this.profileBadge = 'Sesión inválida (VID no firmado)';
      this.ui();
      return;
    }

    // Track una vez por día
    if (!this.wasTrackedToday()) {
      await this.trackSafe();
      this.markTrackedToday();
    }

    // Cargas iniciales (si SSE tarda)
    await this.loadMeSafe();
    await this.loadTotalSafe();
    await this.loadInsightsSafe(true);

    // SSE
    this.sse.start(this.PAGE_KEY);

    // ✅ Timers reducidos (evita saturar backend)
    this.tMe = setInterval(() => void this.loadMeSafe(), 55_000);
    this.tInsights = setInterval(() => void this.loadInsightsSafe(false), 90_000);
    this.tTotal = setInterval(() => void this.loadTotalSafe(), 60_000);
    this.tFlush = setInterval(() => void this.sync.handshakeAndFlush(this.PAGE_KEY), 70_000);

    this.ui();
  }

  ngOnDestroy(): void {
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

  private async loadMeSafe() {
    if (this.net.shouldPauseHeavyWork()) return;

    // si backend está en DEGRADED, reduzca agresividad
    if (this.net.isDegraded()) {
      // no bloquea, solo evita loops de mucha frecuencia
    }

    await this.sync.handshakeAndFlush(this.PAGE_KEY);

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { me } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitProfileResponse>(
      me,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 12_000, allowStaleOnError: true }
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

    await this.sync.handshakeAndFlush(this.PAGE_KEY);

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { track } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitProfileResponse>(
      track,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 0, allowStaleOnError: false }
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

    await this.sync.handshakeAndFlush(this.PAGE_KEY);

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { total } = this.apiEndpoints();
    const res = await this.api.apiFetch<{ total: number }>(
      total,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 5200, dedupe: true, cacheTtlMs: 12_000, allowStaleOnError: true }
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

    await this.sync.handshakeAndFlush(this.PAGE_KEY);

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    const { insights } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitInsightsResponse>(
      insights,
      this.visitorId,
      { method: 'GET' },
      { timeoutMs: 6500, dedupe: true, cacheTtlMs: 15_000, allowStaleOnError: true }
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

  /* ===================== Emisión de eventos (alineado backend) ===================== */

  private async emitVisitEvent(type: VisitEventType, meta?: Record<string, any>): Promise<void> {
    await this.sync.handshakeAndFlush(this.PAGE_KEY);

    const latest = String(this.storage.getVisitorId(this.PAGE_KEY) || '').trim();
    if (this.isSignedVid(latest)) this.syncVisitorId(latest);
    if (!this.isSignedVid(this.visitorId)) return;

    // ✅ única vía: OfflineSyncService.trackEvent
    await this.sync.trackEvent(this.PAGE_KEY, {
      type,
      topic: this.topic,
      ref: meta?.['ref'] ?? null,
      meta: { ...(meta ?? {}), ref: this.ref }, // ref de URL
    });

    // fallback pull suave (si SSE no responde)
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

  private pickNewTip() {
    this.currentTip = this.tipsSrv.nextTip(this.topic) as TipWithId;
    this.historyCount = this.storage.getTipHistoryIds().length;
    if (this.userInteracted) navigator.vibrate?.(18);
  }

  private getTipId(tip: TipWithId | null): string {
    if (!tip) return '';
    const id = (tip as any).id ?? (tip as any)._id ?? '';
    return String(id || '').trim();
  }

  private formatTipForCopy(t: TipWithId): string {
    const title = t.title ? `• ${t.title}` : '• Tip';
    const steps = (t.steps || []).map((s, i) => `${i + 1}) ${s}`).join('\n');
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

  private utcHourToLocalLabel(utcHour: number): string {
    const d = new Date(Date.UTC(2024, 0, 1, utcHour, 0, 0));
    const localHour = d.getHours();
    return String(localHour).padStart(2, '0') + ':00';
  }

  private deriveInsightsUI() {
    const ins = this.insights;

    const nice = (k: string) =>
      k === 'NEW_TIP'
        ? 'Nuevos tips'
        : k === 'COPY_TIP'
        ? 'Copias'
        : k === 'SHARE_TIP'
        ? 'Compartidos'
        : k === 'TOPIC'
        ? 'Cambios tema'
        : '—';

    const actions = (ins?.actionCountsLast7 ?? []).slice(0, 5);
    this.actionRows = actions.map((a: any) => ({
      label: nice(a.key),
      value: Number(a.value || 0),
    }));

    const hours = (ins?.peakHoursLast7 ?? []).slice(0, 5);
    this.hourRows = hours.map((h: any) => ({
      key: this.utcHourToLocalLabel(Number(h.key)),
      value: Number(h.value || 0),
    }));

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
    actionType?: VisitEventType | 'SSE'
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
      this.cardState = 'IDLE';
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

    // ✅ Perfil = identidad; no mezcla “modo”, “sse” ni sistema
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

    // ✅ Limpieza robusta: quita prefijos y deja alfanumérico
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
  trackByHour = (_: number, h: { key: string }) => h.key;
}
