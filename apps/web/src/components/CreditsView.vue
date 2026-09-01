<script setup lang="ts">
import { onMounted, ref } from "vue";

import { getBillingSummary, grantDevCredits } from "../api";
import type { BillingSummary } from "../types";
import TopAppNav from "./TopAppNav.vue";

const summary = ref<BillingSummary | null>(null);
const loading = ref(true);
const error = ref<string | undefined>();
const grantingPackageId = ref<string | undefined>();

async function load(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    summary.value = await getBillingSummary();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load billing summary";
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function grant(packageId: string): Promise<void> {
  grantingPackageId.value = packageId;
  error.value = undefined;
  try {
    summary.value = await grantDevCredits(packageId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to grant credits";
  } finally {
    grantingPackageId.value = undefined;
  }
}
</script>

<template>
  <TopAppNav active="credits" />
  <main class="dashboard credits">
    <p v-if="loading" class="dashboard-status">Loading credits…</p>
    <p v-else-if="error" class="dashboard-status error">{{ error }}</p>

    <template v-else-if="summary">
      <header class="dashboard-header">
        <div>
          <p class="dashboard-user-name">Credits</p>
          <p class="dashboard-user-plan">Balance: {{ summary.balance }}</p>
        </div>
      </header>

      <p class="credits-disclaimer">
        This page issues <strong>development / test credits</strong> only. It is not connected to a
        real payment provider and never charges a card.
      </p>

      <section v-if="summary.devGrantsEnabled" class="credits-package-grid">
        <button
          v-for="pkg in summary.devGrantPackages"
          :key="pkg.id"
          type="button"
          class="dashboard-project-card credits-package-card"
          :disabled="grantingPackageId === pkg.id"
          @click="grant(pkg.id)"
        >
          <span class="dashboard-project-title">Test credits</span>
          <span class="dashboard-project-name">{{ pkg.label }}</span>
          <span class="dashboard-project-description">{{ pkg.credits }} credits</span>
        </button>
      </section>
      <p v-else class="dashboard-status">
        Development credit grants are disabled in this environment.
      </p>
    </template>
  </main>
</template>
