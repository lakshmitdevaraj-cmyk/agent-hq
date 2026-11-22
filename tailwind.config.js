const path = require("path");

/**
 * Every colour comes from CSS variables (src/app.css), which follow the Mac's light/dark setting.
 * Each variable holds "R G B" so opacity classes such as bg-fg/5 still work.
 * Meaning: ok = green (ready, success), warn = amber (emailed, in progress), bad = red (error, bounced, do not contact),
 * flag = violet (unauthenticated, spam, blocked), primary = blue (main buttons, links), fg/fg2/muted = text, line = borders.
 */
const c = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const hue = (name) => ({ DEFAULT: c(name), 50: c(name), 100: c(name), 200: c(name), 300: c(name), 400: c(name), 500: c(name), 600: c(name), 700: c(name) });

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "src/**/*.{ts,tsx}"),
  ],
  theme: {
    extend: {
      colors: {
        bg: c("page"),
        card: c("card"),
        inset: c("inset"),
        line: c("line"),
        fg: c("fg"),
        fg2: c("fg2"),
        muted: c("muted"),
        primary: c("primary"),
        "on-solid": c("on-solid"),
        accent: c("primary"),
        success: c("ok"),
        danger: c("bad"),
        amber: hue("warn"),
        green: hue("ok"),
        emerald: hue("ok"),
        red: hue("bad"),
        violet: hue("flag"),
      },
      textColor: {
        primary: c("primary-ink"),
        accent: c("primary-ink"),
        success: c("ok-ink"),
        danger: c("bad-ink"),
        green: hue("ok-ink"),
        emerald: hue("ok-ink"),
        amber: hue("warn-ink"),
        red: hue("bad-ink"),
        violet: hue("flag-ink"),
      },
      fontSize: {
        min: ["var(--fs-min)", { lineHeight: "1.3" }],
        label: ["var(--fs-label)", { lineHeight: "1.35" }],
        xs: ["var(--fs-label)", { lineHeight: "1.35" }],
        sm: ["var(--fs-body)", { lineHeight: "1.45" }],
      },
      fontFamily: {
        display: ['"Orbitron"', "sans-serif"],
        body: ['"Rajdhani"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      boxShadow: {
        glow: "none",
        "glow-accent": "none",
        "glow-success": "none",
        "inset-glass": "none",
      },
    },
  },
  plugins: [],
};
