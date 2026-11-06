// Formato colombiano tipado (reexporta las utilidades compartidas con las pantallas heredadas).
import { fmt as fmtJs, hoyISO as hoyISOJs } from '../legacy/ui.js';

interface Formato {
  cop(n: unknown): string; usd(n: unknown): string; num(n: unknown): string; pct(n: unknown): string;
  fecha(t: unknown): string; fechaHora(t: unknown): string;
}
export const fmt = fmtJs as unknown as Formato;
export const hoyISO = hoyISOJs as (d?: Date) => string;
export const plural = (n: number, uno: string, varios: string): string => `${fmt.num(n)} ${n === 1 ? uno : varios}`;
