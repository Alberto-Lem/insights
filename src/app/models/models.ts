// src/app/models/models.ts
export type Topic = 'seguridad' | 'estudio' | 'productividad' | 'bienestar';

export type Tip = {
  id: string;                 // ✅ nuevo
  topic: Topic;
  title: string;
  steps: readonly string[];
  tags?: readonly string[];   // ✅ nuevo (opcional)
};

export type Profile = {
  total?: number;
  streak?: number;
  level?: number;
  xp?: number;
};

export type Pair = { key: string; value: number };

export type Insights = {
  activeDaysLast7?: number;
  actionCountsLast7?: Pair[];
  peakHoursLast7?: Pair[];
  _ts?: number;
};

export type TipContext = {
  hour: number;          // 0-23
  day: number;           // 0-6 (Dom=0)
  isWeekend: boolean;
  bucket: 'morning' | 'afternoon' | 'evening' | 'night';
};

export type TipStat = {  // aprendizaje local por tip
  seen: number;
  copied: number;
  shared: number;
  lastSeen?: number;     // epoch ms
};

export type TipStatsMap = Record<string, TipStat>;
