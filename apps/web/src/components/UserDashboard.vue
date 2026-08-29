<script setup lang="ts">
import { onMounted, ref } from "vue";

import { getDashboard, logout } from "../api";
import { navigateHome, navigateToSession } from "../router";
import type { Dashboard } from "../types";

const dashboard = ref<Dashboard | null>(null);
const loading = ref(true);
const error = ref<string | undefined>();

async function load(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    dashboard.value = await getDashboard();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load dashboard";
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function signOut(): Promise<void> {
  await logout();
  navigateHome();
}

function openProject(projectId: string): void {
  navigateToSession(projectId);
}
</script>

<template>
  <main class="dashboard">
    <p v-if="loading" class="dashboard-status">Loading dashboard…</p>
    <p v-else-if="error" class="dashboard-status error">{{ error }}</p>

    <template v-else-if="dashboard">
      <header class="dashboard-header">
        <div>
          <p class="dashboard-user-name">{{ dashboard.user.name ?? dashboard.user.email }}</p>
          <p class="dashboard-user-plan">Plan: {{ dashboard.user.plan }}</p>
        </div>
        <div class="dashboard-header-actions">
          <button type="button" class="dashboard-home-button" @click="navigateHome">Back to launcher</button>
          <button type="button" class="dashboard-signout-button" @click="signOut">Sign out</button>
        </div>
      </header>

      <p class="dashboard-counts">Projects: {{ dashboard.counts.totalProjects }}</p>

      <p v-if="dashboard.projects.length === 0" class="dashboard-status">
        You have not created any projects yet.
      </p>

      <section v-else class="dashboard-project-grid">
        <button
          v-for="project in dashboard.projects"
          :key="project.id"
          type="button"
          class="dashboard-project-card"
          @click="openProject(project.id)"
        >
          <span class="dashboard-project-title">{{ project.taskTitle }}</span>
          <span class="dashboard-project-name">{{ project.projectName }}</span>
          <span class="dashboard-project-description">{{ project.description }}</span>
          <span class="dashboard-project-meta">{{ project.taskTimestamp }}</span>
        </button>
      </section>
    </template>
  </main>
</template>
