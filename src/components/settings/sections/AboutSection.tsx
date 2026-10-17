import React, { useEffect, useState } from 'react';
import { ExternalLink, Github, FileText, Shield } from 'lucide-react';
import { PANVAS_LOGO_SRC } from '@/lib/brand';
import { PANVAS_RELEASE } from '@/components/marketing/releaseMetadata';
import { version as packageVersion } from '../../../../package.json';
import { getCloudSyncPresentation } from '@/services/cloudsync/presentation';
import { settingsConnectionLabel, useSettingsCloudState } from '../SettingsCloudConnection';

const links = [
  { label: 'GitHub Repository', href: PANVAS_RELEASE.project.githubRepoUrl, icon: Github },
  { label: 'Privacy Policy', href: 'https://panvas.vercel.app/privacy', icon: Shield },
  { label: 'Terms of Service', href: 'https://panvas.vercel.app/terms', icon: FileText },
];

export function AboutSection() {
  const cloud = useSettingsCloudState();
  const [info, setInfo] = useState<Awaited<ReturnType<NonNullable<typeof window.panvas>['appInfo']>> | null>(null);
  const [infoError, setInfoError] = useState(false);
  useEffect(() => {
    let active = true;
    if (window.panvas) void window.panvas.appInfo().then(value => { if (active) setInfo(value); }).catch(() => { if (active) setInfoError(true); });
    return () => { active = false; };
  }, []);
  const build = import.meta.env.VITE_PANVAS_BUILD_ID;
  const platform = info ? ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[info.platform] ?? info.platform) : navigator.platform;
  return <div className="flex flex-col gap-6">
    <header className="pr-8"><h2 className="mb-1 text-xl font-semibold text-panvas-text-primary">About Panvas</h2><p className="text-sm text-panvas-text-secondary">Application information and product documents.</p></header>
    <section aria-label="Application information" className="panvas-surface p-4">
      <div className="flex items-center gap-4"><img src={PANVAS_LOGO_SRC} alt="" className="h-12 w-12 object-contain" /><div><h3 className="text-lg font-semibold text-panvas-text-primary">Panvas</h3><p className="text-sm text-panvas-text-secondary">Version {info?.version ?? packageVersion}{build ? ` (Build ${build})` : ''}</p></div></div>
      <dl className="mt-4 space-y-3 border-t border-panvas-border-subtle pt-4 text-sm">
        <div className="flex flex-wrap justify-between gap-2"><dt className="text-panvas-text-secondary">Runtime</dt><dd className="text-panvas-text-primary">{window.panvas ? info ? `Electron ${info.electron}` : infoError ? 'Desktop details unavailable' : 'Reading desktop details…' : 'Browser'} · {platform}</dd></div>
        {info && <div className="flex flex-wrap justify-between gap-2"><dt className="text-panvas-text-secondary">Chromium</dt><dd className="text-panvas-text-primary">{info.chromium}</dd></div>}
        <div className="flex flex-wrap justify-between gap-2"><dt className="text-panvas-text-secondary">Data</dt><dd className="text-panvas-text-primary">Local {window.panvas ? 'files' : 'browser storage'}</dd></div>
        <div className="flex flex-wrap justify-between gap-2"><dt className="text-panvas-text-secondary">Google Drive</dt><dd className="text-panvas-text-primary">{settingsConnectionLabel(cloud, getCloudSyncPresentation(cloud))}</dd></div>
      </dl>
    </section>
    <section aria-label="Links and legal" className="panvas-surface overflow-hidden">
      {links.map(({ label, href, icon: Icon }) => <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center justify-between gap-3 border-b border-panvas-border-subtle px-4 py-3 text-sm text-panvas-text-primary last:border-b-0 hover:bg-panvas-bg-hover focus-ring"><span className="flex items-center gap-3"><Icon size={16} aria-hidden="true" />{label}</span><ExternalLink size={14} aria-hidden="true" /></a>)}
    </section>
    <p className="text-xs text-panvas-text-secondary">Legal links open the published product documents in your browser.</p>
  </div>;
}
