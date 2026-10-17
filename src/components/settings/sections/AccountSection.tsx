import React from 'react';
import { useAuthStore } from '@/stores/authStore';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { getCloudSyncPresentation } from '@/services/cloudsync/presentation';
import { SettingsCloudConnection, useSettingsCloudState } from '../SettingsCloudConnection';

export function AccountSection() {
  const user = useAuthStore(state => state.user);
  const loading = useAuthStore(state => state.isLoading);
  const cloud = useSettingsCloudState();
  const name = user?.user_metadata?.full_name || user?.user_metadata?.name;
  const created = user?.created_at ? new Date(user.created_at) : null;
  return <div className="flex flex-col gap-6">
    <header className="pr-8"><h2 className="mb-1 text-xl font-semibold text-panvas-text-primary">Account</h2><p className="text-sm text-panvas-text-secondary">Your Panvas account and Google Drive connection are separate.</p></header>
    <section aria-label="Panvas account" className="panvas-surface p-4">
      <h3 className="mb-3 text-sm font-medium text-panvas-text-primary">Panvas account</h3>
      {loading ? <p role="status" className="text-sm text-panvas-text-secondary">Restoring account…</p> : user ? <>
        <div className="flex min-w-0 items-center gap-3"><UserAvatar size="md" /><div className="min-w-0 text-sm text-panvas-text-primary">{name && <p className="break-words font-medium">{name}</p>}{user.email && <p className="break-all text-panvas-text-secondary">{user.email}</p>}</div></div>
        <dl className="mt-4 space-y-3 border-t border-panvas-border-subtle pt-4 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-panvas-text-secondary">Session</dt><dd className="text-panvas-text-primary">Signed in</dd></div>
          {user.app_metadata?.provider && <div className="flex justify-between gap-4"><dt className="text-panvas-text-secondary">Provider</dt><dd className="capitalize text-panvas-text-primary">{user.app_metadata.provider}</dd></div>}
          {created && Number.isFinite(created.getTime()) && <div className="flex justify-between gap-4"><dt className="text-panvas-text-secondary">Member since</dt><dd className="text-panvas-text-primary">{created.toLocaleDateString()}</dd></div>}
        </dl>
      </> : <p className="text-sm leading-relaxed text-panvas-text-secondary">You are not signed in to a Panvas account. Local editing remains available. Connect Google Drive below to sync using the existing Google sign-in flow.</p>}
    </section>
    <SettingsCloudConnection cloud={cloud} presentation={getCloudSyncPresentation(cloud)} />
  </div>;
}
