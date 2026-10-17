import type { ReactNode } from 'react';
import { ArrowUpRight, Github, Globe, Mail } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { PANVAS_RELEASE } from './releaseMetadata';
import './public-pages.css';

const pages = [['/download','Download'],['/roadmap','Roadmap'],['/privacy','Privacy'],['/terms','Terms'],['/security','Security']] as const;

export function PublicPageShell({ label, title, intro, children, aside }: { label:string; title:string; intro:string; children:ReactNode; aside?:ReactNode }) {
  const [location]=useLocation();
  return <div className="pp-shell">
    <header className="pp-header">
      <Link href="/" className="pp-brand"><img src="/panvas_logo.png" alt=""/><b>Panvas</b></Link>
      <nav aria-label="Public pages">{pages.map(([href,text])=><Link key={href} href={href} aria-current={location===href?'page':undefined}>{text}</Link>)}</nav>
      <Link href="/" className="pp-home">Back to Panvas <ArrowUpRight size={14}/></Link>
    </header>
    <main>
      <section className="pp-hero">
        <div><span className="pp-kicker">{label}</span><h1>{title}</h1><p>{intro}</p></div>
        {aside&&<aside>{aside}</aside>}
      </section>
      <div className="pp-rule" aria-hidden="true"><span/></div>
      {children}
    </main>
    <footer className="pp-footer">
      <div className="pp-footer-brand"><img src="/panvas_logo.png" alt=""/><p>Structured when you need it.<br/>Local by default.</p></div>
      <nav aria-label="Footer navigation">
        <div><span>Product</span><Link href="/">Home</Link><Link href="/download">Download</Link><Link href="/roadmap">Roadmap</Link></div>
        <div><span>Trust</span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/security">Security</Link></div>
        <div><span>Open source</span><a href={PANVAS_RELEASE.project.githubRepoUrl} target="_blank" rel="noreferrer"><Github size={14}/>Repository</a><a href={PANVAS_RELEASE.project.githubIssuesUrl} target="_blank" rel="noreferrer">Issues</a></div>
        <div><span>Creator</span><a href={PANVAS_RELEASE.project.creatorGithubUrl} target="_blank" rel="noreferrer"><Github size={14}/>Sumit Ahmed</a><a href={PANVAS_RELEASE.project.creatorWebsiteUrl} target="_blank" rel="noreferrer"><Globe size={14}/>Portfolio</a><a href={PANVAS_RELEASE.project.creatorEmailUrl}><Mail size={14}/>Email</a></div>
      </nav>
      <div className="pp-footer-bottom"><small>© {PANVAS_RELEASE.project.year} Panvas</small><a href="#top">Back to top ↑</a></div>
    </footer>
  </div>;
}

export function PublicDocument({ children }: { children:ReactNode }) { return <article className="pp-document">{children}</article>; }
