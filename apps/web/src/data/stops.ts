/**
 * Paradas científicas: puntos de interés que el usuario agrega sobre el mapa
 * con clic derecho (hasta MAX_STOPS). No vienen precargadas: se crean en vivo
 * desde la interfaz, así que este archivo solo define la forma del dato.
 *
 * xm / ym están en el mismo espacio de "metros" sintéticos que usa el resto
 * del mapa (0..10, igual que EVA-01, Destino y el Dron).
 */
export interface ScientificStop {
  id: string;
  number: number; // 1..4, en el orden en que se agregaron
  name: string;
  objective: string; // objetivo científico en una línea
  xm: number;
  ym: number;
}

export const MAX_STOPS = 4;
