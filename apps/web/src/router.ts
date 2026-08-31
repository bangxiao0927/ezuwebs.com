import { onMounted, onUnmounted, ref } from "vue";

import { parseHash } from "./lib/hashRoute";

export type { Route } from "./lib/hashRoute";

export function useRoute() {
  const route = ref(parseHash(window.location.hash));

  const update = () => {
    route.value = parseHash(window.location.hash);
  };

  onMounted(() => window.addEventListener("hashchange", update));
  onUnmounted(() => window.removeEventListener("hashchange", update));

  return route;
}

export function navigateToSession(sessionId: string): void {
  window.location.hash = `#/session/${encodeURIComponent(sessionId)}`;
}

export function navigateHome(): void {
  window.location.hash = "";
}

export function navigateToSelect(): void {
  window.location.hash = "#/select";
}

export function navigateToDashboard(): void {
  window.location.hash = "#/dashboard";
}

export function navigateToCredits(): void {
  window.location.hash = "#/credits";
}

export function navigateToUsage(): void {
  window.location.hash = "#/usage";
}
