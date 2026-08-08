import { forwardRef, type HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & { radius?: "sm" | "md" | "lg" | "pill" };

export const Glass = forwardRef<HTMLDivElement, Props>(
  ({ radius = "md", style, className = "", ...rest }, ref) => (
    <div ref={ref} className={`glass ${className}`}
      style={{ borderRadius: `var(--radius-${radius})`, ...style }} {...rest} />
  )
);
Glass.displayName = "Glass";
