import type { ReactNode } from "react";

import {
  ThemeContext,
  type ThemeContextValue,
} from "@/shared/theme/ThemeProvider";

const ignorePreferenceChange = () => {};

const FIXED_DARK_THEME: ThemeContextValue = {
  accentColor: "#b8ff47",
  applyAppearance: ignorePreferenceChange,
  followSystem: false,
  glassBackground: false,
  glassBackgroundSupported: false,
  glassOpacity: 100,
  hasPair: false,
  isDark: true,
  isLoading: false,
  prominentActiveTab: false,
  selectedThemeName: "raou",
  setAccentColor: ignorePreferenceChange,
  setFollowSystem: ignorePreferenceChange,
  setGlassBackground: ignorePreferenceChange,
  setGlassOpacity: ignorePreferenceChange,
  setProminentActiveTab: ignorePreferenceChange,
  setTheme: ignorePreferenceChange,
  terminalPalette: null,
  themeName: "raou",
};

/** Supplies shared overlays with immutable dark-mode semantics for RAOU. */
export function FixedDarkThemeProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeContext.Provider value={FIXED_DARK_THEME}>
      {children}
    </ThemeContext.Provider>
  );
}
