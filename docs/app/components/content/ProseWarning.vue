<script setup lang="ts">
defineProps<{ title?: string }>();
</script>

<template>
  <CompressionsCallout kind="warning" :title="title"><slot mdc-unwrap="p" /></CompressionsCallout>
</template>
