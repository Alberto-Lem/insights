// src/app/core/mind.types.ts
import type { Topic } from '../models/models';

export type Emotion = 'calm' | 'curious' | 'focused' | 'tired' | 'stressed' | 'happy';

export type MoodFx = 'soft' | 'spark' | 'sharp' | 'low' | 'minimal' | 'confetti';

export type MindState = {
  mood: Emotion;
  energy: number;      // 0..100
  trust: number;       // 0..100
  curiosity: number;   // 0..100
  focus: number;       // 0..100
  lastUpdateTs: number;
};

export type MemoryEvent = {
  ts: number;
  type: string;
  topic: Topic;
  ok?: boolean;
  meta?: Record<string, any>;
};
