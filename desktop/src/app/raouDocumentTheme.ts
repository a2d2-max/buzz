export const RAOU_THEME = {
  "--accent": "204 12% 17%",
  "--accent-foreground": "102 14% 86%",
  "--background": "204 13% 7%",
  "--border": "204 12% 17%",
  "--card": "205 14% 10%",
  "--card-foreground": "102 14% 86%",
  "--foreground": "102 14% 86%",
  "--input": "204 12% 17%",
  "--muted": "205 14% 10%",
  "--muted-foreground": "104 8% 65%",
  "--popover": "205 14% 10%",
  "--popover-foreground": "102 14% 86%",
  "--primary": "78 100% 64%",
  "--primary-foreground": "204 13% 7%",
  "--ring": "78 100% 64%",
  "--secondary": "204 12% 17%",
  "--secondary-foreground": "102 14% 86%",
  "--sidebar": "205 16% 9%",
  "--sidebar-background": "205 16% 9%",
  "--sidebar-foreground": "102 14% 86%",
  "--sidebar-primary": "78 100% 64%",
  "--sidebar-primary-foreground": "204 13% 7%",
  "--sidebar-active": "78 100% 64%",
  "--sidebar-active-foreground": "204 13% 7%",
  "--sidebar-accent": "78 28% 16%",
  "--sidebar-accent-foreground": "78 100% 76%",
  "--sidebar-border": "204 12% 18%",
  "--sidebar-ring": "78 100% 64%",
} as const;

/**
 * Establish the RAOU palette at the document boundary before React renders.
 * Root ownership keeps body-level portals and the root error boundary on the
 * same forced-dark semantic tokens without mounting the legacy ThemeProvider.
 */
export function applyRaouDocumentTheme(documentRef: Document = document): void {
  const root = documentRef.documentElement;
  root.classList.remove("light");
  root.classList.add("dark");
  root.dataset.raouPrimary = "true";
  root.style.colorScheme = "dark";
  root.style.backgroundColor = "#101315";
  for (const [property, value] of Object.entries(RAOU_THEME)) {
    root.style.setProperty(property, value);
  }
}
