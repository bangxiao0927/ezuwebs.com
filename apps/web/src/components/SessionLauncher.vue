<script setup lang="ts">
import { onMounted, ref } from "vue";

import { createSession, getCurrentUser, googleSignInUrl, listSessions, logout } from "../api";
import { navigateToSession } from "../router";
import type { AuthUser, SessionSummary } from "../types";

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
  await logout();
  user.value = null;
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
      <div class="launcher-auth">
        <span v-if="authLoading" class="launcher-auth-status">Checking sign-in…</span>
        <template v-else-if="user">
          <span class="launcher-auth-status">Signed in as {{ user.name ?? user.email }}</span>
          <button type="button" class="launcher-auth-button" @click="signOut">Sign out</button>
        </template>
        <button v-else type="button" class="launcher-auth-button" @click="signInWithGoogle">
          Sign in with Google
        </button>
      </div>
      <p class="eyebrow">ezuwebs.com</p>
      <h1>AI Web Building Workspace</h1>
      <p class="lede">
        前后端分离架构：Vue 前端负责渲染会话工作台，Node 后端负责运行 agent、归并事件并生成预览。
        选择一个 demo 会话进入工作台。
      </p>
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
