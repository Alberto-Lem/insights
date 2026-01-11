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

import { Tip, Topic, VisitInsightsResponse, VisitProfileResponse } from './models/models';
import { getRefFromUrl } from './utils/utils';
import { BumpKind, bumpToState, computeCardVisuals } from './ui/card-visuals';

type TipWithId = Tip & { id?: string };

type DecisionMode = 'NORMAL' | 'REDUCED' | 'REST' | 'FOCUS';
type VisitEventType = 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC';

type VisitDecisionResponse = {
  mode: DecisionMode;
  maxTipsAllowed: number;
  allowShare: boolean;
  allowNewTip: boolean;
  systemMessage: string;
};

const DEFAULT_DECISION: VisitDecisionResponse = {
  mode: 'NORMAL',
  maxTipsAllowed: 999,
  allowShare: true,
  allowNewTip: true,
  systemMessage: 'Sistema listo.',
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

  private storage = inject(StorageService);
  private tipsSrv = inject(TipsService);
  private api = inject(VisitsApiService);
  private fx = inject(CanvasFxService);
  private mind = inject(MindService);
  private audioSrv = inject(AudioService);

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

  private es?: EventSource;
  private lastSseTs = 0;

  private visitorId = '';
  private ref = 'direct';

  private tTrack?: ReturnType<typeof setInterval>;
  private tInsights?: ReturnType<typeof setInterval>;
  private tOnlinePoll?: ReturnType<typeof setInterval>;
  private tSseWatch?: ReturnType<typeof setInterval>;
  private tTotal?: ReturnType<typeof setInterval>;

  private mindSub?: Subscription;

  visitorAlias = 'SB-ANON';
  profileLabel = 'Visitor';
  profileBadge = 'Perfil público';

  avatarBg = 'linear-gradient(135deg, rgba(120,92,255,.45), rgba(0,255,209,.28))';
  avatarRing = 'rgba(255,255,255,.18)';

  cardTier: 'BRONZE' | 'SILVER' | 'GOLD' | 'NEBULA' = 'BRONZE';
  cardSkinClass = 'tier-bronze';
  cardSigil = '◎';
  cardState: 'IDLE' | 'LISTEN' | 'THINK' | 'SPEAK' = 'IDLE';

  private avatarSalt = 0;

  // ✅ control de reintentos SSE (backoff)
  private sseRetry = 0;
  private tSseRetry?: ReturnType<typeof setTimeout>;

  private syncHostClass() {
    const tier = this.cardSkinClass || 'tier-bronze';
    const state = `state-${(this.cardState || 'IDLE').toLowerCase()}`;
    this.hostClass = `appRoot ${tier} ${state}`;
  }

  get musicState() {
    return this.audioSrv.state;
  }

  get showAudioBanner() {
    return this.audioSrv.showBanner;
  }

  get musicLabel(): string {
    const s = this.musicState;
    return s === 'ON' ? '🔊 Audio: ON' : s === 'OFF' ? '🔇 Audio: OFF' : '🔊 Audio: AUTO';
  }

  get decisionLabel(): string {
    const m: DecisionMode = this.decision.mode;
    return m === 'FOCUS' ? 'FOCUS' : m === 'REST' ? 'REST' : m === 'REDUCED' ? 'REDUCED' : 'NORMAL';
  }

  get canNewTip(): boolean {
    return !!this.decision.allowNewTip;
  }

  get canShare(): boolean {
    return !!this.decision.allowShare;
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

  async copyVisitorId() {
    try {
      await navigator.clipboard.writeText(this.visitorIdFull);
      this.toast('✅ ID copiado');
      this.bumpCardState('COPY_TIP');
      void this.audioSrv.sfx('COPY');
    } catch {
      this.toast('⚠️ No se pudo copiar');
      void this.audioSrv.sfx('ERROR');
    }
  }

  ngOnInit(): void {
    this.ref = getRefFromUrl(location.href);

    // ✅ Fuente única de visitorId: Storage
    this.visitorId = this.storage.getVisitorId();
    this.buildProfileUI(this.visitorId);

    const prefs = this.storage.getPrefs();
    this.topic = (prefs.topic ?? 'seguridad') as Topic;
    this.historyCount = this.storage.getTipHistoryIds().length;

    // restaurar estado audio si existe
    const ms = (prefs as any)?.musicState;
    if (ms === 'ON' || ms === 'OFF' || ms === 'AUTO') this.audioSrv.state = ms;

    // ✅ Suscripción mente: controla FX + hint; evita duplicar ingest desde App
    this.mindSub = this.mind.observe().subscribe((state) => {
      this.fx.setMode(this.mind.getFxMode(state.mood));
      this.hint = this.mind.getToneLine(state, this.topic);

      if (!this.profileBadge || this.profileBadge === 'Perfil público') {
        this.profileBadge = 'Sistema activo';
      }

      this.pushAudioHint();
      this.ui();
    });

    // ✅ Topic inicial: centralice en TipsService
    this.tipsSrv.setTopic(this.topic);
    this.pickNewTip();

    this.updateCardVisuals();
    this.ui();
  }

  ngAfterViewInit(): void {
    if (this.fxCanvas?.nativeElement) {
      this.fx.bind(this.fxCanvas.nativeElement);
      this.fx.start();
    }

    // ✅ Solo desbloqueo para SFX
    this.audioSrv.installAutoKick(async () => {
      await this.audioSrv.sfx('APP_READY');
      this.ui();
    });

    void this.loadMe();
    void this.track();
    void this.loadTotal();
    void this.loadInsights(true);

    this.startRealtimeSse();

    this.tTrack = setInterval(() => void this.track(), 30_000);
    this.tInsights = setInterval(() => void this.loadInsights(false), 25_000);
    this.tTotal = setInterval(() => void this.loadTotal(), 20_000);

    // ✅ watchdog: si SSE queda “silencioso”, reconecte con backoff
    this.tSseWatch = setInterval(() => {
      if (!this.sseAlive) return;
      if (Date.now() - this.lastSseTs > 20_000) this.scheduleSseReconnect('watchdog');
    }, 10_000);
  }

  ngOnDestroy(): void {
    this.fx.stop();
    this.closeSse('destroy');

    this.mindSub?.unsubscribe();

    this.tTrack && clearInterval(this.tTrack);
    this.tInsights && clearInterval(this.tInsights);
    this.tOnlinePoll && clearInterval(this.tOnlinePoll);
    this.tSseWatch && clearInterval(this.tSseWatch);
    this.tTotal && clearInterval(this.tTotal);

    this.tSseRetry && clearTimeout(this.tSseRetry);

    this.audioSrv.destroy();
  }

  /* ===================== Actions ===================== */

  setTopic(t: Topic) {
    this.topic = t;
    this.persistPrefs();

    this.tipsSrv.setTopic(t);
    this.pickNewTip();

    this.bumpCardState('TOPIC');
    void this.sendEvent('TOPIC');

    this.applyIdentityVisuals('ACTION', 'TOPIC');
    this.pushAudioHint();
    this.ui();
  }

  onNewTip() {
    if (!this.canNewTip) {
      this.toast(this.decision.systemMessage || 'Acción limitada por el sistema.');
      void this.audioSrv.sfx('ERROR');
      return;
    }

    this.pickNewTip();

    this.bumpCardState('NEW_TIP');
    void this.sendEvent('NEW_TIP');

    this.applyIdentityVisuals('ACTION', 'NEW_TIP');
    this.pushAudioHint();
    this.ui();
  }

  async onCopy() {
    const tip = this.currentTip;
    const text = tip ? this.tipsSrv.toText(tip) : '';
    const ok = await this.copyText(text);

    this.toast(ok ? '✅ Copiado al portapapeles' : '⚠️ No se pudo copiar');

    if (tip) this.tipsSrv.copyTip(tip, ok);

    this.bumpCardState('COPY_TIP');
    this.applyIdentityVisuals('ACTION', 'COPY_TIP');
    await this.sendEvent('COPY_TIP');

    this.pushAudioHint();
    this.ui();
  }

  async onShare() {
    if (!this.canShare) {
      this.toast(this.decision.systemMessage || 'Compartir está limitado por el sistema.');
      void this.audioSrv.sfx('ERROR');
      return;
    }

    const tip = this.currentTip;
    const text = tip ? this.tipsSrv.toText(tip) : '';

    const ok = await this.shareNative(text);
    if (!ok) window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');

    if (tip) this.tipsSrv.shareTip(tip, ok, ok ? 'native' : 'wa');

    this.bumpCardState('SHARE_TIP');
    this.applyIdentityVisuals('ACTION', 'SHARE_TIP');
    await this.sendEvent('SHARE_TIP');

    this.pushAudioHint();
    this.ui();
  }

  /* ===================== Audio controls (SFX) ===================== */

  toggleMusic() {
    this.audioSrv.toggle();
    this.persistPrefs();
    this.ui();
  }

  async startMusic(_meta?: { userIntent?: boolean }) {
    await this.audioSrv.sfx('APP_READY');
    this.persistPrefs();
    this.ui();
  }

  stopMusic() {
    this.audioSrv.stop();
    this.persistPrefs();
    this.ui();
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

  /* ===================== Tip selection ===================== */

  private pickNewTip() {
    this.currentTip = this.tipsSrv.nextTip(this.topic) as TipWithId;
    this.historyCount = this.storage.getTipHistoryIds().length;
    navigator.vibrate?.(18);
  }

  private persistPrefs() {
    const prefs = this.storage.getPrefs();
    this.storage.setPrefs({ ...prefs, topic: this.topic, musicState: this.audioSrv.state });
  }

  /* ===================== Toast ===================== */

  private toast(msg: string) {
    this.toastMsg = msg;
    this.toastVisible = true;
    this.ui();

    setTimeout(() => {
      this.toastVisible = false;
      this.ui();
    }, 1400);
  }

  /* ===================== Progress ===================== */

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

  /* ===================== API helpers ===================== */

  private apiEndpoints() {
    return this.api.endpoints(this.PAGE_KEY, this.visitorId);
  }

  private syncVisitorId(newVid?: string) {
    if (!newVid) return;
    const v = String(newVid).trim();
    if (!v || v === this.visitorId) return;

    this.visitorId = v;
    this.storage.setVisitorId(v);
    this.buildProfileUI(v);
  }

  private async loadMe() {
    const { me } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitProfileResponse>(me, this.visitorId);
    if (!res) return;

    this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    const prevLevel = Number((this.profile as any)?.level ?? 0);
    const prevStreak = Number((this.profile as any)?.streak ?? 0);

    this.profile = d;
    this.computeProgress(prevLevel, prevStreak);

    this.applyIdentityVisuals('PROFILE');
    this.profileBadge = 'Perfil público';

    this.pushAudioHint();
    this.ui();
  }

  private async track() {
    const { track } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitProfileResponse>(track, this.visitorId);
    if (!res) return;

    this.syncVisitorId(res.visitorId);

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

  private async loadTotal() {
    const { total } = this.apiEndpoints();
    const res = await this.api.apiFetch<{ page?: string; total: number }>(total, this.visitorId);
    if (!res) return;

    this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    this.ui(() => {
      this.totalToday = Number(d.total ?? 0);
    });
  }

  private isValidType(t: string): t is VisitEventType {
    return t === 'NEW_TIP' || t === 'COPY_TIP' || t === 'SHARE_TIP' || t === 'TOPIC';
  }

  private async sendEvent(typeRaw: string) {
    const type = String(typeRaw ?? '').trim().toUpperCase();
    if (!this.isValidType(type)) return;

    const res = await this.api.sendEvent<VisitProfileResponse>(this.PAGE_KEY, {
      type,
      topic: this.topic ?? null,
      ref: this.ref ?? null,
    });

    if (!res) return;

    this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (d) {
      const prevLevel = Number((this.profile as any)?.level ?? 0);
      const prevStreak = Number((this.profile as any)?.streak ?? 0);

      this.profile = d;
      this.computeProgress(prevLevel, prevStreak);
      this.applyIdentityVisuals('PROGRESS', type);
    }

    // ✅ si el backend se satura, estos llamados pueden fallar: no debe romper UI
    void this.loadInsights(true);
    void this.loadTotal();

    this.pushAudioHint();
    this.ui();
  }

  private async loadInsights(force: boolean) {
    const now = Date.now();
    const last = Number(this.insights?._ts || 0);
    if (!force && now - last < 15_000) return;

    const { insights } = this.apiEndpoints();
    const res = await this.api.apiFetch<VisitInsightsResponse>(insights, this.visitorId);
    if (!res) return;

    this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    this.insights = { ...(d as any), _ts: now };
    this.deriveInsightsUI();

    this.pushAudioHint();
    this.ui();
  }

  /* ===================== trackBy ===================== */

  trackByKpi = (_: number, k: { label: string; kind?: 'online' }) => `${k.kind ?? 'kpi'}:${k.label}`;
  trackByAction = (_: number, a: { label: string }) => a.label;
  trackByHour = (_: number, h: { key: string }) => h.key;
  trackByStep = (i: number, s: string) => `${i}:${s}`;

  /* ===================== Timezone fix ===================== */

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
    this.actionRows = actions.map((a: any) => ({ label: nice(a.key), value: Number(a.value || 0) }));

    const hours = (ins?.peakHoursLast7 ?? []).slice(0, 5);
    this.hourRows = hours.map((h: any) => ({
      key: this.utcHourToLocalLabel(Number(h.key)),
      value: Number(h.value || 0),
    }));

    this.peakHourLabel = this.hourRows[0]?.key ?? '—';
    this.topActionLabel = this.actionRows[0]?.label ?? '—';
    this.healthHint = this.actionRows.length ? 'Buen balance' : 'Inicie con 1 tip';
  }

  /* ===================== SSE ===================== */

  private closeSse(_reason: string) {
    try {
      this.es?.close();
    } catch {}
    this.es = undefined;

    if (this.tOnlinePoll) clearInterval(this.tOnlinePoll);
    this.tOnlinePoll = undefined;

    if (this.tSseRetry) clearTimeout(this.tSseRetry);
    this.tSseRetry = undefined;
  }

  private scheduleSseReconnect(reason: 'error' | 'watchdog' | 'manual') {
    // ✅ evita reconectar en loop
    if (this.tSseRetry) return;

    this.sseRetry = Math.min(10, this.sseRetry + 1);
    const base = 900; // ms
    const max = 20_000;
    const wait = Math.min(max, Math.round(base * Math.pow(1.6, this.sseRetry)));

    this.ui(() => {
      this.sseAlive = false;
      this.profileBadge = reason === 'watchdog' ? 'SSE silencioso…' : 'Reconectando…';
      this.applyIdentityVisuals('ONLINE', 'SSE');
    });

    this.tipsSrv.sseDown();
    this.pushAudioHint();

    this.tSseRetry = setTimeout(() => {
      this.tSseRetry = undefined;
      this.startRealtimeSse();
    }, wait);
  }

  private async pollOnlineOnce(onlineUrl: string) {
    const res = await this.api.apiFetch<{ page?: string; online: number }>(onlineUrl, this.visitorId);
    if (!res) return;

    this.syncVisitorId(res.visitorId);

    const d = res.data ?? null;
    if (!d) return;

    this.ui(() => {
      this.onlineNow = Number(d.online ?? 0);
      this.applyIdentityVisuals('ONLINE', 'SSE');
    });

    void this.audioSrv.sfx('ONLINE_PULSE', { strength: Math.min(1, 0.25 + this.onlineNow / 50) });
    this.pushAudioHint();
  }

  private startRealtimeSse() {
    const { stream, online } = this.apiEndpoints();

    // ✅ reset UI + limpiar cosas anteriores
    this.closeSse('reconnect');

    this.ui(() => {
      this.sseAlive = false;
      this.lastSseTs = Date.now();
      this.profileBadge = 'Conectando SSE…';
      this.applyIdentityVisuals('ONLINE', 'SSE');
    });

    // ✅ si SSE falla, al menos mantener “online” por polling
    this.tOnlinePoll = setInterval(() => void this.pollOnlineOnce(online), 12_000);
    void this.pollOnlineOnce(online);

    const openSse = (this.api as any).openSse?.bind(this.api) as ((url: string) => EventSource) | undefined;
    this.es = openSse ? openSse(stream) : new EventSource(stream);

    const parse = (e: MessageEvent) => {
      try {
        return JSON.parse(String(e.data));
      } catch {
        return null;
      }
    };

    const markAlive = () => {
      this.lastSseTs = Date.now();
      if (!this.sseAlive) {
        this.sseAlive = true;
        this.sseRetry = 0; // ✅ éxito: reset backoff
      }
    };

    const markOkUi = () => {
      this.profileBadge = 'SSE OK';
      this.applyIdentityVisuals('ONLINE', 'SSE');
    };

    this.es.addEventListener('hello', (e: MessageEvent) => {
      const msg = parse(e) as any;

      this.ui(() => {
        markAlive();
        if (msg?.visitorId) this.syncVisitorId(String(msg.visitorId));
        if (msg?.online != null) this.onlineNow = Number(msg.online);
        markOkUi();
      });

      this.tipsSrv.sseUp();
      this.pushAudioHint();
    });

    this.es.addEventListener('ping', () => {
      this.ui(() => {
        markAlive();
        markOkUi();
      });
      this.pushAudioHint();
    });

    this.es.addEventListener('online', (e: MessageEvent) => {
      const msg = parse(e) as any;

      this.ui(() => {
        markAlive();
        if (msg?.online != null) this.onlineNow = Number(msg.online);
        this.applyIdentityVisuals('ONLINE', 'SSE');
      });

      void this.audioSrv.sfx('ONLINE_PULSE', { strength: Math.min(1, 0.25 + this.onlineNow / 50) });
      this.pushAudioHint();
    });

    this.es.addEventListener('profile', (e: MessageEvent) => {
      const p = parse(e) as VisitProfileResponse | null;
      if (!p) return;

      this.ui(() => {
        markAlive();
        const prevLevel = Number((this.profile as any)?.level ?? 0);
        const prevStreak = Number((this.profile as any)?.streak ?? 0);

        this.profile = p;
        this.computeProgress(prevLevel, prevStreak);
        this.applyIdentityVisuals('PROFILE');
      });

      this.pushAudioHint();
    });

    this.es.addEventListener('insights', (e: MessageEvent) => {
      const i = parse(e) as VisitInsightsResponse | null;
      if (!i) return;

      this.ui(() => {
        markAlive();
        this.insights = { ...(i as any), _ts: Date.now() };
        this.deriveInsightsUI();
      });

      this.pushAudioHint();
    });

    this.es.addEventListener('decision', (e: MessageEvent) => {
      const d = parse(e) as VisitDecisionResponse | null;
      if (!d) return;

      this.ui(() => {
        markAlive();
        this.decision = {
          mode: (d.mode ?? 'NORMAL') as DecisionMode,
          maxTipsAllowed: Number(d.maxTipsAllowed ?? 999),
          allowShare: !!d.allowShare,
          allowNewTip: !!d.allowNewTip,
          systemMessage: String(d.systemMessage ?? 'Sistema listo.'),
        };
      });

      this.pushAudioHint();
    });

    this.es.onerror = () => {
      this.ui(() => {
        this.sseAlive = false;
        this.profileBadge = 'SSE error…';
        this.applyIdentityVisuals('ONLINE', 'SSE');
      });

      this.tipsSrv.sseDown();
      this.pushAudioHint();

      // ✅ cierre y reconexión con backoff
      try {
        this.es?.close();
      } catch {}
      this.es = undefined;

      this.scheduleSseReconnect('error');
    };
  }

  /* ===================== Header KPIs ===================== */

  private refreshHeaderKpis() {
    this.headerKpis = [
      { icon: '👁️', label: 'Visitas', value: this.totalView },
      { icon: '', label: 'Online', value: String(this.onlineNow), kind: 'online' },
      { icon: '🔥', label: 'Racha', value: this.streakView },
      { icon: '⭐', label: 'Nivel', value: this.levelView },
    ];
  }

  /* ===================== Helpers ===================== */

  private async copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private async shareNative(text: string) {
    try {
      await (navigator as any).share?.({ text });
      return true;
    } catch {
      return false;
    }
  }

  /* ===================== Perfil visual ===================== */

  private buildProfileUI(visitorId: string) {
    const vid = String(visitorId || '').trim();
    if (!vid) return;

    this.visitorAlias = this.makeAlias(vid);
    this.profileLabel = 'Visitor';
    this.profileBadge = this.sseAlive ? 'SSE OK' : 'Sistema activo';

    const seed = `${vid}::${this.avatarSalt}`;
    const h = this.hash32(seed);

    const c1 = this.pickColor(h);
    const c2 = this.pickColor(this.hash32(seed + 'b'));
    this.avatarBg = `linear-gradient(135deg, ${c1}, ${c2})`;
    this.avatarRing = 'rgba(255,255,255,.22)';

    this.updateCardVisuals();
  }

  private makeAlias(id: string): string {
    const clean = (id || '').replace(/^Visitorv_?/i, '').replace(/[^a-zA-Z0-9]/g, '');
    if (!clean) return 'SB-ANON';
    const a = clean.slice(0, 4).toUpperCase();
    const b = clean.slice(-4);
    return `SB-${a}·${b}`;
  }

  private hash32(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  private pickColor(h: number): string {
    const palette = [
      'rgba(0,255,209,.40)',
      'rgba(120,92,255,.42)',
      'rgba(255,92,122,.38)',
      'rgba(255,214,120,.30)',
      'rgba(80,170,255,.38)',
      'rgba(180,120,255,.34)',
    ];
    return palette[h % palette.length];
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

    if (reason === 'ACTION' && actionType) {
      this.bumpCardState(actionType);
      return;
    }

    if (reason === 'ONLINE') {
      this.cardState = this.sseAlive ? 'LISTEN' : 'IDLE';
      this.syncHostClass();
    }
  }

  private bumpCardState(kind: 'NEW_TIP' | 'COPY_TIP' | 'SHARE_TIP' | 'TOPIC' | 'SSE') {
    this.cardState = bumpToState(kind as BumpKind);
    this.syncHostClass();
    this.ui();

    setTimeout(() => {
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
}
