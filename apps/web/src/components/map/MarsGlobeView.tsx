import React, { useEffect, useRef, useState } from 'react';
import {
  computeGlobeView,
  globeFreedomForSpan,
  GlobeTexture,
  loadGlobeTexture,
  MARS_REGION_LABELS,
  projectLatLon,
  renderMarsGlobe,
  unprojectToLatLon,
  wrapLon,
} from '../../utils/marsGlobe';
import { DOLLFUS_CENTER } from '../../utils/marsTiles';

interface MarsGlobeViewProps {
  width: number;
  height: number;
  spanKm: number;
  opacity: number;
  onZoom: (dir: 1 | -1) => void;
  onFlyToSite: () => void;
  onHover?: (lat: number, lon: number) => void;
}

const SITE_HIT_RADIUS_PX = 16;
const LABEL_FONT = '500 11px "Inter", "Segoe UI", sans-serif';

/**
 * Capa del planeta completo. Vive encima del canvas del mapa local y sólo recibe
 * eventos cuando es visible (opacity > 0). Arrastrar a izquierda/derecha cambia la
 * longitud; la latitud del centro la decide el nivel de zoom.
 */
export const MarsGlobeView: React.FC<MarsGlobeViewProps> = ({
  width,
  height,
  spanKm,
  opacity,
  onZoom,
  onFlyToSite,
  onHover,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [texture, setTexture] = useState<GlobeTexture | null>(null);
  const [userLon, setUserLon] = useState<number>(DOLLFUS_CENTER.lon);
  const [hoverSite, setHoverSite] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startLon: number; moved: boolean } | null>(null);
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;

  // Resolución real del canvas (en píxeles de dispositivo, no CSS), medida del
  // tamaño en que realmente se muestra. Antes el canvas interno quedaba fijo en
  // `width`/`height` (920×540) y el navegador lo estiraba por CSS al tamaño del
  // panel — eso es lo que se veía borroso. Con esto el buffer siempre coincide
  // con los píxeles reales de pantalla, como un canvas "retina".
  const [bufSize, setBufSize] = useState<{ w: number; h: number }>({ w: width, h: height });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const cw = Math.max(1, Math.round(entry.contentRect.width * dpr));
      const ch = Math.max(1, Math.round(entry.contentRect.height * dpr));
      setBufSize((prev) => (prev.w === cw && prev.h === ch ? prev : { w: cw, h: ch }));
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  const isVisible = opacity > 0.001;
  const freedom = globeFreedomForSpan(spanKm);

  // Carga la textura una sola vez, cuando el globo se necesita por primera vez.
  useEffect(() => {
    if (!isVisible || texture) return;
    let cancelled = false;
    loadGlobeTexture().then((tex) => {
      if (!cancelled) setTexture(tex);
    });
    return () => {
      cancelled = true;
    };
  }, [isVisible, texture]);

  // Al volver al mapa local, el globo se recentra en el sitio de la misión.
  useEffect(() => {
    if (freedom === 0 && userLon !== DOLLFUS_CENTER.lon) setUserLon(DOLLFUS_CENTER.lon);
  }, [freedom, userLon]);

  // Rueda del mouse (no pasiva, para poder evitar el scroll de la página).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onZoomRef.current(e.deltaY < 0 ? 1 : -1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const view = computeGlobeView(spanKm, userLon, bufSize.w, bufSize.h);

  useEffect(() => {
    if (!isVisible) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    renderMarsGlobe(ctx, bufSize.w, bufSize.h, texture, view, dragging);
    if (!texture) return;

    // Nombres de regiones (sólo cuando el planeta ya se ve casi completo)
    const labelAlpha = Math.max(0, (freedom - 0.45) / 0.55);
    if (labelAlpha > 0) {
      ctx.save();
      ctx.font = LABEL_FONT;
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
      ctx.shadowBlur = 4;
      for (const region of MARS_REGION_LABELS) {
        const p = projectLatLon(region.lat, region.lon, view);
        if (!p || p.cosC < 0.18) continue;
        const a = labelAlpha * Math.min(1, (p.cosC - 0.18) / 0.25);
        ctx.fillStyle = `rgba(241, 245, 249, ${(0.85 * a).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(226, 232, 240, ${(0.82 * a).toFixed(3)})`;
        ctx.textAlign = 'left';
        ctx.fillText(region.name, p.x + 6, p.y);
      }
      ctx.restore();
    }

    // Sitio de la misión: Cráter Dollfus
    const site = projectLatLon(DOLLFUS_CENTER.lat, DOLLFUS_CENTER.lon, view);
    if (site && freedom > 0.05) {
      const a = Math.min(1, freedom * 1.6);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(site.x, site.y, hoverSite ? 11 : 9, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(site.x, site.y, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = '#0b192c';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#38bdf8';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(site.x, site.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = '#38bdf8';
      ctx.fill();

      ctx.font = '600 12px "Inter", "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
      ctx.shadowBlur = 5;
      ctx.fillStyle = '#f8fafc';
      ctx.fillText('Cráter Dollfus', site.x + 15, site.y - 6);
      ctx.font = '400 10.5px "Inter", "Segoe UI", sans-serif';
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(hoverSite ? 'Clic para acercarte' : 'Sitio EVA · Ares IV', site.x + 15, site.y + 8);
      ctx.restore();
    }
  });

  const localPoint = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * bufSize.w,
      y: ((e.clientY - rect.top) / rect.height) * bufSize.h,
      scaleX: bufSize.w / rect.width,
    };
  };

  const isOverSite = (x: number, y: number) => {
    if (freedom <= 0.05) return false;
    const site = projectLatLon(DOLLFUS_CENTER.lat, DOLLFUS_CENTER.lon, view);
    return !!site && Math.hypot(site.x - x, site.y - y) <= SITE_HIT_RADIUS_PX;
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    dragRef.current = { startX: e.clientX, startLon: userLon, moved: false };
    setDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const pt = localPoint(e);
    if (!pt) return;

    const drag = dragRef.current;
    if (drag) {
      const dxScreen = e.clientX - drag.startX;
      if (Math.abs(dxScreen) > 3) drag.moved = true;
      if (freedom > 0) {
        // Un desplazamiento de un radio en pantalla ≈ 1 radián de giro.
        const dLonDeg = ((dxScreen * pt.scaleX) / view.radiusPx) * (180 / Math.PI);
        setUserLon(wrapLon(drag.startLon - dLonDeg / Math.max(0.2, freedom)));
      }
      return;
    }

    setHoverSite(isOverSite(pt.x, pt.y));
    if (onHover) {
      const ll = unprojectToLatLon(pt.x, pt.y, view);
      if (ll) onHover(ll.lat, ll.lon);
    }
  };

  const endDrag = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (drag && !drag.moved) {
      const pt = localPoint(e);
      if (pt && isOverSite(pt.x, pt.y)) onFlyToSite();
    }
  };

  return (
    <>
      <canvas
        ref={canvasRef}
        width={bufSize.w}
        height={bufSize.h}
        aria-label="Vista global de Marte"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={() => {
          dragRef.current = null;
          setDragging(false);
          setHoverSite(false);
        }}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          opacity,
          pointerEvents: isVisible ? 'auto' : 'none',
          cursor: hoverSite ? 'pointer' : freedom > 0 ? (dragging ? 'grabbing' : 'grab') : 'default',
          zIndex: 2,
        }}
      />

      {isVisible && freedom > 0.6 && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '14px',
            transform: 'translateX(-50%)',
            zIndex: 3,
            padding: '5px 11px',
            borderRadius: '5px',
            background: 'rgba(10, 14, 22, 0.86)',
            border: '1px solid #1c2434',
            fontSize: '11px',
            color: '#94a3b8',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Arrastra para girar · rueda para acercar
          {texture?.isFallback && (
            <span style={{ color: '#fbbf24', marginLeft: '8px' }}>
              Sin tiles de Mars Trek: textura de respaldo
            </span>
          )}
        </div>
      )}
    </>
  );
};
