<script setup>
import DefaultTheme from 'vitepress/theme-without-fonts'
import BuildStamp from './BuildStamp.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #doc-before><BuildStamp /></template>
  </Layout>
</template>
