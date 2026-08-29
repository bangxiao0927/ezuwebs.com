<script setup lang="ts">
import { computed } from "vue";

import SessionLauncher from "./components/SessionLauncher.vue";
import WorkbenchView from "./components/WorkbenchView.vue";
import { useRoute } from "./router";

const route = useRoute();
const sessionId = computed(() => route.value.sessionId ?? "");
</script>

<template>
  <SessionLauncher v-if="route.name === 'launcher'" />
  <WorkbenchView v-else :session-id="sessionId" :key="sessionId" />
</template>
