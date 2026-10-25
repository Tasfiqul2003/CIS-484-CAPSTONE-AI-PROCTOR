type OralExamMarkProps = {
  size?: number;
  className?: string;
};

export default function OralExamMark({
  size = 34,
  className = "",
}: OralExamMarkProps) {
  return (
    <svg
      className={`oralexam-mark ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="20"
        cy="20"
        r="15"
        stroke="#625CE7"
        strokeWidth="4"
      />
      <circle cx="20" cy="20" r="8.5" fill="#39358F" />
    </svg>
  );
}
