import { isValidPreviewImage } from "./avatar/settings";
import "./ai-avatar.css";

export type AIAvatarState = "Idle" | "Listening" | "Thinking" | "Speaking" | "Error";

export default function AIAvatar({ avatar = "guide", background = "neutral", customAvatar = null,
  customBackground = null, animation = true, reducedMotion = false, state = "Idle", compact = false,
}: {
  avatar?: string; background?: string; customAvatar?: string | null; customBackground?: string | null;
  animation?: boolean; reducedMotion?: boolean; state?: AIAvatarState; compact?: boolean;
}) {
  const photo = avatar === "custom" && isValidPreviewImage(customAvatar) ? customAvatar : null;
  const backdrop = background === "custom" && isValidPreviewImage(customBackground) ? customBackground : null;
  return <div className={`exam-avatar exam-avatar-${background}${compact ? " exam-avatar-compact" : ""}${animation && !reducedMotion && !photo ? " exam-avatar-animated" : ""}`}
    data-state={state.toLowerCase()} data-reduced-motion={reducedMotion}
    style={backdrop ? { backgroundImage: `url("${backdrop}")` } : undefined}>
    <div className="exam-avatar-portrait" role="img" aria-label={photo ? "Professor-selected avatar photo" : avatar === "geometric" ? "Geometric examiner avatar" : "OralExam AI default examiner"}>
      {photo ? <img src={photo} alt="" /> : avatar === "geometric" ? <svg viewBox="0 0 160 180" aria-hidden="true" focusable="false">
        <path d="M80 15 145 90 80 165 15 90Z" fill="#ede5fb" stroke="#6d28d9" strokeWidth="4" />
        <circle cx="62" cy="82" r="5" fill="#312e81" /><circle cx="98" cy="82" r="5" fill="#312e81" />
        <path className="exam-avatar-mouth" d="M66 106q14 12 28 0" fill="none" stroke="#6d28d9" strokeWidth="4" strokeLinecap="round" />
      </svg> : <svg viewBox="0 0 160 180" aria-hidden="true" focusable="false">
        <path d="M20 179v-17c0-31 26-48 60-48s60 17 60 48v17" fill="#514182" />
        <path d="m58 122 22 37 22-37-22-9Z" fill="#fff" /><path d="m75 135 5 5 5-5-5-7Z" fill="#b7a1dd" />
        <path d="m80 140-7 24 7 9 7-9Z" fill="#b7a1dd" />
        <path d="m56 123-13 14 18 5-5 12 24 21-17-51m41-1 13 14-18 5 5 12-24 21 17-51" fill="#67539c" />
        <path d="M67 98v24q13 13 26 0V98" fill="#d6b393" />
        <ellipse cx="80" cy="70" rx="35" ry="43" fill="#e8c8a8" />
        <path d="M45 67c-7-29 8-47 33-47 30 0 42 19 37 47l-9-18c-18 5-31 0-40-8-3 10-10 18-21 26" fill="#3e3349" />
        <path d="M47 76q3 28 19 36m47-36q-3 28-19 36" fill="none" stroke="#b78f76" strokeWidth="2" />
        <g fill="none" stroke="#3e3349" strokeWidth="2.5"><rect x="51" y="62" width="24" height="19" rx="7" /><rect x="85" y="62" width="24" height="19" rx="7" /><path d="M75 69q5-4 10 0M45 66l6 2m58 0 6-2" /></g>
        <circle cx="64" cy="71" r="2.8" fill="#2e2839" /><circle cx="96" cy="71" r="2.8" fill="#2e2839" />
        <path d="m80 75-3 13h6" fill="none" stroke="#b78f76" strokeWidth="2" strokeLinecap="round" />
        <path className="exam-avatar-mouth" d="M69 96q11 9 22 0" fill="none" stroke="#8d534e" strokeWidth="3" strokeLinecap="round" />
      </svg>}
    </div>
    <span className="exam-avatar-state" role="status">{state}</span>
  </div>;
}
