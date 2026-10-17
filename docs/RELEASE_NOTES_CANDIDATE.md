# Panvas 0.1.8-rc.1 — local review candidate

Unpublished. This candidate includes the current uncommitted documentation/stabilization work. It is not a declaration of stable-release acceptance.

- Technical document flow with A4 continuation, code languages/copy/wrap, tables, math and rich PDF export.
- Selection-correct text highlighting, persistent highlighting/erasing gestures and a rolling six-color palette.
- Compact workspace navigation and storage/account information derived from actual local/provider state.
- Portable backup media, targeted drawing/persistence performance work and expanded browser/Electron regression coverage.
- Desktop shared-media reads retain previous storage roots after a folder change, including an unavailable root from an older profile; no files are moved.
- Packaged desktop launches ignore inherited development-server URLs and retain the packaged renderer/IPC trust boundary.
- Web Docker production/development configurations, OSS setup/troubleshooting documentation and local build/checksum/package-audit helpers.
- CI validation and an explicitly manual future release workflow; no public action performed.

Windows NSIS and portable x64 binaries are unsigned. Signing, clean installer install/upgrade/uninstall in a disposable Windows environment, live authorized Google Drive/account acceptance and the owner's manual review remain release gates. Native custom-color picker completion also needs the final manual OS-dialog check. See the candidate QA report for measured results, remaining dependency advisories and exact evidence; do not infer a pass from this notes file.

Public download metadata continues to describe the already published 0.1.7 release. It must change only after a new approved upload is independently verified.
