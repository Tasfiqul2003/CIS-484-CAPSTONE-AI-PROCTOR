import { useId } from "react";
import { isValidPreviewImage } from "./settings";
import type { AIAvatarState } from "../AIAvatar";
import "./exam-stage-avatar.css";

/** Static presentation only. A future FlashHead adapter can supply video in this viewport. */
export default function ExamStageAvatar({ avatar = "guide", background = "neutral", customAvatar = null,
  customBackground = null, developerMinimal = false,
}: {
  avatar?: string; background?: string; customAvatar?: string | null; customBackground?: string | null;
  animation?: boolean; reducedMotion?: boolean; state?: AIAvatarState; developerMinimal?: boolean;
}) {
  const id = useId().replaceAll(":", "");
  const photo = avatar === "custom" && isValidPreviewImage(customAvatar) ? customAvatar : null;
  const backdrop = background === "custom" && isValidPreviewImage(customBackground) ? customBackground : null;
  return <div className={`exam-stage-viewport exam-stage-background-${background}`}
    style={backdrop ? { backgroundImage: `url("${backdrop}")` } : undefined}>
    {photo ? <img className="exam-stage-photo" src={photo} alt="Professor-selected examiner image" />
      : avatar === "geometric" ? <svg className="exam-stage-portrait" viewBox="0 0 480 480" role="img" aria-label="Geometric examiner">
        <path d="M240 50 410 240 240 430 70 240Z" fill="#eee8f7" stroke="#5b3a91" strokeWidth="8" />
      </svg> : <svg className="exam-stage-portrait" viewBox="0 0 480 480" preserveAspectRatio="xMidYMax meet" role="img" aria-label="Static faceless examiner">
        <defs>
          <linearGradient id={`${id}-hair`} x2=".9" y2="1"><stop stopColor="#694435" /><stop offset="1" stopColor="#3b2528" /></linearGradient>
          <linearGradient id={`${id}-skin`} x2=".8" y2="1"><stop stopColor="#ffd3a5" /><stop offset="1" stopColor="#f3ad77" /></linearGradient>
          <linearGradient id={`${id}-jacket`} x2="1" y2=".8"><stop stopColor="#8652ae" /><stop offset="1" stopColor="#512478" /></linearGradient>
        </defs>
        <path d="M124 305c-32-10-39-31-25-48-25-15-18-43-2-58-21-34-9-61 11-81-10-38 17-64 47-73 17-39 65-53 110-38 39-2 61 19 69 47 40 14 55 47 45 79 24 24 27 54 13 76 25 23 17 47-2 60 13 29-2 48-30 51-12 34-59 27-87 15l-125 3Z" fill={`url(#${id}-hair)`} />
        <path d="M152 72c-34 16-42 56-22 79 20-31 64-33 98-67 29-27 49-33 71-31-40-27-105-26-147 19Z" fill="#865a43" opacity=".24" />
        <path d="M77 480c8-92 19-132 82-149l45-13h72l45 13c63 17 74 57 82 149Z" fill={`url(#${id}-jacket)`} />
        <path d="M207 260v70c20 27 46 27 66 0v-70" fill={`url(#${id}-skin)`} />
        <path d="M206 269q34 34 68 0v22q-34 35-68 0Z" fill="#d88f5c" opacity=".35" />
        <path d="m204 329 36 17 36-17-10 151h-52Z" fill="#fff" />
        <path d="m203 320-36 18-24 58 34 8-19 26 58 50 11-135Z" fill="#754398" />
        <path d="m277 320 36 18 24 58-34 8 19 26-58 50-11-135Z" fill="#67368d" />
        <path d="m167 338-24 58 34 8-19 26 58 50m97-142 24 58-34 8 19 26-58 50" fill="none" stroke="#482665" strokeWidth="3" opacity=".35" />
        <ellipse cx="149" cy="188" rx="19" ry="28" fill="#f2ad78" /><ellipse cx="331" cy="188" rx="19" ry="28" fill="#f2ad78" />
        <path d="M153 143c9-49 54-77 88-79 42 2 77 32 85 79v58c0 61-40 107-86 107s-87-46-87-107Z" fill={`url(#${id}-skin)`} />
        <path d="M146 159c48-10 114-41 133-82 20 35 39 55 55 67-3-58-39-91-89-91-57-1-100 41-99 106Z" fill={`url(#${id}-hair)`} />
      </svg>}
    <span className={developerMinimal ? "exam-stage-substitute" : "exam-stage-static-label"}>
      {developerMinimal ? "Static avatar · developer substitute" : "Static examiner"}
    </span>
  </div>;
}
