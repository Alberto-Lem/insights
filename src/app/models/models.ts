// src/app/models/models.ts
export type Topic = 'seguridad' | 'estudio' | 'productividad' | 'bienestar';

export type Tip = {
  id: string;
  topic: Topic;
  title: string;
  steps: readonly string[];
  tags?: readonly string[];
};

export type TipContext = {
  hour: number;          // 0-23
  day: number;           // 0-6 (Dom=0)
  isWeekend: boolean;
  bucket: 'morning' | 'afternoon' | 'evening' | 'night';
};

export type Pair = { key: string; value: number };

export type TipStat = {
  seen: number;
  copied: number;
  shared: number;
  lastSeen?: number;
};

export type TipStatsMap = Record<string, TipStat>;

export type VisitProfileResponse = {
  page: string;
  totalTodayUnique: number;

  xp: number;
  level: number;
  streak: number;

  badges: string[];

  visitorId: string;
  dailyDay: string | null;

  dailyNewTip: number;
  dailyCopy: number;
  dailyShare: number;

  lastTopic: Topic | null;
  lastRef: string | null;
};

export type VisitInsightsResponse = {
  page: string;
  visitorId: string;
  activeDaysLast7: number;
  peakHoursLast7: Pair[];
  actionCountsLast7: Pair[];
  engagedSecondsLast7: number;
  sessionsLast7: number;
};

export type LinkIssueResponse = {
  page: string;
  code: string;
  ttlSec: number;
};

export type LinkConsumeResponse = {
  vid: string;
  exp: number;
};
