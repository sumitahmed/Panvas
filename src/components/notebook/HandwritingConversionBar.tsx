import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { Check, Copy, Download, LoaderCircle, Sigma, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useFullDarkView } from '@/hooks/useFullDarkView';

export interface HandwritingConversionBarProps {
  open: boolean;
  mode: 'text' | 'math';
  isRecognizing?: boolean;
  initialValue: string;
  lineCount?: number;
  strokeCount?: number;
  statusMessage?: string | null;
  isEditingExisting?: boolean;
  onApply: (value: string) => void | Promise<void>;
  onCancel: () => void;
  onOpenLineOptions?: () => void;
  onRetryMathRecognition?: () => void;
}

interface MathChipSpec {
  id: string;
  label: string;
  snippet: string;
  cursorOffset?: number;
  wrapSelection?: (selected: string) => { text: string; cursorStart: number; cursorEnd: number };
}

type MathChipCategoryId = 'basic' | 'calculus' | 'linalg' | 'greek' | 'logic';

interface MathChipCategory {
  id: MathChipCategoryId;
  label: string;
  chips: readonly MathChipSpec[];
}

const MATH_CHIP_CATEGORIES: readonly MathChipCategory[] = [
  {
    id: 'basic',
    label: 'Basic',
    chips: [
      {
        id: 'frac',
        label: '\\frac{a}{b}',
        snippet: '\\frac{a}{b}',
        wrapSelection: selected => ({
          text: `\\frac{${selected}}{}`,
          cursorStart: 6 + selected.length + 2,
          cursorEnd: 6 + selected.length + 2,
        }),
      },
      {
        id: 'sqrt',
        label: '\\sqrt{x}',
        snippet: '\\sqrt{x}',
        wrapSelection: selected => ({
          text: `\\sqrt{${selected}}`,
          cursorStart: 6 + selected.length + 1,
          cursorEnd: 6 + selected.length + 1,
        }),
      },
      {
        id: 'sup',
        label: '^{2}',
        snippet: '^{2}',
        wrapSelection: selected => ({
          text: `${selected}^{2}`,
          cursorStart: selected.length + 2,
          cursorEnd: selected.length + 3,
        }),
      },
      {
        id: 'sub',
        label: '_{i}',
        snippet: '_{i}',
        wrapSelection: selected => ({
          text: `${selected}_{i}`,
          cursorStart: selected.length + 2,
          cursorEnd: selected.length + 3,
        }),
      },
      {
        id: 'parens',
        label: '\\left(\\right)',
        snippet: '\\left(\\right)',
        cursorOffset: 6,
        wrapSelection: selected => ({
          text: `\\left(${selected}\\right)`,
          cursorStart: 6 + selected.length + 7,
          cursorEnd: 6 + selected.length + 7,
        }),
      },
      { id: 'pm', label: '\\pm', snippet: '\\pm ' },
      { id: 'neq', label: '\\neq', snippet: '\\neq ' },
      { id: 'le', label: '\\le', snippet: '\\le ' },
      { id: 'ge', label: '\\ge', snippet: '\\ge ' },
      { id: 'approx', label: '\\approx', snippet: '\\approx ' },
      { id: 'times', label: '\\times', snippet: '\\times ' },
      { id: 'div', label: '\\div', snippet: '\\div ' },
    ],
  },
  {
    id: 'calculus',
    label: 'Calculus',
    chips: [
      { id: 'int', label: '\\int_{a}^{b}', snippet: '\\int_{a}^{b} ', cursorOffset: 12 },
      { id: 'iint', label: '\\iint', snippet: '\\iint ' },
      { id: 'oint', label: '\\oint', snippet: '\\oint ' },
      { id: 'sum', label: '\\sum_{i=1}^{n}', snippet: '\\sum_{i=1}^{n} ' },
      { id: 'prod', label: '\\prod_{i=1}^{n}', snippet: '\\prod_{i=1}^{n} ' },
      { id: 'lim', label: '\\lim_{x\\to 0}', snippet: '\\lim_{x \\to 0} ' },
      { id: 'deriv', label: '\\frac{d}{dx}', snippet: '\\frac{d}{dx} ' },
      { id: 'pderiv', label: '\\frac{\\partial}{\\partial x}', snippet: '\\frac{\\partial}{\\partial x} ' },
      { id: 'nabla', label: '\\nabla', snippet: '\\nabla ' },
      { id: 'infty', label: '\\infty', snippet: '\\infty' },
    ],
  },
  {
    id: 'linalg',
    label: 'Linear Alg',
    chips: [
      { id: 'pmatrix', label: '2×2 Matrix', snippet: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
      { id: 'bmatrix', label: '2×2 Bracket', snippet: '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}' },
      { id: 'vec', label: '\\vec{v}', snippet: '\\vec{v}' },
      { id: 'hat', label: '\\hat{u}', snippet: '\\hat{u}' },
      { id: 'norm', label: '\\|x\\|', snippet: '\\|x\\|' },
      { id: 'inner', label: '\\langle u,v \\rangle', snippet: '\\langle u, v \\rangle' },
      { id: 'transpose', label: '^{T}', snippet: '^{T}' },
      { id: 'inverse', label: '^{-1}', snippet: '^{-1}' },
      { id: 'det', label: '\\det(A)', snippet: '\\det(A)' },
    ],
  },
  {
    id: 'greek',
    label: 'Greek',
    chips: [
      { id: 'alpha', label: '\\alpha', snippet: '\\alpha' },
      { id: 'beta', label: '\\beta', snippet: '\\beta' },
      { id: 'gamma', label: '\\gamma', snippet: '\\gamma' },
      { id: 'delta', label: '\\delta', snippet: '\\delta' },
      { id: 'epsilon', label: '\\epsilon', snippet: '\\epsilon' },
      { id: 'theta', label: '\\theta', snippet: '\\theta' },
      { id: 'lambda', label: '\\lambda', snippet: '\\lambda' },
      { id: 'mu', label: '\\mu', snippet: '\\mu' },
      { id: 'pi', label: '\\pi', snippet: '\\pi' },
      { id: 'sigma', label: '\\sigma', snippet: '\\sigma' },
      { id: 'phi', label: '\\phi', snippet: '\\phi' },
      { id: 'omega', label: '\\omega', snippet: '\\omega' },
      { id: 'Delta', label: '\\Delta', snippet: '\\Delta' },
      { id: 'Omega', label: '\\Omega', snippet: '\\Omega' },
    ],
  },
  {
    id: 'logic',
    label: 'Logic / Sets',
    chips: [
      { id: 'forall', label: '\\forall', snippet: '\\forall ' },
      { id: 'exists', label: '\\exists', snippet: '\\exists ' },
      { id: 'in', label: '\\in', snippet: '\\in ' },
      { id: 'notin', label: '\\notin', snippet: '\\notin ' },
      { id: 'subset', label: '\\subset', snippet: '\\subset ' },
      { id: 'subseteq', label: '\\subseteq', snippet: '\\subseteq ' },
      { id: 'cup', label: '\\cup', snippet: '\\cup ' },
      { id: 'cap', label: '\\cap', snippet: '\\cap ' },
      { id: 'emptyset', label: '\\emptyset', snippet: '\\emptyset' },
      { id: 'implies', label: '\\Rightarrow', snippet: '\\Rightarrow ' },
      { id: 'iff', label: '\\Leftrightarrow', snippet: '\\Leftrightarrow ' },
      { id: 'reals', label: '\\mathbb{R}', snippet: '\\mathbb{R}' },
    ],
  },
];

export function HandwritingConversionBar({
  open,
  mode,
  isRecognizing = false,
  initialValue,
  lineCount,
  strokeCount,
  statusMessage,
  isEditingExisting = false,
  onApply,
  onCancel,
  onOpenLineOptions,
  onRetryMathRecognition,
}: HandwritingConversionBarProps) {
  const fullDarkView = useFullDarkView();
  const [value, setValue] = useState(initialValue);
  const [copied, setCopied] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [activeChipTab, setActiveChipTab] = useState<MathChipCategoryId>('basic');
  const [mathModelReady, setMathModelReady] = useState<boolean>(true);
  const [mathModelSizeMb, setMathModelSizeMb] = useState<number>(317);
  const [isDownloadingModel, setIsDownloadingModel] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ percent: number; downloadedMb: number; totalMb: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setCopied(false);
    setIsApplying(false);
  }, [initialValue, open]);

  useEffect(() => {
    if (!open) return;
    const handle = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
    });
    return () => cancelAnimationFrame(handle);
  }, [open, mode]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel, open]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    const mathOcr = typeof window !== 'undefined' ? window.panvas?.mathOcr : undefined;
    if (!open || mode !== 'math' || isEditingExisting || !mathOcr) {
      setMathModelReady(true);
      return;
    }
    let cancelled = false;
    void mathOcr.getStatus().then(status => {
      if (cancelled) return;
      setMathModelReady(status.ready);
      setMathModelSizeMb(status.approxSizeMb || 317);
    }).catch(() => {});
    const unsubscribe = mathOcr.onProgress(progress => {
      if (cancelled) return;
      setDownloadProgress({
        percent: Math.max(0, Math.min(100, progress.percent)),
        downloadedMb: Math.round(progress.downloadedBytes / (1024 * 1024)),
        totalMb: Math.max(1, Math.round(progress.totalBytes / (1024 * 1024))),
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open, mode, isEditingExisting]);

  const handleDownloadLocalMathModel = useCallback(async () => {
    const mathOcr = typeof window !== 'undefined' ? window.panvas?.mathOcr : undefined;
    if (!mathOcr || isDownloadingModel) return;
    setDownloadError(null);
    setIsDownloadingModel(true);
    setDownloadProgress({ percent: 0, downloadedMb: 0, totalMb: mathModelSizeMb });
    try {
      const status = await mathOcr.downloadModel();
      setMathModelReady(status.ready);
      if (status.ready) {
        onRetryMathRecognition?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download cancelled or failed';
      if (!/cancel/i.test(msg)) setDownloadError(msg);
    } finally {
      setIsDownloadingModel(false);
    }
  }, [isDownloadingModel, mathModelSizeMb, onRetryMathRecognition]);

  const handleCancelModelDownload = useCallback(async () => {
    const mathOcr = typeof window !== 'undefined' ? window.panvas?.mathOcr : undefined;
    if (!mathOcr) return;
    await mathOcr.cancel().catch(() => {});
    setIsDownloadingModel(false);
  }, []);

  const katexPreview = useMemo(() => {
    if (mode !== 'math') return null;
    const latex = value.trim();
    if (!latex) {
      return { html: '', error: null as string | null, isEmpty: true };
    }
    try {
      const html = katex.renderToString(latex, {
        displayMode: true,
        throwOnError: true,
        strict: false,
        trust: false,
        output: 'htmlAndMathml',
      });
      return { html, error: null as string | null, isEmpty: false };
    } catch (err) {
      const fallbackHtml = katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: false,
        trust: false,
        output: 'htmlAndMathml',
      });
      const message = err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/i, '') : 'Invalid LaTeX syntax';
      return { html: fallbackHtml, error: message, isEmpty: false };
    }
  }, [mode, value]);

  const handleApply = useCallback(async () => {
    if (!value.trim() || isRecognizing || isApplying) return;
    setIsApplying(true);
    try {
      await onApply(value);
    } finally {
      setIsApplying(false);
    }
  }, [isApplying, isRecognizing, onApply, value]);

  const handleCopy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be unavailable in restricted contexts; fail quietly.
    }
  }, [value]);

  const handleInsertChip = useCallback((chip: MathChipSpec) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const selected = value.slice(start, end);

    let insertedText = chip.snippet;
    let nextCursorStart = start + (chip.cursorOffset ?? insertedText.length);
    let nextCursorEnd = nextCursorStart;

    if (selected.length > 0 && chip.wrapSelection) {
      const wrapped = chip.wrapSelection(selected);
      insertedText = wrapped.text;
      nextCursorStart = start + wrapped.cursorStart;
      nextCursorEnd = start + wrapped.cursorEnd;
    }

    const nextValue = `${value.slice(0, start)}${insertedText}${value.slice(end)}`;
    setValue(nextValue);

    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextCursorStart, nextCursorEnd);
    });
  }, [value]);

  if (!open) return null;

  const title = mode === 'math'
    ? (isEditingExisting ? 'Edit Math Equation' : 'Convert to Math')
    : (isEditingExisting ? 'Edit Recognized Text' : 'Convert to Text');

  const canApply = Boolean(value.trim()) && !isRecognizing && !isApplying;

  return (
    <section
      role="dialog"
      aria-label={title}
      data-testid="handwriting-conversion-bar"
      className="fixed bottom-9 left-1/2 -translate-x-1/2 z-[60] w-[min(760px,calc(100vw-24px))] max-h-[min(420px,calc(100vh-110px))] flex flex-col rounded-xl border border-panvas-border-default bg-panvas-bg-elevated/95 text-panvas-text-primary shadow-2xl backdrop-blur-md panvas-floating-surface"
      onPointerDown={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
    >
      <header className="flex items-center justify-between gap-2 border-b border-panvas-border-subtle px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {mode === 'math' ? (
            <Sigma size={16} className="shrink-0 text-panvas-accent-violet" aria-hidden="true" />
          ) : (
            <Sparkles size={16} className="shrink-0 text-panvas-accent-blue" aria-hidden="true" />
          )}
          <span className="truncate text-sm font-semibold text-panvas-text-primary">{title}</span>
          {isRecognizing && (
            <span className="inline-flex items-center gap-1 rounded-md bg-panvas-bg-secondary px-2 py-0.5 text-2xs text-panvas-text-secondary">
              <LoaderCircle size={12} className="animate-spin text-panvas-accent-blue" aria-hidden="true" />
              {statusMessage && statusMessage.startsWith('Recognizing') ? statusMessage : 'Recognizing…'}
            </span>
          )}
          {!isRecognizing && typeof lineCount === 'number' && lineCount > 0 && (
            <span className="hidden rounded-md bg-panvas-bg-secondary px-1.5 py-0.5 text-2xs text-panvas-text-tertiary sm:inline-block">
              {lineCount} {lineCount === 1 ? 'line' : 'lines'}
            </span>
          )}
          {!isRecognizing && typeof strokeCount === 'number' && strokeCount > 0 && (
            <span className="hidden rounded-md bg-panvas-bg-secondary px-1.5 py-0.5 text-2xs text-panvas-text-tertiary sm:inline-block">
              {strokeCount} {strokeCount === 1 ? 'stroke' : 'strokes'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close conversion bar"
          className="rounded-lg p-1 text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3 overflow-y-auto">
        {mode === 'math' && !isEditingExisting && typeof window !== 'undefined' && window.panvas?.mathOcr && !mathModelReady && (
          <div
            data-testid="math-ai-download-banner"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-panvas-accent-violet/35 bg-panvas-accent-violet/10 px-3 py-2 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium text-panvas-text-primary">
                Local Math AI model (~{mathModelSizeMb} MB, one-time, offline)
              </div>
              {isDownloadingModel && downloadProgress ? (
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panvas-bg-secondary">
                    <div
                      className="h-full bg-panvas-accent-violet transition-[width]"
                      style={{ width: `${downloadProgress.percent}%` }}
                    />
                  </div>
                  <span className="shrink-0 font-mono text-2xs text-panvas-text-secondary">
                    {downloadProgress.percent}% ({downloadProgress.downloadedMb}/{downloadProgress.totalMb} MB)
                  </span>
                </div>
              ) : (
                <div className="text-2xs text-panvas-text-secondary">
                  {downloadError || 'Enables School-to-PhD neural recognition for fractions, integrals, matrices & limits.'}
                </div>
              )}
            </div>
            {isDownloadingModel ? (
              <button
                type="button"
                data-testid="math-ai-download-cancel"
                onClick={() => void handleCancelModelDownload()}
                className="shrink-0 rounded-md border border-panvas-border-subtle bg-panvas-bg-secondary px-2.5 py-1 text-2xs font-medium text-panvas-text-primary hover:bg-panvas-bg-hover focus-ring"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                data-testid="math-ai-download-start"
                onClick={() => void handleDownloadLocalMathModel()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-panvas-accent-violet px-2.5 py-1 text-2xs font-semibold text-white hover:brightness-110 focus-ring"
              >
                <Download size={12} aria-hidden="true" />
                Download Model (~{mathModelSizeMb} MB)
              </button>
            )}
          </div>
        )}

        {!isRecognizing && statusMessage && (
          <div className="rounded-lg border border-panvas-accent-amber/30 bg-panvas-accent-amber/10 px-2.5 py-1.5 text-xs text-panvas-text-secondary">
            {statusMessage}
          </div>
        )}

        {mode === 'math' && katexPreview && (
          <div
            data-testid="handwriting-math-preview"
            data-full-dark={fullDarkView ? 'true' : 'false'}
            className="panvas-document-text max-h-[156px] overflow-auto rounded-lg border border-panvas-border-subtle px-3 py-2"
            style={fullDarkView
              ? { backgroundColor: '#0f172a', color: '#f8fafc', borderColor: 'rgba(148, 163, 184, 0.3)' }
              : { backgroundColor: 'rgba(var(--bg-secondary), 0.6)', color: 'rgb(var(--text-primary))' }}
          >
            {katexPreview.error && (
              <div className="mb-1 inline-flex max-w-full items-center gap-1 rounded bg-panvas-accent-amber/15 px-1.5 py-0.5 text-2xs text-panvas-accent-amber">
                <span className="truncate">{katexPreview.error}</span>
              </div>
            )}
            {katexPreview.isEmpty ? (
              <p className="py-1 text-center text-xs opacity-70">
                {isRecognizing ? 'Recognizing math expression…' : 'Enter LaTeX below to preview equation'}
              </p>
            ) : (
              <div
                className="min-w-0 overflow-x-auto text-center"
                dangerouslySetInnerHTML={{ __html: katexPreview.html }}
              />
            )}
          </div>
        )}

        {mode === 'math' && (
          <div className="flex flex-col gap-1.5">
            <div role="tablist" aria-label="LaTeX formula categories" className="flex items-center gap-1 overflow-x-auto">
              {MATH_CHIP_CATEGORIES.map(category => {
                const active = category.id === activeChipTab;
                return (
                  <button
                    key={category.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={`math-chip-tab-${category.id}`}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => setActiveChipTab(category.id)}
                    className={`shrink-0 rounded-md px-2 py-0.5 text-2xs font-medium transition-colors focus-ring ${
                      active
                        ? 'bg-panvas-text-primary text-panvas-bg-primary'
                        : 'text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary'
                    }`}
                  >
                    {category.label}
                  </button>
                );
              })}
            </div>
            <div
              className="flex items-center gap-1 overflow-x-auto pb-0.5"
              aria-label="Quick LaTeX symbol chips"
            >
              {(MATH_CHIP_CATEGORIES.find(c => c.id === activeChipTab) ?? MATH_CHIP_CATEGORIES[0]).chips.map(chip => (
                <button
                  key={chip.id}
                  type="button"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => handleInsertChip(chip)}
                  className="shrink-0 rounded-md border border-panvas-border-subtle bg-panvas-bg-secondary px-2 py-1 font-mono text-2xs text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <textarea
          ref={textareaRef}
          data-testid="handwriting-conversion-textarea"
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              void handleApply();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          placeholder={
            isRecognizing
              ? (mode === 'math' ? 'Recognizing handwritten math…' : 'Recognizing handwriting…')
              : (mode === 'math' ? 'Edit LaTeX expression…' : 'Edit recognized text…')
          }
          rows={mode === 'math' ? 3 : 4}
          className={`overflow-y-auto min-h-[82px] max-h-[180px] w-full resize-y rounded-lg border border-panvas-border-default bg-panvas-bg-primary/90 p-2.5 text-panvas-text-primary outline-none focus:border-panvas-accent-blue ${
            mode === 'math' ? 'font-mono text-xs leading-5' : 'text-sm leading-relaxed'
          }`}
        />
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-panvas-border-subtle px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          {mode === 'text' && onOpenLineOptions && (
            <button
              type="button"
              onClick={onOpenLineOptions}
              className="inline-flex items-center gap-1.5 rounded-lg border border-panvas-border-subtle px-2.5 py-1.5 text-xs font-medium text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
            >
              <SlidersHorizontal size={13} aria-hidden="true" />
              Line options…
            </button>
          )}
          <span className="hidden text-2xs text-panvas-text-tertiary sm:inline">
            Ctrl/Cmd+Enter to apply · Esc to cancel
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-panvas-text-secondary hover:bg-panvas-bg-hover hover:text-panvas-text-primary focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={!value}
            className="inline-flex items-center gap-1.5 rounded-lg border border-panvas-border-subtle bg-panvas-bg-secondary px-2.5 py-1.5 text-xs font-medium text-panvas-text-primary hover:bg-panvas-bg-hover disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
          >
            {copied ? (
              <>
                <Check size={13} className="text-panvas-accent-emerald" aria-hidden="true" />
                Copied
              </>
            ) : (
              <>
                <Copy size={13} aria-hidden="true" />
                {mode === 'math' ? 'Copy LaTeX' : 'Copy'}
              </>
            )}
          </button>
          <button
            type="button"
            data-testid="handwriting-conversion-apply"
            onClick={() => void handleApply()}
            disabled={!canApply}
            className="rounded-lg bg-panvas-text-primary px-3 py-1.5 text-xs font-semibold text-panvas-bg-primary hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-ring"
          >
            {isApplying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </footer>
    </section>
  );
}

export default HandwritingConversionBar;
