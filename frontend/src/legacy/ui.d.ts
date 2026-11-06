// Tipos de las utilidades de interfaz compartidas (ui.js) que usan los componentes TypeScript.
export interface AccionModal {
  texto: string;
  clase?: string;
  id?: string;
  alHacerClic?: (ctx: { cerrar: () => void; modal: HTMLElement; boton: HTMLButtonElement }) => unknown | Promise<unknown>;
}
export interface OpcionesModal {
  titulo: string;
  cuerpo?: string | HTMLElement;
  acciones?: AccionModal[];
  ancho?: boolean;
  alMontar?: (el: HTMLElement, cerrar: () => void) => void;
  cerrable?: boolean;
}
export function modal(o: OpcionesModal): { el: HTMLElement; cerrar: () => void };
export function toast(mensaje: string, tipo?: '' | 'ok' | 'error' | string): void;
export function mostrarError(e: unknown): void;
export function esc(s: unknown): string;
export function icono(nombre: string, tam?: number): string;
export const ICONOS: Record<string, string>;
export function $(sel: string, root?: ParentNode): HTMLElement | null;
export function $$(sel: string, root?: ParentNode): HTMLElement[];
export function textoPolitica(): string;
export function validarClave(clave: string, usuario?: string): string;
export const fmt: Record<string, (v: unknown, ...resto: unknown[]) => string>;
export function hoyISO(d?: Date): string;
