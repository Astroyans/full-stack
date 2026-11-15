/**
 * Vista global de Marte: proyección ortográfica dibujada en un canvas 2D (sin
 * librerías 3D). La textura es el mosaico a color Viking de Mars Trek en su
 * esquema equirectangular (EQ), armada con los tiles reales de z=2 (8 × 4 tiles).
 *
 * La transición con el mapa local es continua: el radio del globo en pantalla se
 * calcula con el mismo "span" (km que cubre la vista en vertical) que usa el mapa
 * plano, así que a 250 km el globo coincide con el mapa de Dollfus y, al alejarse,
 * el planeta completo aparece poco a poco.
 */
import { DOLLFUS_CENTER, loadTileCached, MARS_COLOR_LAYER, MAX_SPAN_KM, tileUrl } from './marsTiles';

export const MARS_RADIUS_KM = 3389.5;

// Span máximo (km en vertical): el disco completo ocupa ~80 % del alto del mapa.
export const GLOBE_MAX_SPAN_KM = 8600;

// Entre MAX_SPAN_KM (250 km, último nivel del mapa plano) y este span el globo
// aparece por encima del mapa plano (fundido).
const GLOBE_FADE_END_KM = 420;

// Entre estos spans el globo pasa de "centrado en Dollfus" a "girable libremente".
const GLOBE_FREE_START_KM = 420;
const GLOBE_FREE_END_KM = 2600;

// Latitud del centro de la vista cuando el planeta se ve completo (inclinación leve
// hacia el sur para que el sitio de la misión siga a la vista).
const GLOBE_FULL_VIEW_LAT = -12;

const DEG = Math.PI / 180;

export interface GlobeTexture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  isFallback: boolean;
}

export interface GlobeView {
  lat0: number;
  lon0: number;
  radiusPx: number;
  cx: number;
  cy: number;
}

export interface MarsRegionLabel {
  name: string;
  lat: number;
  lon: number;
}

// Coordenadas IAU (longitud este positiva, −180..180), igual que los tiles EQ de Mars Trek.
export const MARS_REGION_LABELS: MarsRegionLabel[] = [
  { name: 'Olympus Mons', lat: 18.65, lon: -133.8 },
  { name: 'Tharsis Montes', lat: 1.5, lon: -112.5 },
  { name: 'Valles Marineris', lat: -13.9, lon: -59.2 },
  { name: 'Argyre Planitia', lat: -49.7, lon: -43.4 },
  { name: 'Hellas Planitia', lat: -42.4, lon: 70.5 },
  { name: 'Syrtis Major', lat: 8.4, lon: 69.5 },
  { name: 'Elysium Mons', lat: 25.0, lon: 147.2 },
  { name: 'Utopia Planitia', lat: 46.7, lon: 117.5 },
  { name: 'Cráter Gale', lat: -5.4, lon: 137.8 },
  { name: 'Acidalia Planitia', lat: 46.7, lon: -22.0 },
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(v: number): number {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function logProgress(span: number, from: number, to: number): number {
  return (Math.log(span) - Math.log(from)) / (Math.log(to) - Math.log(from));
}

export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Opacidad del globo sobre el mapa plano (0 = sólo mapa plano). */
export function globeOpacityForSpan(spanKm: number): number {
  if (spanKm <= MAX_SPAN_KM) return 0;
  return smoothstep((spanKm - MAX_SPAN_KM) / (GLOBE_FADE_END_KM - MAX_SPAN_KM));
}

/** 0 = centrado en Dollfus, 1 = el usuario controla la longitud por completo. */
export function globeFreedomForSpan(spanKm: number): number {
  if (spanKm <= GLOBE_FREE_START_KM) return 0;
  return smoothstep(logProgress(spanKm, GLOBE_FREE_START_KM, GLOBE_FREE_END_KM));
}

export function computeGlobeView(
  spanKm: number,
  userLon: number,
  width: number,
  height: number
): GlobeView {
  const freedom = globeFreedomForSpan(spanKm);
  const lat0 = DOLLFUS_CENTER.lat + (GLOBE_FULL_VIEW_LAT - DOLLFUS_CENTER.lat) * freedom;
  const lon0 = wrapLon(DOLLFUS_CENTER.lon + wrapLon(userLon - DOLLFUS_CENTER.lon) * freedom);
  return {
    lat0,
    lon0,
    // Mismo criterio que el mapa plano: `spanKm` es lo que cubre la vista en vertical.
    radiusPx: (height * MARS_RADIUS_KM) / spanKm,
    cx: width / 2,
    cy: height / 2,
  };
}

/** Proyección ortográfica directa. Devuelve null si el punto está en la cara oculta. */
export function projectLatLon(
  lat: number,
  lon: number,
  view: GlobeView
): { x: number; y: number; cosC: number } | null {
  const phi = lat * DEG;
  const phi0 = view.lat0 * DEG;
  const dLon = (lon - view.lon0) * DEG;
  const cosC = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dLon);
  if (cosC <= 0) return null;
  const x = view.radiusPx * Math.cos(phi) * Math.sin(dLon);
  const y =
    view.radiusPx *
    (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dLon));
  return { x: view.cx + x, y: view.cy - y, cosC };
}

/** Proyección inversa: de un punto de pantalla a lat/lon (null si cae fuera del disco). */
export function unprojectToLatLon(
  sx: number,
  sy: number,
  view: GlobeView
): { lat: number; lon: number } | null {
  const x = (sx - view.cx) / view.radiusPx;
  const y = (view.cy - sy) / view.radiusPx;
  const rho2 = x * x + y * y;
  if (rho2 > 1) return null;
  const z = Math.sqrt(1 - rho2);
  const phi0 = view.lat0 * DEG;
  const lat = Math.asin(Math.max(-1, Math.min(1, z * Math.sin(phi0) + y * Math.cos(phi0)))) / DEG;
  const lon = view.lon0 + Math.atan2(x, z * Math.cos(phi0) - y * Math.sin(phi0)) / DEG;
  return { lat, lon: wrapLon(lon) };
}

// ---------------------------------------------------------------------------
// Textura global
// ---------------------------------------------------------------------------

// z=3 ⇒ 16 × 8 tiles de 256 px = 4096 × 2048 (≈ 5 km/px en el ecuador). Antes z=2
// (2048×1024, ≈10 km/px) se veía borroso al acercarse al disco completo; Mars Trek
// soporta esta capa hasta z=7, así que hay margen real de detalle sin usar fallback.
const GLOBE_TILE_Z = 3;
const TILE_PX = 256;

function buildFallbackTexture(): GlobeTexture {
  // Respaldo sin red: ocre marciano con variaciones suaves de albedo por latitud y
  // ruido determinista (no pretende ser geografía real).
  const width = 512;
  const height = 256;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const lat = 90 - (y / height) * 180;
    const polar = clamp01((Math.abs(lat) - 72) / 12);
    for (let x = 0; x < width; x++) {
      const n =
        Math.sin(x * 0.045) * Math.cos(y * 0.07) * 0.5 +
        Math.sin((x + y) * 0.019) * 0.35 +
        Math.cos(x * 0.11 - y * 0.05) * 0.15;
      const base = 0.78 + n * 0.14;
      const i = (y * width + x) * 4;
      data[i] = (178 * base) * (1 - polar) + 225 * polar;
      data[i + 1] = (102 * base) * (1 - polar) + 220 * polar;
      data[i + 2] = (62 * base) * (1 - polar) + 214 * polar;
      data[i + 3] = 255;
    }
  }
  return { width, height, data, isFallback: true };
}

let globeTexturePromise: Promise<GlobeTexture> | null = null;

export function loadGlobeTexture(): Promise<GlobeTexture> {
  if (globeTexturePromise) return globeTexturePromise;

  globeTexturePromise = (async () => {
    const ncols = 2 ** (GLOBE_TILE_Z + 1);
    const nrows = 2 ** GLOBE_TILE_Z;
    const width = ncols * TILE_PX;
    const height = nrows * TILE_PX;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return buildFallbackTexture();

    ctx.fillStyle = '#8a5236';
    ctx.fillRect(0, 0, width, height);

    let loaded = 0;
    const jobs: Array<Promise<void>> = [];
    for (let row = 0; row < nrows; row++) {
      for (let col = 0; col < ncols; col++) {
        const url = tileUrl(MARS_COLOR_LAYER, GLOBE_TILE_Z, row, col);
        jobs.push(
          loadTileCached(url)
            .then((img) => {
              ctx.drawImage(img, col * TILE_PX, row * TILE_PX, TILE_PX, TILE_PX);
              loaded++;
            })
            .catch(() => {
              /* tile faltante: queda el color base */
            })
        );
      }
    }
    await Promise.all(jobs);

    if (loaded === 0) return buildFallbackTexture();

    try {
      const img = ctx.getImageData(0, 0, width, height);
      return { width, height, data: img.data, isFallback: false };
    } catch {
      // Canvas "contaminado" por CORS: no se pueden leer los píxeles.
      return buildFallbackTexture();
    }
  })();

  return globeTexturePromise;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

let bufferCanvas: HTMLCanvasElement | null = null;
let bufferImage: ImageData | null = null;

// Luz desde arriba a la izquierda, ligeramente hacia el observador.
const LIGHT = (() => {
  const v = [-0.42, 0.38, 0.82];
  const len = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / len);
})();

/**
 * Dibuja el disco del planeta en `ctx` (tamaño width × height). El muestreo por
 * píxel se hace a resolución completa para que se vea nítido (antes siempre a la
 * mitad, lo que sumado al reescalado del canvas por CSS lo dejaba borroso); sólo
 * baja a media resolución mientras `fast` está activo (arrastrando para girar),
 * para mantener la interacción fluida, igual que un visor 3D real.
 */
export function renderMarsGlobe(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  texture: GlobeTexture | null,
  view: GlobeView,
  fast: boolean = false
): void {
  ctx.clearRect(0, 0, width, height);

  // Fondo espacial
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, width, height);
  drawStars(ctx, width, height);

  if (!texture) return;

  const scale = fast ? 0.55 : 1;
  const bw = Math.max(2, Math.round(width * scale));
  const bh = Math.max(2, Math.round(height * scale));
  if (!bufferCanvas || bufferCanvas.width !== bw || bufferCanvas.height !== bh) {
    bufferCanvas = document.createElement('canvas');
    bufferCanvas.width = bw;
    bufferCanvas.height = bh;
    bufferImage = null;
  }
  const bctx = bufferCanvas.getContext('2d');
  if (!bctx) return;
  if (!bufferImage) bufferImage = bctx.createImageData(bw, bh);
  const out = bufferImage.data;

  const R = view.radiusPx * scale;
  const cx = view.cx * scale;
  const cy = view.cy * scale;
  const sinPhi0 = Math.sin(view.lat0 * DEG);
  const cosPhi0 = Math.cos(view.lat0 * DEG);
  const tw = texture.width;
  const th = texture.height;
  const tdata = texture.data;
  const lon0 = view.lon0;
  const invR = 1 / R;
  const RAD2DEG = 1 / DEG;

  for (let py = 0; py < bh; py++) {
    const y = (cy - (py + 0.5)) * invR;
    const y2 = y * y;
    let o = py * bw * 4;
    for (let px = 0; px < bw; px++, o += 4) {
      const x = (px + 0.5 - cx) * invR;
      const rho2 = x * x + y2;
      if (rho2 > 1) {
        out[o + 3] = 0;
        continue;
      }
      const z = Math.sqrt(1 - rho2);
      const lat = Math.asin(z * sinPhi0 + y * cosPhi0) * RAD2DEG;
      let lon = lon0 + Math.atan2(x, z * cosPhi0 - y * sinPhi0) * RAD2DEG;
      lon = lon - 360 * Math.floor((lon + 180) / 360);

      let tx = ((lon + 180) / 360) * tw;
      let ty = ((90 - lat) / 180) * th;
      tx = tx >= tw ? tw - 1 : tx < 0 ? 0 : tx;
      ty = ty >= th ? th - 1 : ty < 0 ? 0 : ty;
      const ti = ((ty | 0) * tw + (tx | 0)) * 4;

      // Sombreado lambertiano con más contraste (lado oscuro más oscuro, lado
      // iluminado más brillante) + oscurecimiento del limbo, para que se note que
      // es una esfera y no un círculo plano pintado.
      const lambert = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
      const limbDarken = 0.58 + 0.42 * z;
      const shade = 0.1 + 0.95 * Math.pow(lambert, 0.85) * limbDarken;

      // Brillo tenue tipo "fresnel" en el borde del lado iluminado: refuerza la
      // sensación de volumen, como el aro de luz atmosférica de las fotos reales.
      const rim = Math.pow(1 - z, 2.4) * lambert * 0.5;

      out[o] = tdata[ti] * shade + rim * 60;
      out[o + 1] = tdata[ti + 1] * shade + rim * 36;
      out[o + 2] = tdata[ti + 2] * shade + rim * 22;
      out[o + 3] = 255;
    }
  }

  bctx.putImageData(bufferImage, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bufferCanvas, 0, 0, width, height);
  ctx.restore();

  // Atmósfera tenue en el borde (sólo cuando el limbo está en pantalla)
  if (view.radiusPx < Math.hypot(width, height)) {
    const g = ctx.createRadialGradient(
      view.cx,
      view.cy,
      view.radiusPx * 0.985,
      view.cx,
      view.cy,
      view.radiusPx * 1.045
    );
    g.addColorStop(0, 'rgba(226, 150, 108, 0.30)');
    g.addColorStop(1, 'rgba(226, 150, 108, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(view.cx, view.cy, view.radiusPx * 1.045, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawStars(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  // Campo de estrellas determinista (no parpadea entre cuadros).
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  ctx.save();
  for (let i = 0; i < 140; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const a = 0.15 + rand() * 0.45;
    const r = rand() < 0.08 ? 1.1 : 0.6;
    ctx.fillStyle = `rgba(226, 232, 240, ${a.toFixed(2)})`;
    ctx.fillRect(x, y, r, r);
  }
  ctx.restore();
}
