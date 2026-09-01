<script setup lang="ts">
import { onMounted, ref } from "vue";

import { getCurrentUser, googleSignInUrl, logout } from "../api";
import { NAV_ITEMS, navItemActive, type ActivePage } from "../lib/navItems";
import { navigateHome, navigateToCredits, navigateToDashboard, navigateToUsage } from "../router";
import type { AuthUser } from "../types";

const props = defineProps<{ active: ActivePage }>();

const user = ref<AuthUser | null>(null);
const authLoading = ref(true);

onMounted(async () => {
  try {
    user.value = await getCurrentUser();
  } catch {
    user.value = null;
  } finally {
    authLoading.value = false;
  }
});

function signInWithGoogle(): void {
  window.location.href = googleSignInUrl();
}

async function signOut(): Promise<void> {
  await logout();
  user.value = null;
  navigateHome();
}

const navHandlers: Record<(typeof NAV_ITEMS)[number]["id"], () => void> = {
  home: navigateHome,
  dashboard: navigateToDashboard,
  credits: navigateToCredits,
  usage: navigateToUsage,
};
</script>

<template>
  <nav class="top-app-nav" aria-label="Primary">
    <button type="button" class="top-app-nav-brand" @click="navigateHome">ezuwebs.com</button>

    <ul class="top-app-nav-links">
      <li v-for="item in NAV_ITEMS" :key="item.id">
        <button
          type="button"
          :class="['top-app-nav-link', { active: navItemActive(props.active, item.id) }]"
          :aria-current="navItemActive(props.active, item.id) ? 'page' : undefined"
          @click="navHandlers[item.id]()"
        >
          {{ item.label }}
        </button>
      </li>
    </ul>

    <div class="top-app-nav-auth">
      <span v-if="authLoading" class="top-app-nav-auth-status">Checking sign-in…</span>
      <template v-else-if="user">
        <span class="top-app-nav-auth-status">Signed in as {{ user.name ?? user.email }}</span>
        <button
          v-if="props.active !== 'dashboard'"
          type="button"
          class="top-app-nav-auth-button"
          @click="navigateToDashboard"
        >
          Dashboard
        </button>
        <button type="button" class="top-app-nav-auth-button" @click="signOut">Sign out</button>
      </template>
      <button v-else type="button" class="top-app-nav-auth-button" @click="signInWithGoogle">
        Sign in with Google
      </button>
    </div>
  </nav>
</template>
