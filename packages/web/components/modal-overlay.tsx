"use client";

import type { FormEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

const CARD_CLASS = "bg-card border border-border rounded-lg p-5 w-full max-w-md shadow-md";

/**
 * Centered modal over a blurred backdrop, with click-the-backdrop to
 * dismiss. Both invite dialogs — "invite a teammate" in the user widget
 * and "invite to room" on the room page — were built from a
 * byte-identical copy of this: the fixed backdrop with its `onClick`,
 * and the card with the `stopPropagation` that keeps a click inside
 * from bubbling out and closing the thing the user is typing into.
 *
 * Passing `onSubmit` renders the card as a `<form>`, which is what the
 * room dialog needs so Enter submits the invite; without it the card is
 * a plain `<div>`.
 */
export function ModalOverlay({
  onClose,
  className,
  overlayClassName = "z-50",
  onSubmit,
  children,
}: {
  onClose: () => void;
  /** Extra classes on the card. */
  className?: string;
  /**
   * Stacking for the backdrop. The two callers sit at different depths
   * today (z-50 in the user widget, z-30 on the room page); left as a
   * knob rather than harmonized, since raising the room dialog is a
   * visual change and not this refactor's business.
   */
  overlayClassName?: string;
  /** Supply to render the card as a submitting form. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div
      className={cn(
        "fixed inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center",
        overlayClassName,
      )}
      onClick={onClose}
    >
      {onSubmit ? (
        <form onClick={stop} onSubmit={onSubmit} className={cn(CARD_CLASS, className)}>
          {children}
        </form>
      ) : (
        <div onClick={stop} className={cn(CARD_CLASS, className)}>
          {children}
        </div>
      )}
    </div>
  );
}
