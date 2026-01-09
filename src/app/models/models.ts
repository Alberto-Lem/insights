// src/app/models/models.ts
export type Topic = 'seguridad' | 'estudio' | 'productividad' | 'bienestar';

export type Tip = {
  topic: Topic;
  title: string;
  steps: readonly string[];
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

// Esto le ayuda a tipar contadores sin error de index signature
export type CountsMap = Record<string, number>;
