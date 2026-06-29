<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import {
  applyEdit,
  createSession,
  getWorkspaceFiles,
  resolveApproval,
  selectBlock,
  sendPrompt,
} from "../api";
import { navigateHome } from "../router";
import type { PatchStrategy, Session, WorkspaceFile } from "../types";
import ConversationColumn from "./ConversationColumn.vue";
import WorkspaceColumn from "./WorkspaceColumn.vue";

const props = defineProps<{ definitionId: string }>();

const session = ref<Session | null>(null);
const files = ref<WorkspaceFile[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | undefined>();
const toast = ref<string | undefined>();

const composer = ref("");
const intent = ref("");
const patchStrategy = ref<PatchStrategy>("refine");
const propertyValues = reactive<Record<string, string>>({});
const rejectReason = ref("");
const viewMode = ref<"preview" | "code" | "diff">("preview");
const activeFile = ref<string | undefined>();

const viewModel = computed(() => session.value?.viewModel ?? null);

function syncFromSession(next: Session): void {
  session.value = next;
  for (const key of Object.keys(propertyValues)) {
    delete propertyValues[key];
  }
  for (const property of next.viewModel.webEditor.properties) {
    propertyValues[property.key] = property.value;
  }
  if (!activeFile.value && files.value.length > 0) {
    activeFile.value = files.value[0]?.path;
  }
}

function flashToast(message: string): void {
  toast.value = message;
  window.setTimeout(() => {
    if (toast.value === message) {
      toast.value = undefined;
    }
  }, 2600);
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = undefined;
  try {
    const next = await createSession(props.definitionId);
    syncFromSession(next);
    files.value = await getWorkspaceFiles(next.id);
    if (files.value.length > 0) {
      activeFile.value = files.value[0]?.path;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load session";
  } finally {
    loading.value = false;
  }
}

watch(() => props.definitionId, load, { immediate: true });

async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) {
    return undefined;
  }
  busy.value = true;
  try {
    return await operation();
  } catch (cause) {
    flashToast(cause instanceof Error ? cause.message : "Request failed");
    return undefined;
  } finally {
    busy.value = false;
  }
}

async function handleSelectBlock(blockId: string): Promise<void> {
  const next = await run(() => selectBlock(session.value!.id, blockId));
  if (next) {
    syncFromSession(next);
  }
}

async function handleSubmitEdit(): Promise<void> {
  if (!session.value) {
    return;
  }
  const properties = session.value.viewModel.webEditor.properties.map((property) => ({
    ...property,
    value: propertyValues[property.key] ?? property.value,
  }));
  const next = await run(() =>
    applyEdit(session.value!.id, {
      intent: intent.value.trim() || session.value!.viewModel.webEditor.lastIntent || "Refine the selected block.",
      patchStrategy: patchStrategy.value,
      properties,
      runAgent: true,
    }),
  );
  if (next) {
    syncFromSession(next);
    flashToast("Generated a new block-scoped patch.");
  }
}

async function handlePrompt(): Promise<void> {
  const text = composer.value.trim();
  if (!text) {
    flashToast("Type a request before sending.");
    return;
  }
  const next = await run(() => sendPrompt(session.value!.id, text));
  if (next) {
    syncFromSession(next);
    composer.value = "";
    flashToast("Prompt routed into the active session.");
  }
}

async function handleApproval(decision: "approved" | "rejected"): Promise<void> {
  const reason = rejectReason.value.trim() || "Replacement requested.";
  const next = await run(() => resolveApproval(session.value!.id, decision, reason));
  if (next) {
    syncFromSession(next);
    flashToast(decision === "approved" ? "Patch approved." : "Patch rejected; replacement prompt prepared.");
  }
}
</script>

<template>
  <main class="workspace" v-if="!loading && session && viewModel">
    <header class="topbar">
      <div class="topbar-left">
        <button type="button" class="ghost-button" @click="navigateHome">← Sessions</button>
        <div class="topbar-title">
          <strong>{{ session.projectName }}</strong>
          <span>{{ session.taskTitle }} · {{ session.taskTimestamp }}</span>
        </div>
      </div>
      <div class="topbar-right">
        <span class="runtime-pill">runtime: {{ session.config.runtimeType }}</span>
        <span v-if="busy" class="runtime-pill busy">working…</span>
      </div>
    </header>

    <section class="layout">
      <ConversationColumn
        :view-model="viewModel"
        :description="session.description"
        v-model:composer="composer"
        v-model:reject-reason="rejectReason"
        :busy="busy"
        :on-send="handlePrompt"
        :on-approve="() => handleApproval('approved')"
        :on-reject="() => handleApproval('rejected')"
      />
      <WorkspaceColumn
        :view-model="viewModel"
        :files="files"
        :busy="busy"
        v-model:view-mode="viewMode"
        v-model:active-file="activeFile"
        v-model:intent="intent"
        v-model:patch-strategy="patchStrategy"
        :property-values="propertyValues"
        :on-select-block="handleSelectBlock"
        :on-submit-edit="handleSubmitEdit"
      />
    </section>

    <div v-if="toast" class="workspace-toast">{{ toast }}</div>
  </main>

  <main class="workspace-loading" v-else-if="loading">
    <p>Booting session workspace…</p>
  </main>

  <main class="workspace-loading" v-else>
    <p class="error">{{ error ?? "Session unavailable." }}</p>
    <button type="button" class="ghost-button" @click="navigateHome">← Back to sessions</button>
  </main>
</template>
