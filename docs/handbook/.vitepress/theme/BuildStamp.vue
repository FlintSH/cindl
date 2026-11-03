<script setup>
import { computed } from 'vue'
import { useData } from 'vitepress'

const { theme } = useData()
const info = computed(() => theme.value.buildInfo)
const builtAt = computed(() => `${info.value.builtAt.slice(0, 16).replace('T', ' ')} UTC`)
</script>

<!-- Text spacing is explicit: Vue drops whitespace between elements, and
     screen readers and copied text need real spaces. -->
<template>
  <p class="build-stamp" data-build-stamp :data-commit="info.commit ?? 'unavailable'">
    <template v-if="info.commit">
      {{ 'Built from commit '
      }}<a :href="`${theme.repo}/commit/${info.commit}`" :title="info.commit"
        ><code>{{ info.shortCommit }}</code></a
      >
    </template>
    <template v-else>{{
      'Built without Git metadata; the source commit is unknown'
    }}</template>
    <template v-if="info.dirty">
      {{ ' ' }}<strong class="build-stamp-warning">with uncommitted changes</strong>
    </template>
    <template v-else-if="info.dirty === null">{{
      ' (working tree state unknown)'
    }}</template>
    {{ ' · ' }}<time :datetime="info.builtAt">{{ builtAt }}</time>
  </p>
</template>
