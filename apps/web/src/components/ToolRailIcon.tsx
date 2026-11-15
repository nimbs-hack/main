import type { ToolId } from "../registry/toolRegistry";

interface ToolRailIconProps {
  toolId: ToolId;
  fallbackLabel: string;
}

/**
 * Render monochrome currentColor SVG pictogram for a left tool-rail button.
 */
export function ToolRailIcon({ toolId, fallbackLabel }: ToolRailIconProps) {
  switch (toolId) {
    case "route":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M4.5 18.5 Q4.5 10.5 12 12 T19.5 5.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="4.5" cy="18.5" r="2.2" fill="currentColor" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" />
          <circle cx="19.5" cy="5.5" r="2.2" fill="currentColor" />
        </svg>
      );

    case "weather":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M11.54 9.06 A3.6 3.6 0 1 1 13.58 11.76"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M15.1 2.0 V3.5 M10.5 3.9 L11.56 4.96 M19.7 3.9 L18.64 4.96 M21.6 8.5 H20.1 M19.7 13.1 L18.64 12.04"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M9.5 6.5 C12.2 10.2 14.5 12.7 14.5 15.5 A5 5 0 1 1 4.5 15.5 C4.5 12.7 6.8 10.2 9.5 6.5 Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M7.3 15.6 A2.3 2.3 0 0 0 9.6 17.8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );

    case "sim":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M9.5 2.5 H14.5 M12 2.5 V5.8 M17.6 7 L19.4 5.2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <circle cx="12" cy="13.5" r="7.5" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M12 9.2 V13.5 L15.2 15.2"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    case "points":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 21 C12 21 18.5 14.2 18.5 9.5 A6.5 6.5 0 1 0 5.5 9.5 C5.5 14.2 12 21 12 21 Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="9.5" r="2.4" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      );

    case "layers":
      return (
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3.5 L20.5 8 L12 12.5 L3.5 8 Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <path
            d="M3.5 12 L12 16.5 L20.5 12"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M3.5 16 L12 20.5 L20.5 16"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );

    default:
      return <span>{fallbackLabel}</span>;
  }
}
