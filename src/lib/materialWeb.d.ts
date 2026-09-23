import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
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
