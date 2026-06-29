<script setup lang="ts">
import { computed } from "vue";

import SessionLauncher from "./components/SessionLauncher.vue";
import WorkbenchView from "./components/WorkbenchView.vue";
import { useRoute } from "./router";

const route = useRoute();
const definitionId = computed(() => route.value.sessionId ?? "");
</script>

<template>
  <SessionLauncher v-if="route.name === 'launcher'" />
  <WorkbenchView v-else :definition-id="definitionId" :key="definitionId" />
</template>
