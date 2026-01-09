import { Tip } from '../../models/models';
import { SEGURIDAD_TIPS } from './seguridad.tips';
import { ESTUDIO_TIPS } from './estudio.tips';
import { PRODUCTIVIDAD_TIPS } from './productividad.tips';
import { BIENESTAR_TIPS } from './bienestar.tips';

export const TIPS: Tip[] = [
  ...SEGURIDAD_TIPS,
  ...ESTUDIO_TIPS,
  ...PRODUCTIVIDAD_TIPS,
  ...BIENESTAR_TIPS,
];
