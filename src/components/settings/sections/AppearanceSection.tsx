import React from 'react';
import { Moon, Sun, PenTool } from 'lucide-react';
import { useUIStore } from '@/stores/uiStore';

export function AppearanceSection() {
  const { theme, setTheme, fullDarkView, setFullDarkView } = useUIStore();

  return (
    <div className="flex flex-col gap-8 animate-in fade-in duration-300">
      <div>
        <h2 className="text-2xl font-semibold text-panvas-text-primary mb-2">Appearance</h2>
        <p className="text-sm text-panvas-text-secondary">Customize the look and feel of your workspace.</p>
      </div>

      <div className="grid gap-6 mt-4">
        <div className="flex flex-col gap-4">
          <label className="text-xs font-semibold uppercase tracking-wider text-panvas-text-tertiary">Theme</label>
          <div className="grid grid-cols-3 gap-2 sm:gap-6">

            <ThemeCard
              name="Light"
              active={theme === 'light'}
              icon={<Sun size={18} />}
              onClick={() => setTheme('light')}
              preview={<div className="h-full w-full bg-[#FBFAF7]" />}
            />

            <ThemeCard
              name="Ink"
              active={theme === 'ink'}
              icon={<PenTool size={18} />}
              onClick={() => setTheme('ink')}
              preview={<div className="h-full w-full bg-[#D8D5C8]" />}
            />
            <ThemeCard
              name="Dark"
              active={theme === 'dark'}
              icon={<Moon size={18} />}
              onClick={() => setTheme('dark')}
              preview={<div className="h-full w-full bg-[#191C1D]" />}
            />


          </div>
          <p className="text-xs text-panvas-text-tertiary">
            Ink pairs warm-gray tablet surfaces with softer colors. Paper color stays independent, and switching to Light or Dark restores full color.
          </p>
          {theme === 'dark' && <label className="flex items-center justify-between gap-4 rounded-xl border border-panvas-border-subtle p-3">
            <span><span className="block text-sm font-medium">Full Dark View</span><span className="block text-xs text-panvas-text-secondary">Darken notebook pages and PDFs for reading.</span></span>
            <input type="checkbox" role="switch" aria-label="Full Dark View" checked={fullDarkView} onChange={event => setFullDarkView(event.target.checked)} className="h-4 w-4 accent-panvas-accent-blue" />
          </label>}
        </div>
      </div>
    </div>
  );
}

interface ThemeCardProps {
  name: string;
  active: boolean;
  icon: React.ReactNode;
  onClick: () => void;
  preview: React.ReactNode;
}

function ThemeCard({ name, active, icon, onClick, preview }: ThemeCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-w-0 flex-col items-center gap-4 rounded-2xl border p-6 max-[599px]:px-2 max-[599px]:py-4 text-left transition-all duration-200 focus-ring ${
        active
          ? 'border-panvas-accent-violet bg-panvas-bg-secondary text-panvas-text-primary shadow-[0_0_0_1px_rgba(var(--accent-violet),0.18),var(--shadow-surface)]'
          : 'border-panvas-border-subtle bg-panvas-bg-primary text-panvas-text-secondary hover:border-panvas-border-strong hover:bg-panvas-bg-hover hover:shadow-[var(--shadow-surface)]'
      }`}
    >
      <div className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-panvas-border-subtle shadow-inner">
        <div className="absolute inset-0">{preview}</div>
        {React.cloneElement(icon as React.ReactElement<{ className?: string }>, {
          className: `relative z-10 drop-shadow-[0_0_2px_rgba(255,255,255,0.7)] ${active ? 'text-panvas-accent-violet' : 'text-panvas-text-tertiary'}`,
        })}
      </div>
      <span className="text-sm font-semibold">{name}</span>
      <span className="-mt-2 text-xs text-panvas-text-tertiary">{active ? 'Selected theme' : 'Switch theme'}</span>
    </button>
  );
}
