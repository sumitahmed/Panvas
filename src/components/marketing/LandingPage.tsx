import React, { useEffect, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
  useSpring,
  useMotionValue,
  useInView,
  type MotionValue,
} from 'framer-motion';
import { ArrowRight, Download, Menu, Plus, X, Github, Globe, Mail, CircleDot } from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { captureEvent } from '@/lib/analytics';
import { FAQ_ITEMS } from './marketingTokens';
import { PANVAS_RELEASE } from './releaseMetadata';
import { LandingAtmosphere } from './LandingAtmosphere';
import { HeroInkPlayground } from './HeroInkPlayground';
import { ProductDepth } from './ProductDepth';
import { FlowPath, useLandingChoreography } from './LandingChoreography';
import './landing.css';
import './landing-choreography.css';

const PRODUCT_ASSET_ROOT = '/Application SS updated';
const easeOut = [0.23, 1, 0.32, 1] as const;
const imageDimensions: Record<string, [number, number]> = {
  'HeroPanvasClean.png': [1024, 517], 'NotebookStyle_Template.png': [1573, 1053],
  'CustomizeYourNotebook.png': [1917, 992], 'Turn_Handwriting_into_text.png': [1586, 992],
  'PreferenceStationary.png': [1536, 1024], 'InkGestures.png': [1448, 1086],
  'HeroResearchWorkSpace.png': [1536, 1024], 'printNotes_ExportPDF.png': [1536, 1024],
  'StickyNotes.png': [1347, 1168], 'Voice Notes.png': [1536, 1024], 'ToolBar.png': [756, 70],
  'e.png': [1586, 992],
};

type ProductImageProps = { src: string; alt: string; className?: string; eager?: boolean; sizes?: string };

function ProductImage({ src, alt, className = '', eager = false, sizes }: ProductImageProps) {
  return (
    <picture>
      <source
        type="image/webp"
        srcSet={`${encodeURI(`${PRODUCT_ASSET_ROOT}/optimized/${src.replace('.png', '')}-640.webp`)} 640w, ${encodeURI(`${PRODUCT_ASSET_ROOT}/optimized/${src.replace('.png', '')}-1280.webp`)} ${Math.min(1280, imageDimensions[src]?.[0] ?? 1280)}w`}
        sizes={sizes ?? '(max-width: 760px) 92vw, 65vw'}
      />
      <img
        src={encodeURI(`${PRODUCT_ASSET_ROOT}/${src}`)}
        alt={alt}
        className={className}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        sizes={sizes ?? '(max-width: 760px) 92vw, 65vw'}
        width={imageDimensions[src]?.[0]}
        height={imageDimensions[src]?.[1]}
        fetchPriority={eager ? 'high' : 'auto'}
      />
    </picture>
  );
}

function ProductStage({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={'pl-product-stage ' + className}>{children}</div>;
}

function ProductMedia({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={'pl-product-media ' + className}>{children}</div>;
}

function SketchNote({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={'pl-sketch-note ' + className}>{children}</span>;
}

function SketchArrow({ className = '' }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  return <svg className={'pl-sketch-arrow ' + className} viewBox="0 0 180 100" fill="none" aria-hidden="true">
    <motion.path d="M8 15C40 2 110 12 114 49C118 77 84 82 77 62C70 45 123 42 166 76M150 60L168 78L145 79"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      initial={false} whileInView={reduceMotion ? undefined : { pathLength: [0, 1] }}
      viewport={{ once: true, amount: .15 }} transition={{ duration: .55, ease: 'easeOut' }} />
  </svg>;
}

type Capture = { label: string; src: string; alt: string; note: string };
function CaptureSwitcher({ captures, name, storyProgress }: { captures: Capture[]; name: string; storyProgress?: MotionValue<number> }) {
  const ref = useRef<HTMLDivElement>(null);
  const entered = useInView(ref, { once: true, amount: .15 });
  const [selected, setSelected] = useState(0);
  const [animateSelection, setAnimateSelection] = useState(false);
  const manual = useRef(false);
  const fallback = useMotionValue(0);
  useMotionValueEvent(storyProgress ?? fallback, 'change', value => {
    if (!manual.current && storyProgress && !matchMedia('(max-width: 899px), (prefers-reduced-motion: reduce)').matches) {
      setAnimateSelection(true);
      // A hold on either side of the handoff avoids oscillating at one threshold.
      setSelected(previous => value > .62 ? captures.length - 1 : value < .38 ? 0 : previous);
    }
  });
  const reduceMotion = useReducedMotion();
  return <div ref={ref} data-entered={entered} className={'pl-capture-switcher pl-capture-' + name}>
    <div className="pl-capture-controls" role="group" aria-label={name + ' screenshots'}>
      {captures.map((capture, index) => <button type="button" key={capture.src}
        aria-pressed={selected === index} aria-controls={'pl-capture-' + name} onClick={event => { manual.current = true; setAnimateSelection(event.detail > 0); setSelected(index); }}>{capture.label}</button>)}
    </div>
    <div className="pl-capture-frame" id={'pl-capture-' + name}>
      <motion.div key={selected} initial={false}
        animate={reduceMotion || !animateSelection ? { opacity: 1 } : { opacity: [0.6, 1], transform: ['translate3d(0,5px,0)', 'translate3d(0,0,0)'] }}
        transition={{ duration: .22, ease: easeOut }}>
        <ProductImage src={captures[selected].src} alt={captures[selected].alt} />
      </motion.div>
    </div>
    <div className="pl-capture-caption" aria-live="polite"><span>{captures[selected].label} / Panvas</span><span>Actual product capture</span></div>
  </div>;
}

function InkRecognition() {
  const ref = useRef<HTMLDivElement>(null);
  const entered = useInView(ref, { once: true, amount: .5 });
  const reduceMotion = useReducedMotion();
  const [replay, setReplay] = useState(0);
  const strokes = [
    'M18 14L12 48Q10 56 22 50M6 29L29 25',
    'M38 10L30 53Q40 23 49 31Q53 34 45 52',
    'M62 30L57 49Q59 55 66 49M64 19L65 17',
    'M78 30L72 53Q86 24 94 31Q99 35 91 52',
    'M109 11L100 53M121 29L104 42L120 53',
  ];
  return <div ref={ref} className="pl-recognition" aria-label="Illustration of Windows handwriting-to-text">
    <div key={replay} className={'pl-recognition-flow' + (entered && !reduceMotion ? ' is-writing' : '')}>
      <div className="pl-recognition-written"><svg viewBox="0 0 135 65" role="img" aria-label="Handwritten word think">
        {strokes.map((d, index) => <path key={d} d={d} pathLength={1} style={{ '--stroke': index } as React.CSSProperties} />)}
      </svg><span>handwriting</span></div>
      <svg className="pl-recognition-arrow" viewBox="0 0 60 30" aria-hidden="true"><path d="M3 16Q28 9 52 15M43 6L54 15L42 23" pathLength={1} /></svg>
      <label className="pl-recognition-result"><input aria-label="Edit the example text" defaultValue="think" maxLength={30} spellCheck={false} /><span>editable text · try it</span></label>
    </div>
    <div className="pl-recognition-caption"><span>Illustrated Windows workflow</span><button type="button" onClick={() => setReplay(value => value + 1)} aria-label="Replay handwriting example">Replay ↻</button></div>
  </div>;
}

function PenSketch() {
  return <svg className="pl-pen-sketch" viewBox="0 0 240 110" fill="none" aria-hidden="true">
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 91C42 96 70 76 105 86S181 104 219 84" strokeWidth="1.2" />
      <path d="M91 79L159 16L170 25L103 86L89 90ZM97 78L105 85M152 23L163 32M90 90L87 94" strokeWidth="1.6" />
      <path d="M167 58C165 44 157 40 151 47L138 61M147 55C152 51 157 51 162 60L169 74C172 82 169 88 159 96M180 43C195 42 209 54 218 68L237 76M181 43L177 28C175 20 168 17 165 21M177 42L190 66M164 95L190 104L212 78M158 97L153 101M220 77L215 84" strokeWidth="1.2" />
      <path d="M51 50L54 39L60 48L71 51L61 55L57 66L53 56L43 54Z" strokeWidth="1" />
    </g>
  </svg>;
}

function TextReveal({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={false}
      whileInView={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
      viewport={{ once: true, amount: 0.15 }}
      transition={{ duration: 0.32, ease: easeOut }}
    >
      {children}
    </motion.div>
  );
}

function IridescentSurface({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={'pl-iridescent ' + className}>{children}</div>;
}

function Nav({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const reduceMotion = useReducedMotion();
  const { scrollY } = useScroll();
  const links = [
    ['Notebooks', '#notebooks'],
    ['Ink', '#ink'],
    ['PDF', '#pdf'],
    ['Canvas', '#canvas'],
    ['Local-first', '#local-first'],
  ];

  useMotionValueEvent(scrollY, 'change', value => setScrolled(value > 36));

  const go = (href: string) => {
    setOpen(false);
    document.querySelector(href)?.scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth' });
  };

  return (
    <header className={'pl-nav' + (scrolled ? ' is-scrolled' : '')}>
      <a className="pl-brand" href="#top" aria-label="Panvas home">
        <img src="/panvas_logo.png" alt="" />
        <span>Panvas</span>
      </a>
      <nav className="pl-nav-links" aria-label="Primary navigation">
        {links.map(([label, href]) => (
          <button type="button" key={href} onClick={() => go(href)}>{label}</button>
        ))}
        <Link href="/download">Download</Link>
        <Link href="/roadmap">Roadmap</Link>
      </nav>
      <button type="button" className="pl-button pl-button-primary pl-nav-cta" onClick={onOpenWorkspace}>
        Open Panvas <ArrowRight aria-hidden="true" />
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger className="pl-menu-button" aria-label="Open navigation menu">
          <Menu aria-hidden="true" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="pl-nav-backdrop" />
          <Dialog.Viewport className="pl-nav-viewport">
            <Dialog.Popup className="pl-nav-sheet">
              <div className="pl-nav-sheet-head">
                <Dialog.Title>Panvas navigation</Dialog.Title>
                <Dialog.Close className="pl-nav-sheet-close" aria-label="Close navigation menu"><X aria-hidden="true" /></Dialog.Close>
              </div>
              <Dialog.Description className="pl-nav-sheet-description">Explore the Panvas workspace and release information.</Dialog.Description>
              <nav aria-label="Mobile navigation">
                {links.map(([label, href]) => (
                  <button type="button" key={href} onClick={() => go(href)}>{label}<ArrowRight aria-hidden="true" /></button>
                ))}
                <Link href="/download" onClick={() => setOpen(false)}>Download <ArrowRight aria-hidden="true" /></Link>
                <Link href="/roadmap" onClick={() => setOpen(false)}>Roadmap <ArrowRight aria-hidden="true" /></Link>
              </nav>
              <button type="button" className="pl-button pl-button-primary" onClick={() => { setOpen(false); onOpenWorkspace(); }}>
                Open Panvas <ArrowRight aria-hidden="true" />
              </button>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}

function Hero({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const reduceMotion = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || reduceMotion) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [reduceMotion]);

  return (
    <section className="pl-hero" id="top" data-scroll-scene>
      <div className="pl-hero-inner">
        <div className="pl-hero-copy" data-parallax="-65">
          <span className="pl-eyebrow">A little structure. Room to wander.</span>
          <motion.h1 initial={false} animate={reduceMotion ? undefined : { transform: ['translate3d(0,12px,0)', 'translate3d(0,0,0)'] }}
            transition={{ duration: .45, ease: easeOut }}>
            Think.<br />Sketch.<br />Write.<br /><span>Build.</span>
          </motion.h1>
          <p className="pl-hero-support">A local-first visual workspace for technical thinking. Notebooks, ink, PDFs, and an infinite Canvas, with room for your own way of working.</p>
          <div className="pl-actions">
            <a className="pl-button pl-button-primary" href={PANVAS_RELEASE.windows.downloadUrl}><Download aria-hidden="true" /> Windows</a>
            <button type="button" className="pl-button pl-button-secondary" onClick={onOpenWorkspace}>Explore Panvas <ArrowRight aria-hidden="true" /></button>
          </div>
          <span className="pl-hero-availability">Panvas v0.1.2 · Windows 64-bit &amp; Browser Build</span>
        </div>
        <div className="pl-hero-art">
          <SketchNote className="pl-hero-note">a place for the way you think <span aria-hidden="true">✧</span></SketchNote>
          <SketchArrow className="pl-hero-arrow" />
          <div className="pl-hero-depth">
            <div className="pl-hero-video-frame">
              {reduceMotion ? (
                <img
                  src="/media/panvas-product-showcase-poster.webp"
                  alt="Panvas product showcase demonstration"
                  className="pl-hero-video"
                  width={1920}
                  height={1080}
                  loading="eager"
                  decoding="async"
                />
              ) : (
                <video
                  ref={videoRef}
                  className="pl-hero-video"
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  poster="/media/panvas-product-showcase-poster.webp"
                  width={1920}
                  height={1080}
                  aria-label="Panvas workspace product showcase video demonstration"
                >
                  <source src="/media/panvas-product-showcase-web.mp4" type="video/mp4" />
                  Your browser does not support the video tag.
                </video>
              )}
            </div>
            <span className="pl-hero-edge" aria-hidden="true" />
          </div>
          <div className="pl-hero-caption"><span>Your ideas. Your handwriting. Your space.</span><span>Local by default ↗</span></div>
        </div>
      </div>
      <a className="pl-hero-scroll" href="#notebooks">Turn the page <span aria-hidden="true">↓</span></a>
      <PenSketch />
    </section>
  );
}

function Notebooks() {
  const ref = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const turn = useTransform(scrollYProgress, [0, .15, .85, 1], ['perspective(1400px) rotateY(-6deg) rotateZ(-1deg) scale(.96)', 'perspective(1400px) rotateY(-6deg) rotateZ(-1deg) scale(.96)', 'perspective(1400px) rotateY(1deg) rotateZ(0deg) scale(1)', 'perspective(1400px) rotateY(1deg) rotateZ(0deg) scale(1)']);
  const meter = useTransform(scrollYProgress, value => `scaleX(${value})`);
  return (
    <section ref={ref} className="pl-section pl-notebooks" id="notebooks" data-scroll-scene>
      <div className="pl-section-inner pl-notebooks-grid">
        <TextReveal className="pl-section-copy pl-notebook-copy">
          <span className="pl-eyebrow">Structured notebooks</span>
          <h2>Structure when<br />you need it.</h2>
          <p>Move from workspace to page without flattening the thinking in between. Choose a cover, find your paper, and make room for the next idea.</p>
          <div className="pl-hierarchy" aria-label="Workspace, folder, notebook, section, page">
            {['Workspace', 'Folder', 'Notebook', 'Section', 'Page'].map(label => <span key={label}>{label}</span>)}
          </div>
        </TextReveal>
        <motion.div className="pl-notebook-art" style={reduce ? undefined : { transform: turn }}>
          <div className="pl-scene-readout"><span>01 / Arrange your notebook</span><span>Scroll to turn the page ↓</span><motion.i style={{ transform: meter }} /></div>
          <CaptureSwitcher name="notebook" storyProgress={scrollYProgress} captures={[
            { label: 'Paper & templates', src: 'NotebookStyle_Template.png', alt: 'Panvas template chooser showing ruled, dotted, engineering, Cornell and other papers', note: 'find the paper that fits your thinking' },
            { label: 'Covers & character', src: 'CustomizeYourNotebook.png', alt: 'Panvas notebook creation dialog with cover choices', note: 'make it feel like yours' },
          ]} />
          <SketchArrow className="pl-notebook-arrow" />
        </motion.div>
      </div>
    </section>
  );
}

function Ink() {
  const reduceMotion = useReducedMotion();
  return (
    <section className="pl-section pl-ink" id="ink" data-scroll-scene>
      <div className="pl-section-inner">
        <div className="pl-section-heading pl-ink-heading">
          <div><span className="pl-eyebrow">Ink, with your character</span><h2>A thought.<br />A stroke.<br /><em>Your mark.</em></h2></div>
          <div className="pl-ink-narrative">
            <p>Write with pressure-sensitive ink. Tune stabilization, choose your color, and let gestures keep you in the flow. On Windows, turn selected handwriting into editable text.</p>
            <div className="pl-ink-specs"><span>Pressure</span><span>Stabilization</span><span>Gestures</span><span>Windows handwriting-to-text</span></div>
          </div>
        </div>
        <div className="pl-ink-story" data-parallax="-130">
          <CaptureSwitcher name="ink" captures={[
            { label: 'Handwriting to text', src: 'Turn_Handwriting_into_text.png', alt: 'Real Panvas page demonstrating handwriting and typed text', note: 'your handwriting, now editable on Windows' },
            { label: 'Pressure & color', src: 'PreferenceStationary.png', alt: 'Real Panvas pencil settings with stabilization, pressure and colors', note: 'a lighter touch. a stronger line.' },
            { label: 'Ink gestures', src: 'InkGestures.png', alt: 'Real Panvas controls for scribble to erase, circle to select and shape gestures', note: 'little gestures. fewer interruptions.' },
          ]} />
          <svg className="pl-pen-trail" viewBox="0 0 360 130" aria-hidden="true">
            <motion.path d="M12 90C62 130 85 12 135 48S206 126 226 63S291 37 343 49" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
              initial={false} whileInView={reduceMotion ? undefined : { pathLength: [0, 1] }} viewport={{ once: true }} transition={{ duration: .65, ease: 'easeOut' }} />
          </svg>
        </div>
      </div>
    </section>
  );
}

function PdfSection() {
  const reduceMotion = useReducedMotion();
  const stageRef = useRef<HTMLDivElement>(null);
  const entered = useInView(stageRef, { once: true, amount: .2 });
  const [step, setStep] = useState<'notes' | 'export'>('export');
  return (
    <section className="pl-section pl-pdf" id="pdf" data-scroll-scene>
      <div className="pl-section-inner pl-pdf-grid">
        <div className="pl-section-copy pl-pdf-copy">
          <span className="pl-eyebrow">Read. Mark up. Take it with you.</span>
          <h2>Good thinking.<br />Ready to share.</h2>
          <p>Read and annotate PDFs in Panvas. Bring your own notes out of the workspace, too: export a page or a notebook to PDF, or send either to print.</p>
          <div className="pl-pdf-proof" role="group" aria-label="Notebook export workflow">
            <button type="button" aria-pressed={step === 'notes'} onClick={() => setStep('notes')}>Your notes</button>
            <span aria-hidden="true">→</span>
            <button type="button" aria-pressed={step === 'export'} onClick={() => setStep('export')}>Export / print</button>
          </div>
        </div>
        <div ref={stageRef} className="pl-product-stage pl-pdf-stage" data-entered={entered} data-step={step}>
          <div className="pl-pdf-paper" data-parallax="85"><span className="pl-eyebrow">From your notebook</span>
            <ProductImage src="HeroResearchWorkSpace.png" alt="Panvas research notebook with equations, handwritten annotations and code, ready for notebook export" />
          </div>
          <motion.div className="pl-pdf-export" data-parallax="-155" initial={false}
            whileInView={reduceMotion ? undefined : { transform: ['translate3d(0,14px,0) rotate(2deg)', 'translate3d(0,0,0) rotate(0deg)'] }}
            viewport={{ once: true, amount: .1 }} transition={{ duration: .4, ease: easeOut }}>
            <ProductImage src="printNotes_ExportPDF.png" alt="The actual Panvas menu: export page or notebook to PDF, print page or notebook" />
          </motion.div>
          <SketchNote className="pl-pdf-note">out into the world.</SketchNote>
          <SketchArrow className="pl-pdf-arrow" />
        </div>
      </div>
    </section>
  );
}

function CanvasSection() {
  const sceneRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: sceneRef, offset: ['start start', 'end end'] });
  const leftTransform = useTransform(scrollYProgress, [0, 1], ['translate3d(-18px,16px,0) rotate(-4deg)', 'translate3d(0,0,0) rotate(-2deg)']);
  const rightTransform = useTransform(scrollYProgress, [0, 1], ['translate3d(18px,24px,0) rotate(4deg)', 'translate3d(0,0,0) rotate(2deg)']);
  return (
    <section ref={sceneRef} className="pl-section pl-canvas" id="canvas" data-scroll-scene>
      <div className="pl-section-inner">
        <div className="pl-section-heading pl-canvas-heading">
          <div><span className="pl-eyebrow">Infinite Canvas</span><h2>Some ideas need<br /><em>more room.</em></h2></div>
          <div><p>Reusable Local Elements. Sticky notes. Voice notes. Arrange the pieces around the relationships in your thinking, not a fixed page order.</p>
            <SketchNote>connect the dots your own way.</SketchNote></div>
        </div>
        <ProductStage className="pl-canvas-stage">
          <div className="pl-canvas-assembly" ref={stageRef}>
            <svg className="pl-canvas-topology" viewBox="0 0 1100 590" aria-hidden="true">
              <FlowPath d="M190 380C80 525 260 565 408 489S523 271 668 309S831 490 1008 344" />
              <FlowPath d="M405 160C527 74 611 88 730 129" />
              <path className="pl-sketch-star" d="M533 349L540 325L548 344L573 350L552 361L547 382L536 363L515 357Z" />
            </svg>
            <motion.figure className="pl-canvas-elements" style={reduceMotion ? undefined : { transform: leftTransform }}>
              <ProductImage src="StickyNotes.png" alt="Panvas Local Elements library with yellow and mint sticky notes and important stamp" />
              <figcaption><SketchNote>keep the useful little things</SketchNote></figcaption>
            </motion.figure>
            <motion.figure className="pl-canvas-voice" style={reduceMotion ? undefined : { transform: rightTransform }}>
              <ProductImage src="Voice Notes.png" alt="Panvas Voice notes panel with local recording, import and playback controls" />
              <figcaption><SketchNote>catch a thought, in your own voice</SketchNote></figcaption>
            </motion.figure>
            <div className="pl-canvas-toolbar"><ProductImage src="ToolBar.png" alt="Panvas drawing, ink, eraser and text tools" /></div>
            <ProductDepth progress={scrollYProgress} />
          </div>
        </ProductStage>
      </div>
    </section>
  );
}

function ResearchStory() {
  const ref = useRef<HTMLDivElement>(null);
  const entered = useInView(ref, { once: true, amount: .15 });
  return <section className="pl-section pl-research" id="research" data-scroll-scene>
    <div className="pl-section-inner pl-research-layout">
      <div className="pl-research-copy"><span className="pl-eyebrow">Research / in context</span>
        <h2>Not just notes.<br /><em>A place to work things out.</em></h2>
        <p>Equations beside explanations. Code beside a handwritten thought. Keep the detail and the bigger picture on the same page.</p>
        <div className="pl-research-index"><span>Text &amp; notation</span><span>LaTeX &amp; code</span><span>Ink &amp; annotation</span></div>
        <SketchNote>the messy middle belongs here.</SketchNote>
      </div>
      <div ref={ref} data-entered={entered} className="pl-research-evidence" data-parallax="-110">
        <span className="pl-evidence-label">PANVAS / RESEARCH NOTEBOOK / ACTUAL CAPTURE</span>
        <ProductImage src="HeroResearchWorkSpace.png" alt="Actual Panvas research page combining a rendered attention equation, explanatory text, Python code and handwritten annotations" sizes="(max-width: 760px) 94vw, 70vw" />
        <div className="pl-research-caption"><span>One page. Several ways to think.</span><span aria-hidden="true">↗</span></div>
      </div>
    </div>
  </section>;
}

function LocalFirst() {
  const reduceMotion = useReducedMotion();
  return (
    <section className="pl-section pl-local" id="local-first" data-scroll-scene>
      <IridescentSurface className="pl-local-material">
        <div className="pl-section-inner pl-local-grid">
          <motion.div
            className="pl-section-copy pl-local-copy"
            initial={false}
            whileInView={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
            viewport={{ once: true, amount: 0.1 }}
            transition={{ duration: 0.35, ease: easeOut }}
          >
            <span className="pl-eyebrow">Local-first by default</span>
            <h2>Your machine is the authority.<br /><em>The cloud is optional.</em></h2>
            <p>Work locally without an account. Optional Google Drive sync is being verified for release. Your device remains the home for your work.</p>
            <motion.div className="pl-storage-relation" aria-label="Local device, then optional sync, then Google Drive" initial={false} whileInView="visible" viewport={{ once: true, amount: .2 }}>
              <strong>Local device</strong>
              <span className="pl-storage-bridge"><span>optional sync</span><svg viewBox="0 0 110 20" aria-hidden="true"><FlowPath d="M2 10H104" /><path d="M96 3L104 10L96 17" /></svg></span>
              <strong>Google Drive</strong>
            </motion.div>
          </motion.div>
          <motion.div
            initial={false}
            whileInView={{ opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }}
            viewport={{ once: true, amount: 0.1 }}
            transition={{ duration: 0.4, ease: easeOut }}
          >
            <ProductStage className="pl-local-stage">
              <ProductMedia className="pl-local-media"><ProductImage src="e.png" alt="Panvas local workspace settings with optional Google Drive connection" /></ProductMedia>
            </ProductStage>
          </motion.div>
        </div>
      </IridescentSurface>
    </section>
  );
}

function Distribution({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  return (
    <section className="pl-section pl-download" id="download">
      <div className="pl-section-inner">
        <div className="pl-download-intro">
          <h2>Choose your surface.</h2>
          <p>A place to begin, with your files on your device. Windows pre-release and browser development builds.</p>
          <p>A place to begin, with your files on your device. Windows installer and browser build.</p>
        </div>
        <div className="pl-distribution-table">
          <div className="pl-distribution-row">
            <div><span className="pl-platform">Panvas Desktop</span><h3>Windows</h3></div>
            <dl><div><dt>Architecture</dt><dd>x64</dd></div><div><dt>System</dt><dd>Windows 10 / 11</dd></div><div><dt>Status</dt><dd>Pre-release verification</dd></div></dl>
            <a className="pl-button pl-button-primary" href={PANVAS_RELEASE.windows.downloadUrl} target="_blank" rel="noreferrer" onClick={() => captureEvent('cta_click', { placement: 'download_windows' })}>
              View release candidates <Download aria-hidden="true" />
            </a>
            <dl><div><dt>Architecture</dt><dd>x64</dd></div><div><dt>System</dt><dd>Windows 10 / 11</dd></div><div><dt>Status</dt><dd>v0.1.2 Release</dd></div></dl>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
              <a className="pl-button pl-button-primary" href={PANVAS_RELEASE.windows.downloadUrl} target="_blank" rel="noreferrer" onClick={() => captureEvent('cta_click', { placement: 'download_windows' })}>
                Download Installer (.exe) <Download aria-hidden="true" />
              </a>
              <Link href="/download" style={{ fontSize: '0.82rem', color: 'var(--pl-ink-dim)', textDecoration: 'underline' }}>
                Verify SHA-256 Checksum ↗
              </Link>
            </div>
          </div>
          <div className="pl-distribution-row">
            <div><span className="pl-platform">Panvas Web</span><h3>Browser</h3></div>
            <dl><div><dt>Storage</dt><dd>IndexedDB</dd></div><div><dt>Support</dt><dd>Chromium-first</dd></div><div><dt>Account</dt><dd>Not required</dd></div></dl>
            <button type="button" className="pl-button pl-button-secondary" onClick={onOpenWorkspace}>Explore browser build <ArrowRight aria-hidden="true" /></button>
            <dl><div><dt>Storage</dt><dd>IndexedDB</dd></div><div><dt>Support</dt><dd>Chromium / Modern</dd></div><div><dt>Account</dt><dd>Not required</dd></div></dl>
            <button type="button" className="pl-button pl-button-secondary" onClick={onOpenWorkspace}>Open Panvas in Browser <ArrowRight aria-hidden="true" /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const reduceMotion = useReducedMotion();
  return (
    <section className="pl-section pl-faq" id="faq">
      <div className="pl-section-inner pl-faq-grid">
        <div><h2>Details, plainly.</h2></div>
        <div className="pl-faq-list">
          {FAQ_ITEMS.map((item, index) => {
            const open = openIndex === index;
            return (
              <div className={'pl-faq-item' + (open ? ' is-open' : '')} key={item.question}>
                <button type="button" aria-expanded={open} aria-controls={'pl-answer-' + index} onClick={() => setOpenIndex(open ? null : index)}>
                  <strong>{item.question}</strong><Plus aria-hidden="true" />
                </button>
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      id={'pl-answer-' + index}
                      className="pl-faq-answer"
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0,-6px,0)' }}
                      animate={reduceMotion ? { opacity: 1 } : { opacity: 1, transform: 'translate3d(0,0,0)' }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translate3d(0,-4px,0)' }}
                      transition={{ duration: reduceMotion ? 0.12 : 0.2, ease: easeOut }}
                    >
                      <p>{item.answer}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function FooterWordmark() {
  const ref = useRef<SVGSVGElement>(null);
  const entered = useInView(ref, { once: true, amount: .15 });
  // Original vector lettering: irregular nib cuts and small ink tails, without a runtime filter.
  return <svg ref={ref} data-entered={entered} className="pl-footer-wordmark" viewBox="0 0 1120 330" role="img" aria-label="Panvas">
    <g fill="currentColor">
      <path d="M66 271L101 67L78 55L165 37L224 59L244 105L221 147L164 165L124 153L109 267L122 280L65 294ZM136 77L126 132L159 142L199 119L206 88L181 67Z" fillRule="evenodd" />
      <path d="M259 162L301 120L353 116L383 138L364 246L387 254L364 275L337 264L331 243L297 272L261 266L244 241ZM287 169L276 236L291 245L329 218L342 152L316 144Z" fillRule="evenodd" />
      <path d="M405 156L394 141L436 115L455 131L448 161L487 125L521 124L540 147L523 243L542 253L522 275L492 266L487 246L505 161L491 153L445 196L431 268L397 280Z" />
      <path d="M567 137L552 126L597 114L613 139L618 228L671 145L661 133L700 119L711 136L624 276L598 281L580 169Z" />
      <path d="M727 168L771 123L814 113L847 136L834 246L853 258L833 277L805 265L801 245L766 275L731 266L712 239ZM754 176L745 236L760 247L798 216L811 151L786 143Z" fillRule="evenodd" />
      <path d="M881 153L911 120L954 114L1000 130L976 164L950 143L926 144L909 164L922 184L970 201L986 228L970 258L932 278L888 270L863 253L886 228L909 249L938 251L954 234L941 218L899 201L877 183Z" />
      <path d="M96 251L89 316L85 304L87 271ZM508 254L502 304L498 290L499 258ZM806 250L804 301L797 287L799 258ZM942 272L939 309L934 298L935 275Z" />
      <path d="M65 88L91 82L75 137ZM227 102L238 94L232 124ZM360 196L372 182L366 218ZM682 159L697 151L675 185ZM976 221L999 216L986 233Z" />
    </g>
    <g fill="none" stroke="#f5f8fb" strokeWidth="2" opacity=".7">
      <path d="M102 105L97 154M158 148L184 135M271 225L268 243M419 218L414 247M506 159L500 192M599 167L606 199M746 209L741 235M907 192L932 201M947 259L960 247M97 195L91 238M148 57L166 53M287 151L309 132M335 249L348 261M432 130L418 138M455 174L474 156M601 213L606 247M665 181L650 205M749 160L770 140M823 233L820 250M922 124L943 121M890 177L900 189" />
    </g>
    <path d="M97 302C252 282 297 304 449 291S746 291 961 288" stroke="currentColor" strokeWidth="1.5" fill="none" opacity=".45" />
  </svg>;
}

function Footer() {
  const reduceMotion = useReducedMotion();
  return (
    <footer className="pl-footer">
      <div className="pl-footer-signoff"><SketchNote>leave a little of yourself on the page.</SketchNote><span aria-hidden="true">✧</span></div>
      <FooterWordmark />
      <motion.div
        className="pl-footer-directory"
        initial={reduceMotion ? false : { transform: 'translate3d(0,16px,0)' }}
        whileInView={{ transform: 'translate3d(0,0,0)' }}
        viewport={{ once: true, amount: 0.45 }}
        transition={{ duration: 0.3, ease: easeOut }}
      >
        <div className="pl-footer-statement">
          <img src="/panvas_logo.png" alt="" />
          <p>Structured when you need it. Spatial when you do not. Local by default.</p>
        </div>
        <nav className="pl-footer-nav" aria-label="Footer navigation">
          <div><span>Product</span><a href="#notebooks">Notebooks</a><a href="#ink">Ink</a><a href="#pdf">PDF</a><a href="#canvas">Canvas</a><a href="#download">Download</a><Link href="/roadmap">Roadmap</Link></div>
          <div><span>Open source</span><a href={PANVAS_RELEASE.project.githubRepoUrl} target="_blank" rel="noreferrer"><Github aria-hidden="true" size={14}/>Repository</a><a href={PANVAS_RELEASE.project.githubReleasesUrl} target="_blank" rel="noreferrer"><Download aria-hidden="true" size={14}/>Releases</a><a href={PANVAS_RELEASE.project.githubIssuesUrl} target="_blank" rel="noreferrer"><CircleDot aria-hidden="true" size={14}/>Issues</a></div>
          <div><span>Trust</span><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/security">Security</Link></div>
          <div><span>Creator</span><a href={PANVAS_RELEASE.project.creatorGithubUrl} target="_blank" rel="noreferrer"><Github aria-hidden="true" size={14}/>Sumit Ahmed</a><a href={PANVAS_RELEASE.project.creatorWebsiteUrl} target="_blank" rel="noreferrer"><Globe aria-hidden="true" size={14}/>Portfolio</a><a href={PANVAS_RELEASE.project.creatorEmailUrl}><Mail aria-hidden="true" size={14}/>Email</a></div>
        </nav>
      </motion.div>
      <div className="pl-footer-row">
        <p>© {PANVAS_RELEASE.project.year} Panvas. Local remains the source of truth.</p>
        <a href="#top">Back to top <ArrowRight aria-hidden="true" /></a>
      </div>
    </footer>
  );
}

export function LandingPage() {
  useLandingChoreography();
  const [, setLocation] = useLocation();
  const reduceMotion = useReducedMotion();
  const handleOpenWorkspace = async () => {
    try {
      if (window.panvas?.workspace?.openDialog) {
        const workspace = await window.panvas.workspace.openDialog();
        if (workspace) {
          const { useWorkspaceStore } = await import('@/stores/workspaceStore');
          await useWorkspaceStore.getState().loadWorkspaces();
          useWorkspaceStore.getState().setActiveWorkspace(workspace.id);
          setLocation('/app');
        }
      } else {
        setLocation('/app');
      }
    } catch (error) {
      console.error('[Panvas] Failed to open workspace:', error);
      setLocation('/app');
    }
  };
  return (
    <div className="panvas-site" onClick={event => {
      const anchor = (event.target as Element).closest('a');
      const href = anchor?.getAttribute('href');
      if (!href?.startsWith('#') || href.startsWith('#/')) return;
      const target = document.getElementById(href.slice(1));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'start' });
      if (href === '#main-content') target.focus({ preventScroll: true });
    }}>
      <LandingAtmosphere />
      <a className="pl-skip" href="#main-content">Skip to content</a>
      <Nav onOpenWorkspace={handleOpenWorkspace} />
      <main id="main-content" tabIndex={-1}>
        <Hero onOpenWorkspace={handleOpenWorkspace} />
        <Notebooks />
        <Ink />
        <PdfSection />
        <CanvasSection />
        <ResearchStory />
        <LocalFirst />
        <Distribution onOpenWorkspace={handleOpenWorkspace} />
        <Faq />
      </main>
      <Footer />
    </div>
  );
}
