<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";

import {
  applyEdit,
  cancelRun as cancelRunRequest,
  createPromptRun,
  getSession,
  getWorkspaceFiles,
  listActiveRuns,
  resolveApproval,
  resolveChoice,
  resolveInput,
  selectBlock,
  streamRunEvents,
  type RunEventStreamHandle,
} from "../api";
import { classifyRequestOutcome, decideIdempotency } from "../lib/idempotency";
import { initialPropertyValues, propertiesWithValues } from "../lib/propertyValues";
import { applyRunEvent, createRunStreamState, type RunStreamState } from "../lib/runStream";
import { navigateHome } from "../router";
import type { PatchStrategy, RunDto, Session, WorkspaceFile } from "../types";
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
const propertyValues = ref<Record<string, string>>({});
const rejectReason = ref("");
const answerValue = ref("");
const viewMode = ref<"preview" | "code" | "diff">("preview");
const activeFile = ref<string | undefined>();

const pendingEditRequestId = ref<string | undefined>();
const pendingPromptRequestId = ref<string | undefined>();

const activeRun = ref<RunDto | undefined>();
const runConnectionState = ref<"connecting" | "live" | "reconnecting">("live");
const runStream = ref<RunStreamState>(createRunStreamState());
let runStreamHandle: RunEventStreamHandle | undefined;

const runStatusLabel = computed(() => {
  if (!activeRun.value) return undefined;
  if (runConnectionState.value === "reconnecting") return "reconnecting";
  return activeRun.value.status;
});

const canCancelRun = computed(() => {
  const status = activeRun.value?.status;
  return status === "queued" || status === "running";
});

/**
 * Reuses the same requestId across retries of the same user action so a
 * network retry cannot cause the backend to charge or run the agent twice.
 * Cleared by `runIdempotent` once the outcome is final (see decideIdempotency);
 * an unresolved outcome keeps this id so a manual retry safely replays it.
 */
function requestIdFor(pending: { value: string | undefined }): string {
  if (!pending.value) {
    pending.value = crypto.randomUUID();
  }
  return pending.value;
}

const viewModel = computed(() => {
  const base = session.value?.viewModel;
  if (!base) return null;
  const canonicalIds = new Set(base.chatMessages.map((message) => message.id));
  const liveMessages = runStream.value.messages
    .filter((message) => !canonicalIds.has(message.id))
    .map((message) => ({ id: message.id, role: message.role, content: message.text }));
  if (liveMessages.length === 0) return base;
  return { ...base, chatMessages: [...base.chatMessages, ...liveMessages] };
});

function syncFromSession(next: Session): void {
  session.value = next;
  propertyValues.value = initialPropertyValues(next.viewModel.webEditor.properties);
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
  disconnectRunStream();
  activeRun.value = undefined;
  runStream.value = createRunStreamState();
  try {
    const next = await getSession(props.sessionId);
    syncFromSession(next);
    files.value = await getWorkspaceFiles(next.id);
    if (files.value.length > 0) {
      activeFile.value = files.value[0]?.path;
    }
    await recoverActiveRun(next.id);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Failed to load session";
  } finally {
    loading.value = false;
  }
}

watch(() => props.sessionId, load, { immediate: true });

onUnmounted(() => {
  disconnectRunStream();
});

function disconnectRunStream(): void {
  runStreamHandle?.close();
  runStreamHandle = undefined;
}

/**
 * Attaches to a run's SSE stream, live-updating the conversation as
 * message.delta events arrive. On any terminal status the session is
 * refreshed once from the server, which is the source of truth for
 * everything other than the in-flight message text.
 */
function connectToRun(run: RunDto): void {
  disconnectRunStream();
  activeRun.value = run;
  runConnectionState.value = "live";
  runStream.value = createRunStreamState();

  runStreamHandle = streamRunEvents(session.value!.id, run.id, {
    onEvent: (entry) => {
      runConnectionState.value = "live";
      runStream.value = applyRunEvent(runStream.value, entry.event);
    },
    onStatus: (status) => {
      runConnectionState.value = "live";
      if (!activeRun.value || activeRun.value.id !== run.id) return;
      activeRun.value = { ...activeRun.value, status };
      if (status === "completed" || status === "failed" || status === "cancelled") {
        void finalizeRun(status);
      }
    },
    onReconnecting: () => {
      runConnectionState.value = "reconnecting";
    },
    onError: (error) => {
      disconnectRunStream();
      flashToast(error.message || "Lost connection to the run.");
      activeRun.value = undefined;
      runConnectionState.value = "live";
      runStream.value = createRunStreamState();
    },
  });
}

async function finalizeRun(status: RunDto["status"]): Promise<void> {
  disconnectRunStream();
  try {
    const next = await getSession(session.value!.id);
    syncFromSession(next);
  } catch {
    // A refresh failure here just leaves the streamed messages in place
    // until the next reload; the run itself has already finished.
  }
  if (status === "failed") {
    flashToast(activeRun.value?.error ?? "The run failed.");
  } else if (status === "cancelled") {
    flashToast("Run cancelled.");
  } else {
    flashToast("Prompt routed into the active session.");
  }
  activeRun.value = undefined;
  runStream.value = createRunStreamState();
}

/** Reattaches to a run left in flight by a previous page load, if any. */
async function recoverActiveRun(sessionId: string): Promise<void> {
  try {
    const [active] = await listActiveRuns(sessionId);
    if (active) {
      connectToRun(active);
    }
  } catch {
    // Recovery is best-effort: a failed lookup just starts the user fresh.
  }
}

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

/**
 * Like `run`, but for writes that carry an idempotency key: the pending
 * requestId is only cleared once the server outcome is known to be final
 * (success or a definitive 4xx). A network failure or an unrecognised 5xx
 * keeps the same requestId so a manual retry safely replays the attempt
 * instead of risking a duplicate charge or agent run.
 */
async function runIdempotent<T>(
  pending: { value: string | undefined },
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (busy.value) {
    return undefined;
  }
  busy.value = true;
  try {
    const result = await operation();
    pending.value = undefined;
    return result;
  } catch (cause) {
    if (decideIdempotency(classifyRequestOutcome(cause)) === "reset") {
      pending.value = undefined;
    }
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
  if (!session.value || busy.value) {
    return;
  }
  const properties = propertiesWithValues(session.value.viewModel.webEditor.properties, propertyValues.value);
  const requestId = requestIdFor(pendingEditRequestId);
  const next = await runIdempotent(pendingEditRequestId, () =>
    applyEdit(session.value!.id, {
      intent: intent.value.trim() || session.value!.viewModel.webEditor.lastIntent || "Refine the selected block.",
      patchStrategy: patchStrategy.value,
      properties,
      runAgent: true,
      requestId,
    }),
  );
  if (next) {
    syncFromSession(next);
    flashToast("Generated a new block-scoped patch.");
  }
}

async function handlePrompt(): Promise<void> {
  const text = composer.value.trim();
  if (busy.value || activeRun.value) {
    return;
  }
  if (!text) {
    flashToast("Type a request before sending.");
    return;
  }
  const requestId = requestIdFor(pendingPromptRequestId);
  const run = await runIdempotent(pendingPromptRequestId, () =>
    createPromptRun(session.value!.id, text, requestId),
  );
  if (run) {
    composer.value = "";
    connectToRun(run);
  }
}

async function handleCancelRun(): Promise<void> {
  if (!activeRun.value) return;
  await run(() => cancelRunRequest(session.value!.id, activeRun.value!.id));
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
        <span v-if="runStatusLabel" :class="['runtime-pill', 'run-status', runStatusLabel]">
          run: {{ runStatusLabel }}
        </span>
        <button
          v-if="canCancelRun"
          type="button"
          class="ghost-button"
          @click="handleCancelRun"
        >
          Cancel
        </button>
      </div>
    </header>

    <section class="layout">
      <ConversationColumn
        :view-model="viewModel"
        :description="session.description"
        v-model:composer="composer"
        v-model:reject-reason="rejectReason"
        v-model:answer-value="answerValue"
        :busy="busy || !!activeRun"
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

    <div v-if="toast" class="workspace-toast" role="status" aria-live="polite">{{ toast }}</div>
  </main>

  <main class="workspace-loading" v-else-if="loading">
    <p>Booting session workspace…</p>
  </main>

  <main class="workspace-loading" v-else>
    <p class="error">{{ error ?? "Session unavailable." }}</p>
    <button type="button" class="ghost-button" @click="navigateHome">← Back to sessions</button>
  </main>
</template>
