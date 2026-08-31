<script setup lang="ts">
import { onMounted, ref } from "vue";

import { createSession, getCurrentUser, googleSignInUrl, listSessions, logout } from "../api";
import { navigateToDashboard, navigateToSession } from "../router";
import type { AuthUser, SessionSummary } from "../types";
import ThreadsBackground from "./ThreadsBackground.vue";

const sessions = ref<SessionSummary[]>([]);
const loading = ref(true);
const error = ref<string | undefined>();
const openingId = ref<string | undefined>();
const user = ref<AuthUser | null>(null);
const authLoading = ref(true);

onMounted(async () => {
  try {
    sessions.value = await listSessions();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load sessions";
  } finally {
    loading.value = false;
  }

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

async function open(session: SessionSummary): Promise<void> {
  if (openingId.value) return;
  openingId.value = session.id;
  error.value = undefined;
  try {
    const created = await createSession(session.id);
    navigateToSession(created.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to create session";
  } finally {
    openingId.value = undefined;
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
      </div>
    </header>

    <p v-if="loading" class="launcher-status">Loading sessions…</p>
    <p v-else-if="error" class="launcher-status error">{{ error }}</p>

    <section v-else class="session-grid">
      <button
        v-for="session in sessions"
        :key="session.id"
        type="button"
        class="session-card"
        :disabled="Boolean(openingId)"
        @click="open(session)"
      >
        <span class="session-card-title">{{ session.title }}</span>
        <span class="session-card-project">{{ session.projectName }}</span>
        <span class="session-card-description">{{ session.description }}</span>
        <span class="session-card-meta">{{ session.taskTimestamp }}</span>
        <span v-if="openingId === session.id" class="session-card-meta">Opening…</span>
      </button>
    </section>
  </main>
</template>
