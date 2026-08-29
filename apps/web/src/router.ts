import { onMounted, onUnmounted, ref } from "vue";

export interface Route {
  name: "launcher" | "session" | "dashboard" | "credits" | "usage";
  sessionId?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#/, "");
  const match = /^\/session\/([^/?#]+)/.exec(hash);
  if (match) {
    return { name: "session", sessionId: decodeURIComponent(match[1]!) };
  }
  if (/^\/dashboard/.test(hash)) {
    return { name: "dashboard" };
  }
  if (/^\/credits/.test(hash)) {
    return { name: "credits" };
  }
  if (/^\/usage/.test(hash)) {
    return { name: "usage" };
  }
  return { name: "launcher" };
}

export function useRoute() {
  const route = ref<Route>(parseHash());

  const update = () => {
    route.value = parseHash();
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

export function navigateToDashboard(): void {
  window.location.hash = "#/dashboard";
}

export function navigateToCredits(): void {
  window.location.hash = "#/credits";
}

export function navigateToUsage(): void {
  window.location.hash = "#/usage";
}
