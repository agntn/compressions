<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <CompressionsCallout kind="note" :title="title"><slot mdc-unwrap="p" /></CompressionsCallout>
</template>
