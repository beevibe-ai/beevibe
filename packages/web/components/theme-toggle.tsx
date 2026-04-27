"use client";

import { Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  function handleClick() {
    const isDark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("theme", isDark ? "dark" : "light");
    } catch {
      // localStorage unavailable (private mode, etc.) — toggle still works for the session
    }
  }

  return (
    <button
      onClick={handleClick}
      className="h-8 w-8 rounded inline-flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors shrink-0"
      title="Toggle theme"
      aria-label="Toggle theme"
    >
      <Sun className="h-4 w-4 hidden dark:block" />
      <Moon className="h-4 w-4 block dark:hidden" />
    </button>
  );
}
