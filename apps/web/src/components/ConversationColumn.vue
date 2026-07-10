<script setup lang="ts">
import { computed } from "vue";

import type { WorkbenchViewModel } from "../types";

const props = defineProps<{
  viewModel: WorkbenchViewModel;
  description: string;
  busy: boolean;
  onSend: () => void;
  onApprove: () => void;
  onReject: () => void;
}>();

const composer = defineModel<string>("composer", { required: true });
const rejectReason = defineModel<string>("rejectReason", { required: true });

const pending = computed(() => props.viewModel.pendingInteraction);
const approval = computed(() => props.viewModel.approvalDecision);

function planStatusLabel(status: string): string {
  return status.replace("_", " ");
}
</script>

<template>
  <section class="panel conversation">
    <article class="card description-card">
      <p class="eyebrow">Project brief</p>
      <p class="description-text">{{ description }}</p>
    </article>

    <article class="card">
      <p class="eyebrow">Conversation</p>
      <ul class="chat-list">
        <li v-for="message in viewModel.chatMessages" :key="message.id" :class="['chat-row', message.role]">
          <span class="chat-role">{{ message.role }}</span>
          <span class="chat-content">{{ message.content }}</span>
        </li>
        <li v-if="viewModel.chatMessages.length === 0" class="empty-state">No messages yet.</li>
      </ul>
    </article>

    <article class="card">
      <p class="eyebrow">Plan</p>
      <ol class="plan-list">
        <li v-for="step in viewModel.plan" :key="step.id" :class="['plan-row', step.status]">
          <span class="plan-status">{{ planStatusLabel(step.status) }}</span>
          <div class="plan-body">
            <strong>{{ step.title }}</strong>
            <span v-if="step.description">{{ step.description }}</span>
          </div>
        </li>
        <li v-if="viewModel.plan.length === 0" class="empty-state">No plan steps.</li>
      </ol>
    </article>

    <article v-if="pending && pending.type === 'confirm'" class="card approval-card">
      <p class="eyebrow">Approval required</p>
      <strong>{{ pending.title }}</strong>
      <p class="description-text">{{ pending.summary }}</p>
      <label class="field">
        <span>Rejection reason (optional)</span>
        <textarea v-model="rejectReason" rows="2" placeholder="Why should the patch be replaced?"></textarea>
      </label>
      <div class="approval-actions">
        <button type="button" class="approve-button" :disabled="busy" @click="onApprove">Approve patch</button>
        <button type="button" class="reject-button" :disabled="busy" @click="onReject">Reject &amp; replace</button>
      </div>
    </article>

    <article v-else-if="approval" :class="['card', approval.status === 'approved' ? 'approval-success-card' : 'approval-reject-card']">
      <p class="eyebrow">Last decision</p>
      <strong>{{ approval.title }}</strong>
      <p class="description-text">{{ approval.summary }}</p>
      <p v-if="approval.rejectionReason" class="description-text dim">Reason: {{ approval.rejectionReason }}</p>
    </article>

    <article class="card">
      <p class="eyebrow">Action timeline</p>
      <ul class="timeline-list">
        <li v-for="action in viewModel.actions" :key="action.id" class="timeline-row">
          <span :class="['timeline-status', action.status]">{{ action.status }}</span>
          <div class="timeline-body">
            <strong>{{ action.action.type }}</strong>
            <span v-if="action.action.path">{{ action.action.path }}</span>
            <span v-else-if="action.action.command">{{ action.action.command }}</span>
            <span v-else-if="action.action.title">{{ action.action.title }}</span>
          </div>
          <span class="timeline-source">{{ action.source }}</span>
        </li>
        <li v-if="viewModel.actions.length === 0" class="empty-state">No actions yet.</li>
      </ul>
    </article>

    <form class="composer" @submit.prevent="onSend">
      <input
        v-model="composer"
        type="text"
        placeholder="Send a prompt into this session…"
        :disabled="busy"
      />
      <button type="submit" class="submit-button" :disabled="busy">Send</button>
    </form>
  </section>
</template>
