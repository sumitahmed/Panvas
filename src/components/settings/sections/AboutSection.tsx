// ============================================
// Panvas — About Section
// ============================================

import React from 'react';
import { ExternalLink, Github, FileText, Shield } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { PANVAS_LOGO_SRC } from '@/lib/brand';

export function AboutSection() {
  const { user } = useAuthStore();
  const version = '0.1.1';
  const build = '12345'; // Ideally injected via env
  const mode = user ? 'Cloud Mode' : 'Local Mode';

  return (
    <div className="flex flex-col gap-8 animate-in fade-in duration-300">
      <div>
        <h2 className="text-xl font-semibold text-panvas-text-primary mb-1">About Panvas</h2>
        <p className="text-sm text-panvas-text-secondary">Information about the application and legal documents.</p>
      </div>

      <div className="flex items-center gap-6 p-6 bg-panvas-bg-secondary rounded-2xl border border-panvas-border-subtle shadow-glass-sm">
        <img src={PANVAS_LOGO_SRC} alt="Panvas Logo" className="w-16 h-16 object-contain" />
        <div className="flex flex-col gap-1">
          <h3 className="text-xl font-semibold text-panvas-text-primary">Panvas</h3>
          <p className="text-sm text-panvas-text-secondary">Version {version} (Build {build})</p>
          <div className="mt-1">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              user ? 'bg-panvas-accent-emerald/10 text-panvas-accent-emerald' : 'bg-panvas-bg-tertiary text-panvas-text-secondary'
            }`}>
              {mode}
            </span>
          </div>
        </div>
      </div>

      <div className="grid gap-6">
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold uppercase tracking-wider text-panvas-text-muted">Links & Legal</label>
          <div className="bg-panvas-bg-secondary rounded-xl border border-panvas-border-subtle overflow-hidden">
            
            <a href="https://github.com/sumitahmed/Panvas" target="_blank" rel="noreferrer" 
               className="flex items-center justify-between p-4 border-b border-panvas-border-subtle hover:bg-panvas-bg-tertiary transition-colors group cursor-pointer">
              <div className="flex items-center gap-3">
                <Github size={16} className="text-panvas-text-secondary group-hover:text-panvas-text-primary transition-colors" />
                <span className="text-sm text-panvas-text-secondary group-hover:text-panvas-text-primary transition-colors">GitHub Repository</span>
              </div>
              <ExternalLink size={14} className="text-panvas-text-muted group-hover:text-panvas-text-secondary" />
            </a>

            <a href="/privacy" target="_blank"
               className="flex items-center justify-between p-4 border-b border-panvas-border-subtle hover:bg-panvas-bg-tertiary transition-colors group cursor-pointer">
              <div className="flex items-center gap-3">
                <Shield size={16} className="text-panvas-text-secondary group-hover:text-panvas-text-primary transition-colors" />
                <span className="text-sm text-panvas-text-secondary group-hover:text-panvas-text-primary transition-colors">Privacy Policy</span>
              </div>
              <ExternalLink size={14} className="text-panvas-text-muted group-hover:text-panvas-text-secondary" />
            </a>

            <a href="/terms" target="_blank"
               className="flex items-center justify-between p-4 hover:bg-panvas-bg-tertiary transition-colors group cursor-pointer">
              <div className="flex items-center gap-3">
                <FileText size={16} className="text-panvas-text-secondary group-hover:text-panvas-text-primary transition-colors" />
                <span className="text-sm text-panvas-text-secondary group-hover:text-panvas-text-primary transition-colors">Terms of Service</span>
              </div>
              <ExternalLink size={14} className="text-panvas-text-muted group-hover:text-panvas-text-secondary" />
            </a>

          </div>
        </div>
      </div>
      
      <div className="text-center mt-4">
        <p className="text-xs text-panvas-text-muted">
          &copy; {new Date().getFullYear()} Panvas. All rights reserved.
        </p>
      </div>
    </div>
  );
}
