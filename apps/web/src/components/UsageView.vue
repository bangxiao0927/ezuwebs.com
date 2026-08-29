<script setup lang="ts">
import { onMounted, ref } from "vue";

import { getBillingSummary, getUsage } from "../api";
import { nextOffset, previousOffset } from "../lib/usagePagination";
import { navigateHome, navigateToCredits, navigateToDashboard } from "../router";
import type { BillingSummary, UsagePage } from "../types";

const balance = ref<BillingSummary | null>(null);
const usage = ref<UsagePage | null>(null);
const loading = ref(true);
const error = ref<string | undefined>();
const offset = ref(0);
const limit = 20;

async function load(offsetToLoad: number): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    const [summary, page] = await Promise.all([
      getBillingSummary(),
      getUsage({ limit, offset: offsetToLoad }),
    ]);
    balance.value = summary;
    usage.value = page;
    offset.value = offsetToLoad;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load usage";
  } finally {
    loading.value = false;
  }
}

onMounted(() => load(offset.value));

function nextPage(): void {
  void load(nextOffset(offset.value, limit));
}

function previousPage(): void {
  void load(previousOffset(offset.value, limit));
}
</script>

<template>
  <main class="dashboard usage">
    <p v-if="loading" class="dashboard-status">Loading usage…</p>
    <p v-else-if="error" class="dashboard-status error">{{ error }}</p>

    <template v-else-if="balance && usage">
      <header class="dashboard-header">
        <div>
          <p class="dashboard-user-name">Usage</p>
          <p class="dashboard-user-plan">
            Balance: {{ balance.balance }} &middot; Total consumed: {{ usage.totalCreditsConsumed }}
          </p>
        </div>
        <div class="dashboard-header-actions">
          <button type="button" class="dashboard-home-button" @click="navigateToCredits">Credits</button>
          <button type="button" class="dashboard-home-button" @click="navigateToDashboard">Dashboard</button>
          <button type="button" class="dashboard-home-button" @click="navigateHome">Back to launcher</button>
        </div>
      </header>

      <p v-if="usage.events.length === 0" class="dashboard-status">
        No usage recorded yet.
      </p>

      <section v-else class="usage-event-list">
        <article v-for="event in usage.events" :key="event.id" class="dashboard-project-card usage-event-card">
          <span class="dashboard-project-title">{{ event.kind }}</span>
          <span class="dashboard-project-name">{{ event.credits }} credits</span>
          <span class="dashboard-project-description" v-if="event.model">Model: {{ event.model }}</span>
          <span class="dashboard-project-meta">{{ event.createdAt }}</span>
        </article>
      </section>

      <div v-if="usage.events.length > 0" class="usage-pagination">
        <button type="button" class="dashboard-home-button" :disabled="offset === 0" @click="previousPage">
          Previous
        </button>
        <button
          type="button"
          class="dashboard-home-button"
          :disabled="offset + limit >= usage.total"
          @click="nextPage"
        >
          Next
        </button>
      </div>
    </template>
  </main>
</template>
