import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "Menlo", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        status: {
          pending: "hsl(var(--status-pending))",
          running: "hsl(var(--status-running))",
          review: "hsl(var(--status-review))",
          blocked: "hsl(var(--status-blocked))",
          done: "hsl(var(--status-done))",
          failed: "hsl(var(--status-failed))",
          cancelled: "hsl(var(--status-cancelled))",
        },
        hier: {
          ic: "hsl(var(--hier-ic))",
          team: "hsl(var(--hier-team))",
          org: "hsl(var(--hier-org))",
        },
        "type-belief-bg": "hsl(var(--type-belief-bg))",
        "type-belief-fg": "hsl(var(--type-belief-fg))",
        "type-pattern-bg": "hsl(var(--type-pattern-bg))",
        "type-pattern-fg": "hsl(var(--type-pattern-fg))",
        "type-gotcha-bg": "hsl(var(--type-gotcha-bg))",
        "type-gotcha-fg": "hsl(var(--type-gotcha-fg))",
        "type-preference-bg": "hsl(var(--type-preference-bg))",
        "type-preference-fg": "hsl(var(--type-preference-fg))",
        "type-decision-bg": "hsl(var(--type-decision-bg))",
        "type-decision-fg": "hsl(var(--type-decision-fg))",
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        md: "var(--radius)",
        lg: "calc(var(--radius) + 2px)",
        xl: "calc(var(--radius) + 6px)",
      },
      keyframes: {
        "pulse-breathe": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.55", transform: "scale(0.92)" },
        },
        "spin-slow": {
          to: { transform: "rotate(360deg)" },
        },
        "row-flash": {
          "0%": { backgroundColor: "hsl(48 96% 53% / 0.16)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
      animation: {
        "pulse-breathe": "pulse-breathe 2s ease-in-out infinite",
        "spin-slow": "spin-slow 2.5s linear infinite",
        "row-flash": "row-flash 1200ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
