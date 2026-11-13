import { useState, type CSSProperties } from "react";
import {
  SPRITE_COLUMNS,
  SPRITE_FRAME_WIDTH,
  SPRITE_FRAME_HEIGHT,
  getCharacterColor,
} from "../../config/game-config";

/**
 * Frame index of the front-facing idle pose inside each character spritesheet.
 * Matches `idle-front.frame` in the per-character metadata.json and the value
 * used by CharacterSprite (see objects/CharacterSprite.ts:249,291).
 */
const AVATAR_FRAME_INDEX = 18;

/**
 * Source-pixel crop window (within a single 170x204 frame) that focuses on the
 * character's head/shoulders instead of the full body. Tuned for the generated
 * sprite layout where the head sits in the upper-center of the frame.
 */
const CROP_WIDTH = 120;
const CROP_HEIGHT = 120;
const CROP_OFFSET_X = (SPRITE_FRAME_WIDTH - CROP_WIDTH) / 2;
const CROP_OFFSET_Y = 14;

const SHEET_WIDTH = SPRITE_COLUMNS * SPRITE_FRAME_WIDTH;

function toColorString(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function firstGlyph(name: string): string {
  const trimmed = name.trim();
  return trimmed ? Array.from(trimmed)[0] : "?";
}

export function CharacterAvatar({
  characterId,
  name,
  colorIndex,
  size = 32,
}: {
  characterId: string;
  name: string;
  colorIndex: number;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);

  const baseStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.15)",
    boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
  };

  if (failed || !characterId) {
    const bg = toColorString(getCharacterColor(Math.max(0, colorIndex)));
    return (
      <div
        style={{
          ...baseStyle,
          background: bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontSize: Math.round(size * 0.46),
          fontWeight: 700,
          lineHeight: 1,
        }}
        aria-label={name}
        title={name}
      >
        {firstGlyph(name)}
      </div>
    );
  }

  const col = AVATAR_FRAME_INDEX % SPRITE_COLUMNS;
  const row = Math.floor(AVATAR_FRAME_INDEX / SPRITE_COLUMNS);
  const scale = size / CROP_WIDTH;
  const sourceX = col * SPRITE_FRAME_WIDTH + CROP_OFFSET_X;
  const sourceY = row * SPRITE_FRAME_HEIGHT + CROP_OFFSET_Y;

  return (
    <div
      style={{
        ...baseStyle,
        backgroundColor: "rgba(255,255,255,0.04)",
        backgroundImage: `url(/assets/characters/${characterId}/spritesheet.png)`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${SHEET_WIDTH * scale}px auto`,
        backgroundPosition: `-${sourceX * scale}px -${sourceY * scale}px`,
      }}
      aria-label={name}
      title={name}
    >
      {/* Hidden probe image: fires onError so we can fall back to an initial. */}
      <img
        src={`/assets/characters/${characterId}/spritesheet.png`}
        alt=""
        aria-hidden
        style={{ display: "none" }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
