<script setup lang="ts">
import { computed } from "vue";

import type { PatchStrategy, WorkbenchViewModel, WorkspaceFile } from "../types";

const props = defineProps<{
  viewModel: WorkbenchViewModel;
  files: WorkspaceFile[];
  busy: boolean;
  onSelectBlock: (blockId: string) => void;
  onSubmitEdit: () => void;
}>();

const viewMode = defineModel<"preview" | "code" | "diff">("viewMode", { required: true });
const activeFile = defineModel<string | undefined>("activeFile", { required: true });
const intent = defineModel<string>("intent", { required: true });
const patchStrategy = defineModel<PatchStrategy>("patchStrategy", { required: true });

const propertyValues = defineModel<Record<string, string>>("propertyValues", { required: true });

const editor = computed(() => props.viewModel.webEditor);
const selectedBlockId = computed(() => editor.value.selectedBlockId);

const previewUrl = computed(() => {
  const port = props.viewModel.previews.at(-1);
  return port?.url;
});

const selectedDiff = computed(() => props.viewModel.selectedDiffAction);

const activeFileContent = computed(() => {
  const file = props.files.find((entry) => entry.path === activeFile.value);
  return file?.content ?? "Select a file to view its contents.";
});

const terminalLines = computed(() => {
  const lines: string[] = [];
  lines.push(`session runtime files: ${props.viewModel.files.length}`);
  for (const file of props.viewModel.files) {
    lines.push(`  • ${file}`);
  }
  for (const preview of props.viewModel.previews) {
    lines.push(`preview ready on :${preview.port}`);
  }
  if (props.viewModel.previews.length === 0) {
    lines.push("no preview port open yet");
  }
  return lines;
});
</script>

<template>
  <section class="panel workspace-column">
    <article class="card file-tree">
      <p class="eyebrow">Workspace files</p>
      <ul class="file-list">
        <li v-for="file in files" :key="file.path">
          <button
            type="button"
            :class="['file-row', { active: file.path === activeFile }]"
            @click="activeFile = file.path; viewMode = 'code'"
          >
            {{ file.path }}
          </button>
        </li>
        <li v-if="files.length === 0" class="empty-state">No workspace files loaded.</li>
      </ul>
    </article>

    <article class="card editor-card">
      <p class="eyebrow">Block editor</p>
      <div class="block-tabs">
        <button
          v-for="block in editor.blocks"
          :key="block.id"
          type="button"
          :class="['block-tab', { active: block.id === selectedBlockId }]"
          :disabled="busy"
          @click="onSelectBlock(block.id)"
        >
          {{ block.label }}
        </button>
      </div>

      <form class="editor-form" @submit.prevent="onSubmitEdit">
        <label class="field">
          <span>Intent</span>
          <textarea v-model="intent" rows="2" placeholder="Describe the change for the selected block…"></textarea>
        </label>

        <label class="field">
          <span>Patch strategy</span>
          <select v-model="patchStrategy">
            <option value="refine">refine</option>
            <option value="replace">replace</option>
            <option value="append">append</option>
          </select>
        </label>

        <div class="subgrid">
          <label v-for="property in editor.properties" :key="property.key" class="field">
            <span>{{ property.label }}</span>
            <input
              :value="propertyValues[property.key]"
              @input="propertyValues = { ...propertyValues, [property.key]: ($event.target as HTMLInputElement).value }"
              type="text"
            />
          </label>
        </div>

        <button type="submit" class="submit-button" :disabled="busy">Generate patch</button>
      </form>

      <div v-if="editor.suggestedPrompt" class="suggested-prompt">
        <p class="eyebrow">Suggested prompt</p>
        <p>{{ editor.suggestedPrompt }}</p>
      </div>
    </article>

    <article class="card surface-card">
      <div class="surface-tabs">
        <button type="button" :class="['surface-tab', { active: viewMode === 'preview' }]" @click="viewMode = 'preview'">Preview</button>
        <button type="button" :class="['surface-tab', { active: viewMode === 'code' }]" @click="viewMode = 'code'">Code</button>
        <button type="button" :class="['surface-tab', { active: viewMode === 'diff' }]" @click="viewMode = 'diff'">Diff</button>
      </div>

      <div class="surface-body">
        <template v-if="viewMode === 'preview'">
          <iframe v-if="previewUrl" class="preview-frame" :src="previewUrl" title="Session preview"></iframe>
          <div v-else class="empty-state">No preview available yet. Generate a patch to open one.</div>
        </template>

        <template v-else-if="viewMode === 'code'">
          <div class="code-header">{{ activeFile ?? "No file selected" }}</div>
          <pre class="code-block">{{ activeFileContent }}</pre>
        </template>

        <template v-else>
          <div v-if="selectedDiff" class="diff-pane">
            <div class="code-header">{{ selectedDiff.action.path }}</div>
            <pre class="code-block">{{ selectedDiff.action.patch }}</pre>
          </div>
          <div v-else class="empty-state">No patch actions to diff yet.</div>
        </template>
      </div>
    </article>

    <article class="card terminal-card">
      <p class="eyebrow">Terminal</p>
      <pre class="terminal-body">{{ terminalLines.join("\n") }}</pre>
    </article>
  </section>
</template>
