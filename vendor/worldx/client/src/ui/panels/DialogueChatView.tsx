import type { CSSProperties, RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CharacterInfo, DialogueTurn } from "../../types/api";
import { CharacterAvatar } from "../components/CharacterAvatar";
import { translatePeriod } from "../utils/time-i18n";

export interface TimedTurn extends DialogueTurn {
  gameDay: number;
  gameTick: number;
  timeString?: string;
  absTick: number;
}

const AVATAR_SIZE = 32;

function periodLabel(turn: TimedTurn): string {
  return turn.timeString ? translatePeriod(turn.timeString) : `T${turn.gameTick}`;
}

/**
 * Two turns belong to the same time bucket when they share a game day and the
 * same displayed time label (period string or tick fallback).
 */
function sameTimeBucket(a: TimedTurn, b: TimedTurn): boolean {
  return a.gameDay === b.gameDay && periodLabel(a) === periodLabel(b);
}

function isRenderableTurn(turn: TimedTurn | null | undefined): turn is TimedTurn {
  return (
    !!turn &&
    typeof turn.gameDay === "number" &&
    typeof turn.gameTick === "number" &&
    typeof turn.speaker === "string" &&
    typeof turn.content === "string"
  );
}

export function DialogueChatView({
  turns,
  characterNames,
  characters,
  scrollRef,
}: {
  turns: TimedTurn[];
  characterNames: Record<string, string>;
  characters: CharacterInfo[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation();
  const renderableTurns = turns.filter(isRenderableTurn);

  return (
    <div ref={scrollRef} className="dialogue-scroll" style={scrollStyle}>
      {renderableTurns.map((turn, i) => {
        const prev = i > 0 ? renderableTurns[i - 1] : null;
        const showTimeSeparator = !prev || !sameTimeBucket(prev, turn);
        const mergedWithPrev =
          !!prev && !showTimeSeparator && prev.speaker === turn.speaker;
        const speakerName = characterNames[turn.speaker] || turn.speaker;
        const colorIndex = characters.findIndex((c) => c.id === turn.speaker);

        return (
          <div key={i}>
            {showTimeSeparator && (
              <div style={separatorRowStyle}>
                <span style={separatorPillStyle}>
                  {t("time.day", { day: turn.gameDay })} · {periodLabel(turn)}
                </span>
              </div>
            )}

            <div
              style={{
                ...rowStyle,
                marginTop: mergedWithPrev ? 2 : 10,
                animation: "fadeIn 0.4s ease",
              }}
            >
              <div style={avatarColumnStyle}>
                {!mergedWithPrev && (
                  <CharacterAvatar
                    characterId={turn.speaker}
                    name={speakerName}
                    colorIndex={colorIndex}
                    size={AVATAR_SIZE}
                  />
                )}
              </div>

              <div style={contentColumnStyle}>
                {!mergedWithPrev && <div style={nameStyle}>{speakerName}</div>}
                <div style={bubbleStyle}>{turn.content}</div>
                {turn.innerMonologue && (
                  <div style={monologueStyle} title={t("dialogue.innerMonologueTitle")}>
                    💭 {turn.innerMonologue}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- styles ----------

const scrollStyle: CSSProperties = {
  overflow: "auto",
  flex: 1,
  paddingRight: 4,
  display: "flex",
  flexDirection: "column",
};

const separatorRowStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  margin: "10px 0 4px",
};

const separatorPillStyle: CSSProperties = {
  fontSize: 11,
  color: "#9fb4d6",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 999,
  padding: "2px 10px",
  whiteSpace: "nowrap",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
};

const avatarColumnStyle: CSSProperties = {
  width: AVATAR_SIZE,
  flexShrink: 0,
};

const contentColumnStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const nameStyle: CSSProperties = {
  color: "#74b9ff",
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.2,
};

const bubbleStyle: CSSProperties = {
  alignSelf: "flex-start",
  background: "rgba(255,255,255,0.07)",
  border: "1px solid rgba(120,180,255,0.15)",
  color: "#e0e6f2",
  padding: "7px 11px",
  borderRadius: "4px 12px 12px 12px",
  maxWidth: "88%",
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  overflowWrap: "anywhere",
};

const monologueStyle: CSSProperties = {
  color: "#b39ddb",
  fontSize: 12,
  fontStyle: "italic",
  marginTop: 2,
  paddingLeft: 10,
  borderLeft: "2px dashed rgba(179, 157, 219, 0.45)",
  opacity: 0.88,
};
