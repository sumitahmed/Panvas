// ============================================
// Panvas — Settings Layout
// ============================================

import React, { useEffect, useRef } from 'react';
import { useRoute, useLocation, Link } from 'wouter';
import { User, Palette, HardDrive, Info, X } from 'lucide-react';
import { AccountSection } from './sections/AccountSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { WorkspaceSection } from './sections/WorkspaceSection';
import { AboutSection } from './sections/AboutSection';

const SETTINGS_TABS = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'workspace', label: 'Workspace', icon: HardDrive },
  { id: 'about', label: 'About', icon: Info },
];

export function SettingsLayout() {
  const [, params] = useRoute('/app/settings/:tab*');
  const [, navigate] = useLocation();
  
  // Default to account tab if no specific tab is provided
  const activeTab = SETTINGS_TABS.some(tab => tab.id === params?.['tab*']) ? params!['tab*'] : 'account';
  const dialogRef = useRef<HTMLDivElement>(null);

  // Handle escape key to close settings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        navigate('/app');
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled])')].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); if (previous?.isConnected) previous.focus(); };
  }, [navigate]);

  return (
    <div ref={dialogRef} className="panvas-layer-modal fixed inset-0 flex flex-col overflow-hidden bg-panvas-bg-primary animate-in fade-in duration-200 sm:flex-row" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      
      {/* Sidebar Navigation */}
      <aside className="flex w-full shrink-0 flex-col border-b border-panvas-border-subtle bg-panvas-bg-secondary/78 pt-4 sm:w-52 sm:border-b-0 sm:border-r sm:pt-6">
        <div className="mb-3 flex items-center justify-between px-5 sm:mb-7 sm:px-6">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-panvas-text-secondary">Panvas</p>
            <h1 id="settings-title" className="mt-1 text-xl font-semibold tracking-tight text-panvas-text-primary">Settings</h1>
          </div>
        </div>
        
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 sm:flex-1 sm:block sm:space-y-1 sm:overflow-visible sm:pb-0" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <Link key={tab.id} href={`/app/settings/${tab.id}`} aria-current={isActive ? 'page' : undefined} className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-ring ${
                  isActive 
                    ? 'bg-panvas-bg-tertiary text-panvas-text-primary' 
                    : 'text-panvas-text-secondary hover:text-panvas-text-primary hover:bg-panvas-bg-tertiary/50'
                }`}>
                  <Icon size={16} className={isActive ? 'text-panvas-text-primary' : 'text-panvas-text-muted'} />
                  {tab.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-panvas-bg-primary">
        <div className="absolute right-4 top-4 sm:right-6 sm:top-6">
          <button 
            type="button"
            onClick={() => navigate('/app')}
            className="panvas-icon-control focus-ring"
            title="Close Settings (Esc)"
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
        </div>

        <div className="w-full max-w-2xl flex-1 px-5 pb-8 pt-14 sm:mx-auto sm:px-8 sm:pt-10">
          {activeTab === 'account' && <AccountSection />}
          {activeTab === 'appearance' && <AppearanceSection />}
          {activeTab === 'workspace' && <WorkspaceSection />}
          {activeTab === 'about' && <AboutSection />}
        </div>
      </main>
    </div>
  );
}
