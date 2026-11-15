/**
 * Tiles reales de Marte (Mars Trek / NASA JPL) para el cráter Dollfus, usados como
 * fondo del mapa con zoom continuo (libre, tipo Google Maps: sin niveles con nombre,
 * sin pan — sólo acercar/alejar hacia el centro).
 *
 * Esquema de tiles: WMTS EQ (equirectangular / Plate Carrée) de trek.nasa.gov.
 * ncols = 2^(z+1), nrows = 2^z; cada celda cubre (180/nrows)° tanto en lat como en lon.
 * Capas y zoom nativo máximo verificados por HTTP real contra trek.nasa.gov (no son un
 * supuesto): Viking color responde 200 hasta z=7, THEMIS gris hasta z=9; z+1 da 404.
 *
 * Para que el zoom se sienta continuo sin recargar tiles en cada tick de rueda, se
 * precargan unos pocos "escalones" de detalle (TIERS_KM, como los niveles de un mapa
 * de mosaicos/mipmap) y, entre escalón y escalón, sólo se recorta y escala la imagen
 * ya cargada — igual que un visor de mapas real mientras llegan los tiles nuevos.
 */

// Cráter Dollfus (IAU, 2013): 21.8°S, 4.3°W.
export const DOLLFUS_CENTER = { lat: -21.8, lon: -4.3 };

// Radio medio de Marte, para convertir grados de latitud a kilómetros.
const MARS_RADIUS_KM = 3389.5;
const KM_PER_DEG_LAT = (Math.PI / 180) * MARS_RADIUS_KM; // ≈ 59.15 km/°

// Cuántos grados de lat/lon cubre una vista de `spanKm` de ancho/alto centrada en
// Dollfus (la longitud se comprime por el coseno de la latitud, como corresponde
// a una proyección equirectangular real, no un supuesto).
export function degSpansForSpanKm(spanKm: number): { latSpanDeg: number; lonSpanDeg: number } {
  const latSpanDeg = spanKm / KM_PER_DEG_LAT;
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((DOLLFUS_CENTER.lat * Math.PI) / 180);
  const lonSpanDeg = spanKm / kmPerDegLon;
  return { latSpanDeg, lonSpanDeg };
}

export interface MarsLayerDef {
  layer: string;
  ext: 'jpg' | 'png';
  maxNativeZoom: number;
}

export const MARS_COLOR_LAYER: MarsLayerDef = {
  layer: 'Mars_Viking_MDIM21_ClrMosaic_global_232m',
  ext: 'jpg',
  maxNativeZoom: 7,
};

export const MARS_GRAY_LAYER: MarsLayerDef = {
  layer: 'THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018',
  ext: 'png',
  maxNativeZoom: 9,
};

// Escalones de detalle precargados (de más amplio a más cercano). 150 km sigue
// siendo el span de REFERENCIA: ahí el cuadrado sintético 0..10 del mapa se ancla a
// esa extensión real (así los marcadores no cambiaron de lugar), pero la vista
// arranca en el escalón más amplio (250 km) para verse más alejada por defecto, y
// el zoom todavía puede alejarse hasta ahí con el botón "−" / rueda hacia abajo.
export const TIERS_KM = [250, 150, 30, 6, 1.2];
export const REFERENCE_SPAN_KM = 150;
export const DEFAULT_SPAN_KM = TIERS_KM[0];
export const MAX_SPAN_KM = TIERS_KM[0];
export const MIN_SPAN_KM = 0.4; // más cerca que el escalón más detallado: se recorta/amplía ese tile
export const ZOOM_STEP_FACTOR = 1.35; // multiplicador por tick de rueda / clic en +/-

// Escoge el escalón precargado más detallado que todavía cubre el span pedido.
export function activeTierForSpan(spanKm: number): number {
  for (let i = TIERS_KM.length - 1; i >= 0; i--) {
    if (TIERS_KM[i] >= spanKm) return TIERS_KM[i];
  }
  return TIERS_KM[TIERS_KM.length - 1];
}

// Cuánto hay que recortar/ampliar el escalón cargado para mostrar exactamente el
// span actual (1 = se ve completo; <1 = recorte centrado, zoom más cercano que el
// escalón nativo, igual que "sobre-acercar" más allá de la resolución de un tile).
export function bgCropFractionFor(spanKm: number, tierSpanKm: number): number {
  return Math.min(1, spanKm / tierSpanKm);
}

// Factor de escala para reproyectar marcadores (EVA-01, Destino, obstáculos, paradas,
// ruta) desde el cuadrado sintético 0..10 hacia pantalla: a REFERENCE_SPAN_KM es 1
// (igual que antes de tener zoom), y crece al acercarse — como con cualquier pin real
// de un mapa, que se aleja del centro al hacer zoom si no se mueve la vista (sin pan).
export function zoomScaleFor(spanKm: number): number {
  return REFERENCE_SPAN_KM / spanKm;
}

// Misma reproyección que usa mapCanvasRenderer, pero como fracción 0..1 del lienzo
// (no en píxeles): la usan los overlays en HTML (formulario de parada, popup) para
// quedar alineados con lo que dibuja el canvas. Centrado en 0.5, sin pan.
export function projectFrac(valueM: number, totalM: number, zoomScale: number): number {
  return 0.5 + (valueM / totalM - 0.5) * zoomScale;
}

// Inversa de projectFrac: de una fracción de pantalla (p.ej. de un clic) de vuelta a
// la coordenada del espacio sintético 0..totalM.
export function unprojectFrac(frac: number, totalM: number, zoomScale: number): number {
  return totalM * ((frac - 0.5) / zoomScale + 0.5);
}

// Mezcla color (Viking, contexto amplio) / gris (THEMIS, detalle) según qué tan
// cerca está el span actual: completamente color a 60 km o más, completamente gris
// a 6 km o menos, mezcla lineal entre esos dos puntos.
export function colorGrayMixForSpan(spanKm: number): { colorOpacity: number; grayOpacity: number } {
  const COLOR_FULL_KM = 60;
  const GRAY_FULL_KM = 6;
  if (spanKm >= COLOR_FULL_KM) return { colorOpacity: 1, grayOpacity: 0 };
  if (spanKm <= GRAY_FULL_KM) return { colorOpacity: 0, grayOpacity: 1 };
  const t = (spanKm - GRAY_FULL_KM) / (COLOR_FULL_KM - GRAY_FULL_KM); // 0 (gris) .. 1 (color)
  return { colorOpacity: t, grayOpacity: 1 - t };
}

interface TileCoord {
  z: number;
  row: number;
  col: number;
  ncols: number;
  nrows: number;
}

function eqTileForLatLon(lat: number, lon: number, z: number): TileCoord {
  const ncols = 2 ** (z + 1);
  const nrows = 2 ** z;
  const col = Math.min(ncols - 1, Math.max(0, Math.floor(((lon + 180) / 360) * ncols)));
  const row = Math.min(nrows - 1, Math.max(0, Math.floor(((90 - lat) / 180) * nrows)));
  return { z, row, col, ncols, nrows };
}

function tileUrl(def: MarsLayerDef, z: number, row: number, col: number): string {
  return `https://trek.nasa.gov/tiles/Mars/EQ/${def.layer}/1.0.0//default/default028mm/${z}/${row}/${col}.${def.ext}`;
}

// Zoom "efectivo" para una capa dado el span deseado: más cerca ⇒ z más alto, pero
// nunca por encima de maxNativeZoom (de ahí para más cerca sólo recortamos/ampliamos).
function zoomForSpanKm(spanKm: number, maxNativeZoom: number): number {
  for (let z = maxNativeZoom; z >= 0; z--) {
    const nrows = 2 ** z;
    const tileSpanKm = (180 / nrows) * KM_PER_DEG_LAT;
    if (tileSpanKm <= spanKm * 1.6) return z;
  }
  return 0;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar el tile: ${url}`));
    img.src = url;
  });
}

const tileImageCache = new Map<string, Promise<HTMLImageElement>>();

function loadTileCached(url: string): Promise<HTMLImageElement> {
  let cached = tileImageCache.get(url);
  if (!cached) {
    cached = loadImage(url);
    tileImageCache.set(url, cached);
  }
  return cached;
}

// Dibuja, sobre un canvas de salida, el mosaico 3x3 de tiles alrededor del centro
// para la capa dada, al zoom correspondiente al span solicitado.
async function paintLayerMosaic(
  ctx: CanvasRenderingContext2D,
  size: number,
  def: MarsLayerDef,
  spanKm: number,
  alpha: number
): Promise<void> {
  if (alpha <= 0) return;

  const z = zoomForSpanKm(spanKm, def.maxNativeZoom);
  const center = eqTileForLatLon(DOLLFUS_CENTER.lat, DOLLFUS_CENTER.lon, z);
  const nrows = 2 ** z;
  const tileSpanKm = (180 / nrows) * KM_PER_DEG_LAT;
  // Cuántos tiles vecinos stitchear para cubrir el span pedido con margen.
  const reach = Math.max(1, Math.ceil(spanKm / tileSpanKm / 2) + 1);

  const tilePx = size / (spanKm / tileSpanKm);

  const loads: Array<Promise<void>> = [];
  for (let dr = -reach; dr <= reach; dr++) {
    for (let dc = -reach; dc <= reach; dc++) {
      const row = center.row + dr;
      const col = ((center.col + dc) % center.ncols + center.ncols) % center.ncols;
      if (row < 0 || row >= center.nrows) continue;
      const url = tileUrl(def, z, row, col);
      loads.push(
        loadTileCached(url)
          .then((img) => {
            const cx = size / 2 + dc * tilePx;
            const cy = size / 2 + dr * tilePx;
            ctx.globalAlpha = alpha;
            ctx.drawImage(img, cx - tilePx / 2, cy - tilePx / 2, tilePx + 0.6, tilePx + 0.6);
            ctx.globalAlpha = 1;
          })
          .catch(() => {
            /* tile individual no disponible: se deja el hueco, no rompe el mosaico */
          })
      );
    }
  }
  await Promise.all(loads);
}

export interface MarsMosaicResult {
  dataUrl: string;
  spanKm: number;
}

/**
 * Construye (o recupera de caché) la imagen de fondo real para un escalón de
 * TIERS_KM, mezclando la capa color y la capa gris según qué tan cerca está ese
 * escalón. Lanza si ningún tile pudo cargarse (para que el llamador use el
 * respaldo estático).
 */
const mosaicCache = new Map<string, Promise<MarsMosaicResult>>();

export function buildMarsMosaic(tierSpanKm: number, size = 1024): Promise<MarsMosaicResult> {
  const key = `${tierSpanKm}_${size}`;
  let cached = mosaicCache.get(key);
  if (cached) return cached;

  const { colorOpacity, grayOpacity } = colorGrayMixForSpan(tierSpanKm);

  cached = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear el canvas del mosaico de Marte');

    ctx.fillStyle = '#1a1410';
    ctx.fillRect(0, 0, size, size);

    const mid = Math.floor(size / 2);
    const before = ctx.getImageData(mid, mid, 1, 1).data;

    await paintLayerMosaic(ctx, size, MARS_COLOR_LAYER, tierSpanKm, colorOpacity);
    await paintLayerMosaic(ctx, size, MARS_GRAY_LAYER, tierSpanKm, grayOpacity);

    const after = ctx.getImageData(mid, mid, 1, 1).data;
    const anyLoaded = before.join(',') !== after.join(',');

    if (!anyLoaded) {
      throw new Error('No se pudo cargar ningún tile real de Mars Trek para este escalón');
    }

    return { dataUrl: canvas.toDataURL('image/jpeg', 0.92), spanKm: tierSpanKm };
  })();

  mosaicCache.set(key, cached);
  return cached;
}
