import React from 'react';
import { Link } from 'wouter';
import { Github, Globe, Mail } from 'lucide-react';
import { PANVAS_LOGO_SRC } from '@/lib/brand';

// Reusable notebook texture
function FooterTexture({ gridOpacity = 0.015, dotOpacity = 0.012 }: { gridOpacity?: number; dotOpacity?: number }) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
      <div 
        className="absolute inset-0"
        style={{
          opacity: gridOpacity,
          backgroundImage: `
            linear-gradient(to right, #FFFFFF 1px, transparent 1px),
            linear-gradient(to bottom, #FFFFFF 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px'
        }}
      />
      <div 
        className="absolute inset-0"
        style={{
          opacity: dotOpacity,
          backgroundImage: 'radial-gradient(circle at center, #FFFFFF 1px, transparent 1px)',
          backgroundSize: '16px 16px',
          backgroundPosition: '8px 8px'
        }}
      />
    </div>
  );
}

export function Footer() {
  return (
    <footer className="w-full relative mt-16 bg-[#0A0A0A]/80 backdrop-blur-3xl border-t border-white/10 pt-16 pb-12 px-6 lg:px-12 overflow-hidden flex-shrink-0 z-10">
      {/* Footer boundary: gradient divider */}
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent" />
      
      {/* Decorative Blur */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3/4 h-64 bg-[#238B5D]/5 blur-[120px] rounded-full pointer-events-none" />

      <FooterTexture gridOpacity={0.015} dotOpacity={0.01} />

      <div className="max-w-[1200px] mx-auto relative z-10">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-8 lg:gap-12 mb-16 relative">
          
          {/* Brand Column */}
          <div className="col-span-2 lg:col-span-2 flex flex-col items-start">
            <Link href="/" className="flex items-center gap-2.5 mb-4 group cursor-pointer select-none">
              <img src={PANVAS_LOGO_SRC} alt="Panvas" className="w-7 h-7 rounded-md border border-white/5 shadow-[0_4px_12px_rgba(0,0,0,0.5)] group-hover:scale-105 transition-transform" />
              <span className="font-sketch text-xl text-[#E8E8E8] tracking-wide group-hover:text-white transition-colors">
                Panvas
              </span>
            </Link>
            <span className="text-[11px] font-medium text-[#737373] bg-white/4 border border-white/6 w-fit px-2 py-0.5 rounded mb-4">
              v0.1.1
            </span>
            <p className="text-sm text-[#737373] leading-relaxed mb-1 max-w-xs">
              A Visual Research Workspace
            </p>
            <p className="text-[11px] text-[#525252] uppercase tracking-widest font-semibold mb-6">
              Built by Sumit Ahmed
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-4">
                <a href="https://github.com/sumitahmed" target="_blank" rel="noopener noreferrer" aria-label="GitHub Profile" className="text-[#525252] hover:text-[#A3A3A3] transition-colors">
                  <Github size={18} />
                </a>
                <a href="https://sumitahmed.me/" target="_blank" rel="noopener noreferrer" aria-label="Personal Website" className="text-[#525252] hover:text-[#A3A3A3] transition-colors">
                  <Globe size={18} />
                </a>
              </div>
              <a href="mailto:sksumitahmed007@gmail.com" className="text-sm text-[#737373] hover:text-white transition-colors flex items-center gap-2 mt-1">
                <Mail size={14} className="text-[#525252]" />
                sksumitahmed007@gmail.com
              </a>
            </div>
          </div>

          {/* Product Column */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[#E8E8E8] font-semibold mb-2">Product</h4>
            <Link href="/#features" className="text-sm text-[#737373] hover:text-white transition-colors">Features</Link>
            <Link href="/roadmap" className="text-sm text-[#737373] hover:text-white transition-colors">Roadmap</Link>
          </div>

          {/* Resources Column */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[#E8E8E8] font-semibold mb-2">Resources</h4>
            <a href="https://github.com/sumitahmed/Panvas" target="_blank" rel="noopener noreferrer" className="text-sm text-[#737373] hover:text-white transition-colors">
              GitHub Repository
            </a>
          </div>



          {/* Legal Column */}
          <div className="flex flex-col gap-3">
            <h4 className="text-[#E8E8E8] font-semibold mb-2">Legal</h4>
            <Link href="/privacy" className="text-sm text-[#737373] hover:text-white transition-colors">Privacy Policy</Link>
            <Link href="/terms" className="text-sm text-[#737373] hover:text-white transition-colors">Terms of Service</Link>
            <Link href="/security" className="text-sm text-[#737373] hover:text-white transition-colors">Security</Link>
          </div>

        </div>

        {/* Bottom Section */}
        <div className="pt-8 border-t border-white/5 flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="text-xs text-[#525252]">
            © {new Date().getFullYear()} Panvas. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
