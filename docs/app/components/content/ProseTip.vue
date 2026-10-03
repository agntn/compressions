<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <CompressionsCallout kind="tip" :title="title"><slot mdc-unwrap="p" /></CompressionsCallout>
</template>
