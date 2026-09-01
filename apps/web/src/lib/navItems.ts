export type NavItemId = "home" | "dashboard" | "credits" | "usage";

/** Every page the top nav can render as the current location, including
 * pages with no matching top-level nav item. */
export type ActivePage = NavItemId | "select" | "session";

export interface NavItem {
  id: NavItemId;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: "home", label: "Home" },
  { id: "dashboard", label: "Dashboard" },
  { id: "credits", label: "Credits" },
  { id: "usage", label: "Usage" },
];

export function navItemActive(active: ActivePage, item: NavItemId): boolean {
  return active === item;
}
