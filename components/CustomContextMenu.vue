<template>
  <div class="list-group bg-solid-text context-menu shadow-sm">
    <slot></slot>
    <a
      v-for="(item, index) in menuItems"
      :key="index"
      href="#"
      tabindex="-1"
      class="list-group-item list-group-item-action"
      :class="{
        disabled: item.disabled,
        'list-group-item-danger': item.dangerous,
        'parent-menu-item': item.children && item.children.length > 0
      }"
      :style="item.topBorder ? { borderTopWidth: '1px' } : undefined"
      @click.prevent="onItemClick(item)"
    >
      <span v-if="item.iconClass" :class="item.iconClass" class="fa-fw"></span>
      <span class="action-label">{{ item.label }}</span>
      <span
        v-if="item.children && item.children.length > 0"
        class="fas fa-fw fa-caret-right"
        style="
          position: absolute;
          right: 10px;
          top: 50%;
          transform: translateY(-50%);
        "
      ></span>
      <custom-context-menu
        v-if="item.children && item.children.length > 0"
        :menu-items="item.children"
        class="child-menu"
      />
    </a>
  </div>
</template>

<script lang="ts">
  import Vue, { PropType } from 'vue';

  export interface ContextMenuItemProps {
    label: string;
    disabled?: boolean;
    onClick?: () => void;
    iconClass?: string;
    children?: ContextMenuItemProps[];
    topBorder?: boolean;
    dangerous?: boolean;
  }

  export default Vue.extend({
    name: 'CustomContextMenu',
    props: {
      menuItems: {
        type: Array as PropType<ContextMenuItemProps[]>,
        required: true
      }
    },
    methods: {
      onItemClick(item: ContextMenuItemProps): void {
        if (item.disabled) return;
        item.onClick?.();
      }
    }
  });
</script>

<style scoped lang="scss">
  .parent-menu-item {
    .child-menu {
      display: none;
      position: absolute;
      left: 100%;
      top: 0;
      z-index: 1000;
      min-width: 220px;
    }
    &:hover .child-menu {
      display: block;
    }
  }
  .context-menu {
    border-radius: 15px;
    max-width: 265px;

    & .list-group-item {
      padding: 3px 5px 3px 5px;
    }

    & .list-group-item-action {
      font-size: 1.04em;
      border-top-width: 0;
      border-top-style: solid;
      border-color: var(--bs-border-color);
    }
    .action-label {
      margin-left: 0.4rem;
    }
  }
</style>
