# Design QA — iAtur Feature Accordions

- Source visual truth: `/Users/aruna/Library/Application Support/CleanShot/media/media_h2mrrMIDo9/CleanShot 2026-10-03 at 08.53.05@2x.png`
- Source pixels: 1176 × 616 at 2× density; used as a visual-pattern reference rather than a full-page layout specification.
- Implementation: `/iatur#fitur-iatur` rendered in the Codex in-app Browser; browser screenshot evidence was captured inline during this task (the browser API did not expose a persistent local screenshot path).
- Viewports checked: 900 × 700 desktop and 390 × 844 mobile at devicePixelRatio 1.
- States checked: first panel open, alternate panel open, remaining panels closed, one-open-at-a-time behavior, keyboard-accessible native disclosure controls.
- Primary interactions tested: opening a collapsed feature, closing the previous feature automatically, plus/minus state change, and responsive wrapping.
- Console errors checked: none.

## Full-view comparison evidence

The implementation follows the reference hierarchy: square toggle at the left, bold feature title, thin separators, open content below the active title, and compact collapsed rows. The active control uses the existing iAtur blue/indigo palette instead of the reference red, which is an intentional product-brand adaptation.

## Focused region comparison evidence

The feature-list region was inspected at desktop and mobile widths. Bootstrap Icons provide the plus/minus symbols; no placeholder or hand-drawn icon is used. Long Indonesian labels wrap without overlapping the icon or viewport. Open content retains the original article typography, lists, notes, and links.

## Required fidelity surfaces

- Fonts and typography: existing site font and weight hierarchy preserved; titles are bold and content remains readable.
- Spacing and layout rhythm: compact rows, consistent separators, and reference-like left alignment; mobile content removes desktop indentation to maximize readable width.
- Colors and visual tokens: black closed controls and branded blue/indigo open control, with accessible focus styling.
- Image and icon quality: official Bootstrap Icons SVG assets remain sharp at all tested sizes.
- Copy and content: all original feature titles, instructions, lists, and notes are preserved.

## Findings

No actionable P0, P1, or P2 differences remain. The wider article column and iAtur brand color are intentional adaptations to the existing production design system.

## Comparison history

- Initial mobile pass confirmed the compact closed-row layout and exposed the need to verify grouped behavior explicitly.
- Added the native shared `name="iatur-features"` group so opening one feature closes the previous feature.
- Post-fix desktop and mobile passes confirmed the grouped interaction, responsive wrapping, active-state icon, and content layout.

## Implementation checklist

- [x] Native accessible accordion controls
- [x] One open feature at a time
- [x] Plus/minus icon states
- [x] Desktop and mobile layout
- [x] Original content preserved
- [x] No browser console errors
- [x] Production build passes

final result: passed
