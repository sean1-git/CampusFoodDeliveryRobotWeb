import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "md-filter-chip": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { selected?: boolean; disabled?: boolean; label?: string };
      "md-filled-tonal-button": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { disabled?: boolean; type?: "button" | "submit" };
      "md-linear-progress": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { value?: number; max?: number; indeterminate?: boolean };
      "md-assist-chip": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        "aria-pressed"?: boolean | "true" | "false";
        disabled?: boolean;
      };
      "md-outlined-button": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        disabled?: boolean;
      };
    }
  }
}

export {};
