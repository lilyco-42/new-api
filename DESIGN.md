# Lain42 Agent design system

## Design read

This is a developer-facing AI workspace for people who need a quiet, fast place to research and ship work. The visual language is ChatGPT-inspired: dark neutral chrome, clear conversation hierarchy, a persistent composer, and utility panels that stay secondary.

## Tokens

- Canvas: `#212121` dark, `#ffffff` light.
- Sidebar: `#171717` dark, `#f7f7f8` light.
- Raised surface: `#2f2f2f` dark, `#ffffff` light.
- Text: `#ececec` dark, `#202123` light.
- Muted text: `#a6a6a6` dark, `#6b6b6b` light.
- Accent: `#10a37f` for primary actions and active states.
- Focus ring: `#7dd3fc` with a 2px visible outline.
- Radius: 8px controls, 12px cards, 16px composer.
- Spacing: 4px base with 8px rhythm.

## Typography

Use the existing system stack: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Chinese copy uses the platform CJK fallback. Body text stays at least 16px on mobile; utility labels may use 12px only when paired with a readable control.

## Layout

- Desktop: 260px navigation, flexible conversation column, optional 320px utility panel.
- Tablet: navigation collapses; utility panel becomes a drawer.
- Mobile: one column, full-width composer, horizontally scrollable tool shortcuts.
- Conversation content is capped at 760px for readable line length.

## Components

- App shell: sidebar plus conversation workspace.
- Conversation header: title, model/status, and utility actions.
- Message stream: clear role distinction with minimal borders.
- Composer: large rounded input, attachment/tool affordance, model selector, send/stop action.
- Tool cards: compact, secondary surfaces; never compete with the conversation.

## Interaction and accessibility

- Every icon button has an accessible label and visible focus state.
- Enter sends; Shift+Enter inserts a newline.
- Respect `prefers-reduced-motion`; use opacity and transform only for short transitions.
- Do not hide essential actions behind hover-only affordances.

## Agent prompt guide

When changing the Agent UI, preserve the routes and auth boundary, use existing shadcn primitives, keep text translatable, and verify desktop plus 375px mobile layouts. Compare against the reference hierarchy, not pixel-for-pixel proprietary assets.
