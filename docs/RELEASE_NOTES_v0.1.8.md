# Panvas v0.1.8

- Block-based documentation editing with Markdown import/export, rich formatting, tables, links and LaTeX.
- Code language selection, syntax highlighting, copy and Wrap On/Off controls.
- Automatic A4 document continuation and infinite-height pages within the existing notebook system.
- Persistent text highlighting and erasing, accurate selection handling and a rolling six-color palette.
- Compact sidebar navigation, keyboard tree controls and clearer account/storage settings.
- Targeted populated-page rendering, ink snapshot and drawing-save performance improvements.
- Portable media backup/restore and rich-document PDF export improvements.
- Retained media lookup after storage-folder changes, including temporarily unavailable older roots; no files are moved.
- Packaged startup ignores inherited development-server URLs. Renderer isolation, validated IPC and atomic saves remain enabled.
- Docker web production/development setup, build/package checks and updated contributor documentation.

Windows installer and portable builds are unsigned and may trigger SmartScreen. Verify the SHA-256 manifest before running them. Upgrading retains the application identity and storage locations; uninstall is configured to preserve application data. Keep an independent backup.

Optional Google Drive synchronization retains its existing authorization and conflict model. Controlled recovery tests do not establish live two-account/provider acceptance. Browser data remains origin/profile scoped; keep the same production origin when upgrading.

The production npm dependency audit reports no findings. Development tooling retains 16 advisories (5 high, 11 moderate); no forced dependency migration or audit suppression was applied. Container scanning and final release evidence are recorded in the release verification report. Docker packages the stateless web frontend; it does not run the Windows desktop application or add a server database.
