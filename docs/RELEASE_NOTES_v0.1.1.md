# Panvas v0.1.1 Hotfix

Panvas v0.1.1 is a targeted production hotfix resolving an Ink mode visual regression and unlocking full page and section lifecycle management directly from the compact navigation breadcrumbs.

## What's Changed

### 1. Ink Mode Visual Contrast Restored
- **Visual Warmth**: Restored the canonical warm-paper / autumn aesthetic (`#F7F4EB` / `rgb(247, 244, 235)`) for Ink Mode by reverting `:root` Light mode back to clean neutral white (`#FFFFFF` / `rgb(255, 255, 255)`).
- **Clear Mode Distinction**: Ink Mode now clearly and noticeably differs from Light Mode with muted, calm, desaturated UI tones without using an aggressive yellow overlay filter.
- **Strict Content Isolation**: Guaranteed zero color contamination across user canvas handwriting ink, pen palette presets, highlighter strokes, paper backgrounds (such as yellow legal pad and black slate), PDF documents, and imported images.

### 2. Compact Navigation Page & Section Management
- **Full In-Place Management**: When the 3-column navigation panel is collapsed, users can now create, rename, reorder, and delete sections and pages directly from the top breadcrumb dropdowns.
- **Inline Editing**: Click "Rename" or select from context menu to edit inline; press `Enter` to commit or `Escape` to cancel.
- **Context Actions Popover**: Each item provides a `...` action menu for Rename, Move Up, Move Down, and Delete.
- **Safe Persistence**: Built on top of existing workspace store actions with zero page reloads, zero entity ID regeneration, and full adjacent-item fallback on deletion.

## Availability & Downloads
- **Web App**: Live at [panvas.vercel.app/app](https://panvas.vercel.app/app)
- **Windows 10/11 (64-bit)**: `Panvas-0.1.1-Setup.exe` (265,322,528 bytes), distributed directly from this GitHub Release.
- **Web App**: [panvas.vercel.app/app](https://panvas.vercel.app/app), browser-local build using IndexedDB.
- **Project Site**: [panvas.vercel.app](https://panvas.vercel.app/)
- **Source Code**: [github.com/sumitahmed/Panvas](https://github.com/sumitahmed/Panvas)

## Installer Verification

The Windows installer is unsigned (v0.1.1); verify the SHA-256 checksum locally against `SHA256SUMS.txt`:

```powershell
Get-FileHash Panvas-0.1.1-Setup.exe -Algorithm SHA256
```

Expected SHA-256 hash:
`7c158949c74465bffd8c4f2ca9c753e05dd2401a83427c96b936a0fa2d6d207d`

