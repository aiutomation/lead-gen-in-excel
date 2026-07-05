"use client";

// Thin wrapper over next-themes so the app can switch light/dark. next-themes owns
// the no-flash inline script + localStorage persistence — cheaper and more correct
// than a hand-rolled toggle (which flashes the wrong theme on first paint).
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
