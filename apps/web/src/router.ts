import { onMounted, onUnmounted, ref } from "vue";

export interface Route {
  name: "launcher" | "session";
  sessionId?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#/, "");
  const match = /^\/session\/([^/?#]+)/.exec(hash);
  if (match) {
    return { name: "session", sessionId: decodeURIComponent(match[1]!) };
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
