<script setup lang="ts">
import { computed } from "vue";

import HomeLanding from "./components/HomeLanding.vue";
import SessionSelect from "./components/SessionSelect.vue";
import CreditsView from "./components/CreditsView.vue";
import UsageView from "./components/UsageView.vue";
import UserDashboard from "./components/UserDashboard.vue";
import WorkbenchView from "./components/WorkbenchView.vue";
import { useRoute } from "./router";

const route = useRoute();
const sessionId = computed(() => route.value.sessionId ?? "");
</script>

<template>
  <HomeLanding v-if="route.name === 'launcher'" />
  <SessionSelect v-else-if="route.name === 'select'" />
  <UserDashboard v-else-if="route.name === 'dashboard'" />
  <CreditsView v-else-if="route.name === 'credits'" />
  <UsageView v-else-if="route.name === 'usage'" />
  <WorkbenchView v-else :session-id="sessionId" :key="sessionId" />
</template>
