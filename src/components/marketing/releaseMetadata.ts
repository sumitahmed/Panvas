// ============================================
// Panvas — Release & Distribution Metadata
// Canonical typed release parameters matching release.md
// ============================================

export interface WindowsReleaseMetadata {
  version: string;
  releaseTag: string;
  releaseDate: string;
  installerFileName: string;
  architecture: string;
  osRequirement: string;
  installerType: string;
  signingStatus: string;
  downloadUrl: string;
  releaseNotesUrl: string;
  checksumUrl: string;
  checksumSha256: string;
  installerSize: string;
  checksumVerificationNote: string;
}

export interface WebDistributionMetadata {
  appRoute: string;
  libraryRoute: string;
  storageEngine: string;
  primaryBrowsers: string[];
  caveatBrowsers: string;
}

export interface ProjectMetadata {
  name: string;
  tagline: string;
  description: string;
  version: string;
  year: number;
  githubRepoUrl: string;
  githubReleasesUrl: string;
  githubIssuesUrl: string;
  creatorGithubUrl: string;
  creatorWebsiteUrl: string;
  creatorEmailUrl: string;
  license: string;
}

export const PANVAS_RELEASE = {
  project: {
    name: 'Panvas',
    tagline: 'Local-First Visual Research Workspace',
    description: 'A local-first visual workspace where structured notebooks, vector handwriting, PDF annotation, infinite canvas, and technical thinking live together.',
    version: '0.1.2',
    year: 2026,
    githubRepoUrl: 'https://github.com/sumitahmed/Panvas',
    githubReleasesUrl: 'https://github.com/sumitahmed/Panvas/releases',
    githubIssuesUrl: 'https://github.com/sumitahmed/Panvas/issues',
    creatorGithubUrl: 'https://github.com/sumitahmed',
    creatorWebsiteUrl: 'https://sumitahmed.me/',
    creatorEmailUrl: 'mailto:sksumitahmed007@gmail.com',
    license: 'MIT',
  },
  windows: {
    version: '0.1.2',
    releaseTag: 'v0.1.2',
    releaseDate: 'September 2026',
    installerFileName: 'Panvas-0.1.2-Setup.exe',
    architecture: 'x64 (64-bit)',
    osRequirement: 'Windows 10 (1809+) / Windows 11 (64-bit)',
    installerType: 'NSIS Setup Wizard',
    signingStatus: 'Unsigned (v0.1.2); verify SHA-256 checksum',
    downloadUrl: 'https://github.com/sumitahmed/Panvas/releases/download/v0.1.2/Panvas-0.1.2-Setup.exe',
    releaseNotesUrl: 'https://github.com/sumitahmed/Panvas/releases/tag/v0.1.2',
    checksumUrl: 'https://github.com/sumitahmed/Panvas/releases/download/v0.1.2/SHA256SUMS.txt',
    checksumSha256: '1bd99a9b292d308dfd420b4a1abccfe34dc08cdc50b75f9ad806f612b9121d3c',
    installerSize: '265,324,472 bytes',
    checksumVerificationNote: 'Verify the installer against the official SHA-256 checksum published on the GitHub Releases page.',
  },
  web: {
    appRoute: '/app',
    libraryRoute: '/app/library',
    storageEngine: 'Origin-scoped Dexie IndexedDB (Local System of Record)',
    primaryBrowsers: ['Google Chrome', 'Microsoft Edge', 'Brave (Chromium 120+)'],
    caveatBrowsers: 'Firefox (Gecko 125+) and Safari (WebKit 17+) supported on best-effort basis',
  },
} as const;
