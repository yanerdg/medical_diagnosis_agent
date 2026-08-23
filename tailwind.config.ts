import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#f3f7fb",
        foreground: "#132033",
        muted: "#64748b",
        panel: "#ffffff",
        primary: "#2563eb",
        "primary-foreground": "#ffffff",
        border: "#d6e0ec",
      },
      boxShadow: {
        card: "0 0 0 1px rgba(255, 255, 255, 0.55), 0 18px 52px -28px rgba(15, 23, 42, 0.42)",
        glow: "0 0 0 1px rgba(255, 255, 255, 0.55), 0 24px 80px -28px rgba(37, 99, 235, 0.32)",
      },
    },
  },
  plugins: [],
};

export default config;
