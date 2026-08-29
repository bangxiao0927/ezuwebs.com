<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";

import {
  applyEdit,
  getSession,
  getWorkspaceFiles,
  resolveApproval,
  resolveChoice,
  resolveInput,
  selectBlock,
  sendPrompt,
} from "../api";
import { navigateHome } from "../router";
import type { PatchStrategy, Session, WorkspaceFile } from "../types";
import ConversationColumn from "./ConversationColumn.vue";
import WorkspaceColumn from "./WorkspaceColumn.vue";

const props = defineProps<{ sessionId: string }>();

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
const answerValue = ref("");
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
    const next = await getSession(props.sessionId);
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

watch(() => props.sessionId, load, { immediate: true });

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
  const interactionId = session.value?.viewModel.pendingInteraction?.id;
  if (!interactionId) {
    flashToast("This interaction is no longer pending.");
    return;
  }
  const next = await run(() => resolveApproval(session.value!.id, interactionId, decision, reason));
  if (next) {
    syncFromSession(next);
    flashToast(decision === "approved" ? "Patch approved." : "Patch rejected; replacement prompt prepared.");
  }
}

async function handleChoice(optionId: string): Promise<void> {
  const interactionId = session.value?.viewModel.pendingInteraction?.id;
  if (!interactionId) {
    flashToast("This interaction is no longer pending.");
    return;
  }
  const next = await run(() => resolveChoice(session.value!.id, interactionId, optionId));
  if (next) {
    syncFromSession(next);
    flashToast("Choice submitted.");
  }
}

async function handleAnswer(): Promise<void> {
  const value = answerValue.value.trim();
  const interactionId = session.value?.viewModel.pendingInteraction?.id;
  if (!interactionId) {
    flashToast("This interaction is no longer pending.");
    return;
  }
  if (!value) {
    flashToast("Type a response before submitting.");
    return;
  }
  const next = await run(() => resolveInput(session.value!.id, interactionId, value));
  if (next) {
    syncFromSession(next);
    answerValue.value = "";
    flashToast("Response submitted.");
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
        v-model:answer-value="answerValue"
        :busy="busy"
        :on-send="handlePrompt"
        :on-approve="() => handleApproval('approved')"
        :on-reject="() => handleApproval('rejected')"
        :on-choose="handleChoice"
        :on-answer="handleAnswer"
      />
      <WorkspaceColumn
        :view-model="viewModel"
        :files="files"
       :busy="busy"
       v-model:view-mode="viewMode"
       v-model:active-file="activeFile"
       v-model:intent="intent"
       v-model:patch-strategy="patchStrategy"
      v-model:property-values="propertyValues"
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
