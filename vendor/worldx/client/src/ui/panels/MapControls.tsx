import { useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import Phaser from "phaser";

interface CameraState {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
  mapWidth: number;
  mapHeight: number;
}

const MINI_W = 200;
const MINI_W_COMPACT = 160;
const MINI_MAP_IMAGE_PATH = "/assets/map/06-background.png";

export function MapControls({
  eventBus,
  presentationMode = false,
}: {
  eventBus: Phaser.Events.EventEmitter;
  presentationMode?: boolean;
}) {
  const { t } = useTranslation();
  const miniWidth = presentationMode ? MINI_W_COMPACT : MINI_W;
  const [zoom, setZoom] = useState(1);
  const [showHint, setShowHint] = useState(!presentationMode);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<CameraState>({ x: 0, y: 0, width: 1024, height: 768, zoom: 1, mapWidth: 8192, mapHeight: 4608 });
  const rafRef = useRef(0);
  const miniHRef = useRef(Math.round(miniWidth * (4608 / 8192)));
  const miniMapImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setShowHint(!presentationMode);
  }, [presentationMode]);

  useEffect(() => {
    const onZoom = (z: number) => setZoom(z);
    const onCamState = (s: CameraState) => {
      camRef.current = s;
      if (s.mapWidth > 0 && s.mapHeight > 0) {
        miniHRef.current = Math.round(miniWidth * (s.mapHeight / s.mapWidth));
      }
    };

    eventBus.on("camera_zoom_changed", onZoom);
    eventBus.on("camera_state", onCamState);

    const timer = presentationMode
      ? null
      : setTimeout(() => setShowHint(false), 9000);

    return () => {
      eventBus.off("camera_zoom_changed", onZoom);
      eventBus.off("camera_state", onCamState);
      if (timer) clearTimeout(timer);
      cancelAnimationFrame(rafRef.current);
    };
  }, [eventBus, miniWidth, presentationMode]);

  useEffect(() => {
    const image = new Image();
    image.src = MINI_MAP_IMAGE_PATH;
    image.onload = () => {
      miniMapImageRef.current = image;
    };
    image.onerror = () => {
      miniMapImageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const cam = camRef.current;
      const mapW = cam.mapWidth || 8192;
      const mapH = cam.mapHeight || 4608;
      const miniH = miniHRef.current;
      const scale = miniWidth / mapW;
      const minimapImage = miniMapImageRef.current;

      canvas.height = miniH;
      ctx.clearRect(0, 0, miniWidth, miniH);

      if (minimapImage?.complete && minimapImage.naturalWidth > 0) {
        ctx.drawImage(minimapImage, 0, 0, miniWidth, miniH);
      } else {
        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, 0, miniWidth, miniH);
      }

      const vx = cam.x * scale;
      const vy = cam.y * scale;
      const vw = cam.width * scale;
      const vh = cam.height * scale;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        Math.max(0, vx),
        Math.max(0, vy),
        Math.min(miniWidth - Math.max(0, vx), vw),
        Math.min(miniH - Math.max(0, vy), vh)
      );

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [miniWidth]);

  const handleMinimapClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const mapW = camRef.current.mapWidth || 8192;
      const scale = miniWidth / mapW;
      const worldX = mx / scale;
      const worldY = my / scale;
      eventBus.emit("camera_pan_to", { x: worldX, y: worldY });
    },
    [eventBus]
  );

  const [draggingMinimap, setDraggingMinimap] = useState(false);

  const handleMinimapDrag = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!draggingMinimap) return;
      handleMinimapClick(e);
    },
    [draggingMinimap, handleMinimapClick]
  );

  const zoomIn = useCallback(() => eventBus.emit("camera_zoom_in"), [eventBus]);
  const zoomOut = useCallback(() => eventBus.emit("camera_zoom_out"), [eventBus]);
  const zoomFit = useCallback(() => eventBus.emit("camera_zoom_fit"), [eventBus]);
  const zoomReset = useCallback(() => eventBus.emit("camera_zoom_reset"), [eventBus]);

  return (
    <>
      {/* Bottom-left: Minimap + Zoom */}
      <div style={{ position: "fixed", bottom: 12, left: 12, zIndex: 90, pointerEvents: "auto" }}>
        {/* Zoom bar */}
          <div style={{ ...panelStyle, display: "flex", alignItems: "center", gap: 3, marginBottom: 6, padding: "3px 5px" }}>
          <ZoomBtn onClick={zoomOut} title={t("mapControls.zoomOut")}>−</ZoomBtn>
          <div
            onClick={zoomReset}
            title={t("mapControls.zoomReset")}
            style={{ width: 44, textAlign: "center", fontSize: 11, color: "#ccc", cursor: "pointer", userSelect: "none" }}
          >
            {Math.round(zoom * 100)}%
          </div>
          <ZoomBtn onClick={zoomIn} title={t("mapControls.zoomIn")}>+</ZoomBtn>
          <Divider />
          <ZoomBtn onClick={zoomFit} title={t("mapControls.zoomFit")}>⊡</ZoomBtn>
        </div>

        {/* Minimap */}
        <div style={{ ...panelStyle, padding: 3, cursor: "crosshair", position: "relative" }}>
          <canvas
            ref={canvasRef}
            width={miniWidth}
            height={Math.round(miniWidth * (4608 / 8192))}
            style={{ display: "block", borderRadius: 4 }}
            onClick={handleMinimapClick}
            onMouseDown={() => setDraggingMinimap(true)}
            onMouseUp={() => setDraggingMinimap(false)}
            onMouseLeave={() => setDraggingMinimap(false)}
            onMouseMove={handleMinimapDrag}
          />
        </div>
      </div>

      {/* Controls hint - bottom center, fades out */}
      {!presentationMode && showHint && (
        <div
          style={{
            position: "fixed",
            bottom: 16,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(6, 9, 20, 0.82)",
            backdropFilter: "blur(10px)",
            borderRadius: 14,
            padding: "10px 16px",
            color: "#d6d9e6",
            fontSize: 12,
            zIndex: 80,
            pointerEvents: "none",
            animation: "hintFade 9s ease forwards",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 12px 28px rgba(0,0,0,0.28)",
            minWidth: 320,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, color: "#ffffff" }}>
            {t("mapControls.hintTitle")}
          </div>
          <div>{t("mapControls.hintLine1")}</div>
          <div style={{ marginTop: 2 }}>{t("mapControls.hintLine2")}</div>
          <style>{`
            @keyframes hintFade {
              0%, 78% { opacity: 1; }
              100% { opacity: 0; }
            }
          `}</style>
        </div>
      )}
    </>
  );
}

function ZoomBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        width: 28, height: 28, borderRadius: 5,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "rgba(255,255,255,0.05)",
        color: "#ddd", fontSize: 15, cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.15)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 16, background: "rgba(255,255,255,0.12)" }} />;
}

const panelStyle: React.CSSProperties = {
  background: "rgba(16,16,32,0.92)",
  backdropFilter: "blur(8px)",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.1)",
};
