"use client";

import { useEffect, useState, type ComponentType } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Mode = "system" | "light" | "dark";

function readMode(): Mode {
  try {
    const v = localStorage.getItem("theme");
    if (v === "light" || v === "dark") return v;
  } catch {
    /* localStorage unavailable */
  }
  return "system";
}

function applyMode(mode: Mode) {
  const root = document.documentElement;
  if (mode === "system") {
    try {
      localStorage.removeItem("theme");
    } catch {
    /* localStorage unavailable */
  }
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  } else if (mode === "dark") {
    try {
      localStorage.setItem("theme", "dark");
    } catch {
    /* localStorage unavailable */
  }
    root.classList.add("dark");
  } else {
    try {
      localStorage.setItem("theme", "light");
    } catch {
    /* localStorage unavailable */
  }
    root.classList.remove("dark");
  }
}

const NEXT: Record<Mode, Mode> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const ICON: Record<Mode, ComponentType<{ className?: string }>> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const LABEL: Record<Mode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    setMode(readMode());
  }, []);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyMode("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [mode]);

  function cycle() {
    const next = NEXT[mode];
    applyMode(next);
    setMode(next);
  }

  const Icon = ICON[mode];
  const nextLabel = LABEL[NEXT[mode]].toLowerCase();

  return (
    <button
      onClick={cycle}
      className="h-8 w-8 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors shrink-0"
      title={`Theme: ${LABEL[mode]} — click for ${nextLabel}`}
      aria-label={`Theme: ${LABEL[mode]}. Click for ${nextLabel}.`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
