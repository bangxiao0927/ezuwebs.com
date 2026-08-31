<script setup lang="ts">
import { onMounted, ref } from "vue";

import { getCurrentUser, googleSignInUrl, logout } from "../api";
import { navigateToDashboard, navigateToSelect } from "../router";
import type { AuthUser } from "../types";
import ThreadsBackground from "./ThreadsBackground.vue";

const user = ref<AuthUser | null>(null);
const authLoading = ref(true);
const error = ref<string | undefined>();

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
  error.value = undefined;
  try {
    await logout();
    user.value = null;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to sign out";
  }
}
</script>

<template>
  <main class="launcher">
    <header class="launcher-hero">
      <ThreadsBackground class="launcher-hero-threads" />
      <div class="launcher-auth">
        <span v-if="authLoading" class="launcher-auth-status">Checking sign-in…</span>
        <template v-else-if="user">
          <span class="launcher-auth-status">Signed in as {{ user.name ?? user.email }}</span>
          <button type="button" class="launcher-auth-button" @click="navigateToDashboard">Dashboard</button>
          <button type="button" class="launcher-auth-button" @click="signOut">Sign out</button>
        </template>
        <button v-else type="button" class="launcher-auth-button" @click="signInWithGoogle">
          Sign in with Google
        </button>
      </div>
      <div class="launcher-hero-copy">
        <p class="eyebrow">Threads Homepage</p>
        <h1>ezuwebs.com</h1>
        <p class="lede">
          AI based web IDE for building, previewing, and sharing web projects workspace.
        </p>
        <p class="launcher-meta">Make your own websites easier.</p>
        <button type="button" class="cta-button" @click="navigateToSelect">Start building</button>
        <p v-if="error" class="launcher-status error">{{ error }}</p>
      </div>
    </header>
  </main>
</template>
