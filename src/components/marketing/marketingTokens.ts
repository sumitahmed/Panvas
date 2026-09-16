// ============================================
// Panvas — Marketing Design Tokens & Data
// Canonical terminology matching release.md
// ============================================

import React from 'react';
import {
  BookOpen,
  PenTool,
  FileText,
  Compass,
  HardDrive,
  Sigma,
  Code2,
  Mic,
  FolderTree,
  FolderOpen,
  Search,
  Command,
  Zap,
  Sparkles,
  RefreshCw,
  Eye,
  Sliders,
  FileDown,
  LayoutGrid
} from 'lucide-react';

export const CAPABILITIES: { label: string; icon: React.ReactNode }[] = [
  { label: 'Structured Notebooks', icon: React.createElement(BookOpen, { size: 14 }) },
  { label: 'Vector Ink Engine', icon: React.createElement(PenTool, { size: 14 }) },
  { label: 'In-Place PDF Markup', icon: React.createElement(FileText, { size: 14 }) },
  { label: 'Infinite Spatial Canvas', icon: React.createElement(Compass, { size: 14 }) },
  { label: '5-Tier Hierarchy', icon: React.createElement(FolderTree, { size: 14 }) },
  { label: 'KaTeX Math Equations', icon: React.createElement(Sigma, { size: 14 }) },
  { label: 'Lowlight Code Blocks', icon: React.createElement(Code2, { size: 14 }) },
  { label: 'Page Audio Notes', icon: React.createElement(Mic, { size: 14 }) },
  { label: 'Local-First Storage', icon: React.createElement(HardDrive, { size: 14 }) },
  { label: 'Ink Gestures & Snapping', icon: React.createElement(Zap, { size: 14 }) },
  { label: 'Digital Drafting Ruler', icon: React.createElement(Sliders, { size: 14 }) },
  { label: 'PDF Export', icon: React.createElement(FileDown, { size: 14 }) },
  { label: 'WinRT Handwriting to Text', icon: React.createElement(Sparkles, { size: 14 }) },
  { label: 'Nested Folder Shelf', icon: React.createElement(FolderOpen, { size: 14 }) },
  { label: 'Command Palette', icon: React.createElement(Command, { size: 14 }) },
  { label: 'Deterministic Local Search', icon: React.createElement(Search, { size: 14 }) },
  { label: 'Optional Google Drive Sync', icon: React.createElement(RefreshCw, { size: 14 }) },
  { label: 'Presentation Laser', icon: React.createElement(Eye, { size: 14 }) },
  { label: 'Paper & Ink Templates', icon: React.createElement(LayoutGrid, { size: 14 }) },
];

export interface FaqItem {
  question: string;
  answer: string;
  category: 'storage' | 'platform' | 'features' | 'cloud';
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    question: 'How does Panvas store my data?',
    answer: 'Panvas is local-first. On Windows Desktop (Electron), your files and notebooks are stored directly on your local filesystem under your Documents directory (%USERPROFILE%\\Documents\\Panvas). In the Web application, your workspaces are saved in origin-scoped IndexedDB (Dexie). Your device is always the canonical source of truth.',
    category: 'storage',
  },
  {
    question: 'Do I need an account or subscription to use Panvas?',
    answer: 'No. Panvas requires zero mandatory accounts, zero passwords, and zero credit cards to create, draw, write, annotate PDFs, and organize workspaces. Local notes require no hosted Panvas database and run completely on your device.',
    category: 'storage',
  },
  {
    question: 'What is the difference between Notebooks and Canvas?',
    answer: 'Notebooks provide structured, page-based technical writing with tactile covers, section tabs, paper templates (Cornell, dot grid, ruled, engineering grid), TipTap rich text, KaTeX equations, and vector ink directly on pages. The Canvas provides an infinite freeform whiteboard powered by Excalidraw with embedded floating text, formula blocks, and system diagrams.',
    category: 'features',
  },
  {
    question: 'Can I annotate and export multi-page PDFs?',
    answer: 'Yes. Panvas includes an in-place PDF workbench powered by local PDF.js. You can import documents, view page thumbnails, rotate pages, draw vector annotations with pressure pens and highlighters, and export your annotated pages or notebooks back to PDF.',
    category: 'features',
  },
  {
    question: 'How does Cloud Sync work with Google Drive?',
    answer: 'Cloud sync is an optional, provider-neutral capability designed to synchronize your local workspace across your devices without storing your notes on proprietary Panvas servers. It uses direct Google OAuth (Authorization Code + PKCE on desktop, Google Identity Services on web) requesting only drive.file scope. Because runtime certification is in progress, sync is disabled by default and local storage remains authoritative.',
    category: 'cloud',
  },
  {
    question: 'What platforms are currently supported?',
    answer: 'Panvas V1 targets Windows 10/11 (64-bit desktop application with native WinRT handwriting recognition) and modern Chromium browsers (Chrome, Edge, Brave). Firefox and Safari are supported on a best-effort basis. Native macOS and Linux installer builds are planned for future roadmap milestones.',
    category: 'platform',
  },
];

export const TECHNICAL_MARKS = {
  coordinateTopLeft: '[0,0]',
  versionTag: 'v0.1.1 // RELEASE',
  sectionH1: 'SEC-H1',
  sectionH2: 'SEC-H2',
  gridAlpha: 'GRID-α',
  storageAuthority: 'LOCAL FILESYSTEM & DEXIE IDB',
  engineVersion: 'PANVAS CORE V0.1.1',
};

export const MOTION_VARIANTS = {
  container: {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        staggerChildren: 0.1,
        delayChildren: 0.05,
      },
    },
  },
  item: {
    hidden: { opacity: 0, y: 16 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] },
    },
  },
};
