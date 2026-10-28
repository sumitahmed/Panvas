// ============================================
// Panvas — Auth Guard
// ============================================

import React, { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, Cloud, ShieldAlert, X } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useCloudSyncStore } from '@/stores/cloudSyncStore';
import { CLOUD_SYNC_ENABLED, CLOUD_SYNC_V2_ENABLED } from '@/config/features';
import { navigateToLibraryView } from '@/services/library/libraryRouteState';

interface AuthGuardProps {
  children: React.ReactNode;
}

export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading } = useAuthStore();
  const googleDriveConnection = useCloudSyncStore(state => state.connectionByProvider.googledrive);
  const [, navigate] = useLocation();
  const [promptDismissed, setPromptDismissed] = useState(() => {
    try { return window.sessionStorage.getItem('panvas.cloudSyncPromptDismissed') === 'true'; } catch { return false; }
  });
  const [showSoftPrompt, setShowSoftPrompt] = useState(false);

  // For Panvas, since it's local-first, we don't *hard block* the /app route.
  // Instead, we just show a soft prompt if they aren't authenticated, letting them know
  // cloud sync is disabled, but allowing them to continue offline.
  useEffect(() => {
    if (!promptDismissed && !isLoading && !isAuthenticated && !googleDriveConnection) {
      // Small delay before showing prompt to not be too aggressive
      const timer = setTimeout(() => setShowSoftPrompt(true), 1500);
      return () => clearTimeout(timer);
    } else {
      setShowSoftPrompt(false);
    }
  }, [isLoading, isAuthenticated, googleDriveConnection, promptDismissed]);

  const dismissPrompt = () => {
    setShowSoftPrompt(false);
    setPromptDismissed(true);
    try { window.sessionStorage.setItem('panvas.cloudSyncPromptDismissed', 'true'); } catch {}
  };
  const openCloudSync = () => {
    dismissPrompt();
    navigateToLibraryView('cloud');
    navigate('/app/library');
  };

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0D0D0D]">
        <div className="flex flex-col items-center gap-4 animate-fade-in">
          <Loader2 size={24} className="text-[#A3A3A3] animate-spin" />
          <p className="text-sm text-[#737373]">Verifying session...</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {children}

      {/* Soft prompt overlay for unauthenticated users in the workspace */}
      <AnimatePresence>
        {showSoftPrompt && (CLOUD_SYNC_V2_ENABLED || CLOUD_SYNC_ENABLED) && !googleDriveConnection && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="panvas-local-mode-prompt panvas-layer-system fixed bottom-16 right-5 w-[300px] rounded-xl glass-panel p-4 shadow-2xl"
          >
            <button 
              onClick={dismissPrompt}
              className="absolute top-3 right-3 text-[#737373] hover:text-[#E8E8E8] transition-colors"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
            
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center shrink-0 mt-0.5">
                <ShieldAlert size={16} className="text-[#A3A3A3]" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-[#E8E8E8]">Local Mode Active</h3>
                <p className="text-xs text-[#737373] mt-1 leading-relaxed">
                  Your data is stored on this device. Cloud sync is {(CLOUD_SYNC_V2_ENABLED || CLOUD_SYNC_ENABLED) ? 'available when you connect Google Drive' : 'disabled in this build'}.
                </p>
                {(CLOUD_SYNC_V2_ENABLED || CLOUD_SYNC_ENABLED) && <div className="mt-3 flex gap-2">
                  <button
                    onClick={openCloudSync}
                    className="px-3 py-1.5 rounded-md bg-[#E8E8E8] text-[#0D0D0D] text-xs font-semibold hover:bg-white transition-colors flex items-center gap-1.5"
                  >
                    <Cloud size={12} />
                    Connect Google Drive
                  </button>
                  <button
                    onClick={dismissPrompt}
                    className="px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-[#E8E8E8] text-xs font-medium hover:bg-white/10 transition-colors"
                  >
                    Continue locally
                  </button>
                </div>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
