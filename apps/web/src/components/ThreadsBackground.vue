<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import { mountThreadsBackground } from "../lib/mountThreadsBackground";

const container = ref<HTMLDivElement | null>(null);
const fallback = ref(false);

let cleanup: (() => void) | undefined;

onMounted(() => {
  const target = container.value;
  if (!target) return;
  cleanup = mountThreadsBackground(target, {
    onFallback: () => {
      fallback.value = true;
    },
  });
});

onBeforeUnmount(() => {
  cleanup?.();
  cleanup = undefined;
});
</script>

<template>
  <div ref="container" class="threads-background" :class="{ 'threads-background-fallback': fallback }"></div>
</template>

<style scoped>
.threads-background {
  position: absolute;
  inset: 0;
}

.threads-background-fallback {
  background: radial-gradient(circle at center, rgba(143, 208, 255, 0.16), rgba(17, 27, 42, 0.9));
}
</style>
