<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { createSession, getCurrentUser, getDashboard, googleSignInUrl, listSessions, logout } from "../api";
import { navigateHome, navigateToDashboard, navigateToSession } from "../router";
import { recentProjects } from "../lib/recentProjects";
import type { AuthUser, DashboardProject, SessionSummary } from "../types";

const sessions = ref<SessionSummary[]>([]);
const loading = ref(true);
const error = ref<string | undefined>();
const openingId = ref<string | undefined>();
const user = ref<AuthUser | null>(null);
const authLoading = ref(true);
const projects = ref<DashboardProject[]>([]);
const resumeProjects = computed(() => recentProjects(projects.value));

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

  if (user.value) {
    try {
      projects.value = (await getDashboard()).projects;
    } catch {
      projects.value = [];
    }
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
    projects.value = [];
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

function resume(project: DashboardProject): void {
  navigateToSession(project.id);
}
</script>

<template>
  <main class="select">
    <header class="select-header">
      <button type="button" class="ghost-button" @click="navigateHome">&larr; Home</button>
      <div class="select-heading">
        <p class="eyebrow">Choose a workspace</p>
        <h1>Start a session</h1>
      </div>
      <div class="launcher-auth launcher-auth-static">
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
    </header>

    <p v-if="loading" class="launcher-status">Loading sessions…</p>
    <p v-else-if="error" class="launcher-status error">{{ error }}</p>

    <template v-else>
      <section v-if="resumeProjects.length > 0" class="select-section">
        <p class="eyebrow">Your recent projects</p>
        <div class="session-grid">
          <button
            v-for="project in resumeProjects"
            :key="project.id"
            type="button"
            class="session-card"
            @click="resume(project)"
          >
            <span class="session-card-title">{{ project.projectName }}</span>
            <span class="session-card-project">{{ project.taskTitle }}</span>
            <span class="session-card-description">{{ project.description }}</span>
            <span class="session-card-meta">Resume · {{ project.taskTimestamp }}</span>
          </button>
        </div>
      </section>

      <section class="select-section">
        <p v-if="resumeProjects.length > 0" class="eyebrow">Start something new</p>
        <div class="session-grid">
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
        </div>
      </section>
    </template>
  </main>
</template>
