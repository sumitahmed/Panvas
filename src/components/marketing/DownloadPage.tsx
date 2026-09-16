import { useState } from 'react';
import { Check, Copy, Download, ExternalLink, ShieldAlert, Monitor } from 'lucide-react';
import { PublicDocument, PublicPageShell } from './PublicPageShell';
import { PANVAS_RELEASE } from './releaseMetadata';

export const PANVAS_INSTALLER_SHA256 = PANVAS_RELEASE.windows.checksumSha256;
export const PANVAS_INSTALLER_SIZE = PANVAS_RELEASE.windows.installerSize;

export function DownloadPage() {
  const [copied, setCopied] = useState(false);

  const handleCopyChecksum = () => {
    void navigator.clipboard.writeText(PANVAS_INSTALLER_SHA256);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <PublicPageShell
      label="Release / Download"
      title="Download Panvas for Windows."
      intro="Experience a local-first digital research workspace. Your data lives on your disk in human-readable files."
      aside={<>VERSION 0.1.1<br />Windows x64 NSIS<br />Release Build</>}
    >
      <PublicDocument>
        <section>
          <span className="pp-section-index">01</span>
          <div>
            <h2>Panvas Desktop {PANVAS_RELEASE.windows.version}</h2>
            <p>
              Standard desktop installer for Windows 10 and 11 (64-bit). Stored locally in <code>Documents/Panvas/</code> with zero cloud lock-in.
            </p>

            <div style={{
              marginTop: '20px',
              padding: '24px',
              borderRadius: '8px',
              background: 'var(--pp-bg-elevated, #f7f5f0)',
              border: '1px solid var(--pp-border, #e5e1d8)'
            }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <Monitor size={18} aria-hidden="true" />
                    <strong style={{ fontSize: '1.1rem' }}>{PANVAS_RELEASE.windows.installerFileName}</strong>
                  </div>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--pp-text-muted, #666)' }}>
                    Architecture: {PANVAS_RELEASE.windows.architecture} • Size: {PANVAS_INSTALLER_SIZE}
                  </p>
                </div>
                <a
                  href={PANVAS_RELEASE.windows.downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="pl-button pl-button-primary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none', padding: '10px 20px', borderRadius: '6px' }}
                >
                  <Download size={16} aria-hidden="true" />
                  Download Installer
                </a>
              </div>

              <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--pp-border, #e5e1d8)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                    SHA-256 Checksum
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyChecksum}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                      color: 'var(--pp-accent, #243c4a)'
                    }}
                    aria-label="Copy SHA-256 hash"
                  >
                    {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                    {copied ? 'Copied' : 'Copy Hash'}
                  </button>
                </div>
                <code style={{
                  display: 'block',
                  padding: '8px 12px',
                  borderRadius: '4px',
                  background: 'var(--pp-bg-card, #ebe7de)',
                  fontSize: '0.78rem',
                  wordBreak: 'break-all',
                  fontFamily: 'monospace'
                }}>
                  {PANVAS_INSTALLER_SHA256}
                </code>
                <p style={{ margin: '8px 0 0 0', fontSize: '0.8rem', color: 'var(--pp-text-muted, #666)' }}>
                  The authoritative cryptographic hash for each release asset is published in <code>SHA256SUMS.txt</code> on the{' '}
                  The authoritative cryptographic hash for each release asset is published in{' '}
                  <a href={PANVAS_RELEASE.windows.checksumUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                    <code>SHA256SUMS.txt</code>
                  </a>{' '}
                  on the{' '}
                  <a href={PANVAS_RELEASE.project.githubReleasesUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                    GitHub Releases portal
                  </a>.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <span className="pp-section-index">02</span>
          <div>
            <h2>System Requirements</h2>
            <ul>
              <li><strong>Operating System:</strong> Windows 10 (Build 1809 or higher) or Windows 11 (64-bit)</li>
              <li><strong>Processor:</strong> 64-bit Intel, AMD, or ARM64 with x64 emulation</li>
              <li><strong>Memory:</strong> 4 GB RAM minimum (8 GB recommended for dense vector PDF annotation)</li>
              <li><strong>Disk Space:</strong> 500 MB free storage for installation and local caching</li>
              <li><strong>Stylus / Pen:</strong> Microsoft Pen Protocol (MPP), Wacom EMR, or standard capacitive stylus supported</li>
            </ul>
          </div>
        </section>

        <section>
          <span className="pp-section-index">03</span>
          <div>
            <h2>Windows SmartScreen & Authenticode Notice</h2>
            <div style={{
              display: 'flex',
              gap: '12px',
              padding: '16px',
              borderRadius: '6px',
              background: '#fef3c7',
              border: '1px solid #fcd34d',
              color: '#92400e',
              marginBottom: '16px'
            }}>
              <ShieldAlert size={20} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
              <div style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
                <strong>Unsigned Binary Advisory:</strong> Panvas v0.1.1 is currently unsigned while the official Authenticode certificate pipeline is being established. Windows SmartScreen may display a warning stating <em>"Windows protected your PC"</em>.
              </div>
            </div>
            <p>
              To run the installer safely:
            </p>
            <ol>
              <li>Click <strong>"More info"</strong> on the Windows SmartScreen dialog.</li>
              <li>Click <strong>"Run anyway"</strong> to proceed with installation.</li>
              <li>To verify binary integrity beforehand, run <code>Get-FileHash Panvas-0.1.1-Setup.exe -Algorithm SHA256</code> in PowerShell and compare the hash with the verified checksum published above.</li>
            </ol>
          </div>
        </section>

        <section>
          <span className="pp-section-index">04</span>
          <div>
            <h2>Official Distribution Channels</h2>
            <p>
              Always download Panvas binaries exclusively from official project channels:
            </p>
            <p>
              <a
                href={PANVAS_RELEASE.project.githubReleasesUrl}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', textDecoration: 'underline' }}
              >
                Panvas GitHub Releases Portal
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </p>
          </div>
        </section>
      </PublicDocument>
    </PublicPageShell>
  );
}
