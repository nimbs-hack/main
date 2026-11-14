# Adding buttons to the left tool rail

The left vertical tool rail in `apps/web` is built from `ToolRegistry` (`apps/web/src/registry/toolRegistry.ts`). Each registered tool gets a rail button and a matching panel view.

## Registering a new tool

1. Create a feature component under `apps/web/src/features/<tool-name>/`.
2. Register the tool in `ToolRegistry` with a unique `id`, a short 3-letter `shortLabel`, a full `title`, an integer `order`, and a `render` function returning JSX.

```ts
reg.register({
  id: "slope-stats",
  shortLabel: "SLP",
  title: "Slope Statistics",
  order: 4,
  render: () => <SlopeStatsPanel />,
});
```

3. Use CSS variables from `apps/web/src/styles/tokens.css` and existing layout classes (`panel-header`, `readout-grid`, `chamfer-btn`, `toggle-row`) so the new panel matches the console design.
