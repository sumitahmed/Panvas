# Panvas v0.1.11

- Fixed text formatting and styling on Date and Mood template placeholder fields, supporting bold, italic, font styling, color, and undo/redo.
- Added persistent page bookmarks for notebook pages and PDF documents, with navigation indicators in the sidebar and thumbnail views.
- Added laser pointer duration (500ms–10,000ms) and inter-stroke trail connectivity controls.
- Restored authentic tool cursor designs (pen, pencil, highlighter, marker, eraser) for stylus/pen input with immediate tracking.
- Optimized multi-element selection transforms (translation, scaling, rotation) for smooth frame rendering on large stroke sets.
- Improved middle-mouse auto-scroll directional feedback and responsiveness.
- Updated production dependencies `dompurify` (3.4.17) and `zod` (4.6.7) to resolve upstream security advisories.

## Notes & Limitations

- Windows installer and portable executables are unsigned open-source binaries and may trigger Windows SmartScreen. Verify the published SHA-256 manifest before running them.
- Existing storage and application data are preserved across upgrades.
