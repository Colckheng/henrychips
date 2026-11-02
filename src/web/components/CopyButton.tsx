import { Check, Copy } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export function CopyButton({ text, label = '复制', className = 'button button-secondary button-small' }: {
  text: string; label?: string; className?: string;
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'manual'>('idle');
  const manual = useRef<HTMLTextAreaElement>(null);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  useEffect(() => {
    version.current += 1;
    setStatus('idle');
    return () => { version.current += 1; clearTimeout(timer.current); };
  }, [text]);
  useEffect(() => { if (status === 'manual') { manual.current?.focus(); manual.current?.select(); } }, [status]);
  async function copy() {
    const current = version.current;
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      if (current !== version.current) return;
      setStatus('copied');
      timer.current = setTimeout(() => setStatus('idle'), 2500);
    } catch {
      if (current === version.current) setStatus('manual');
    }
  }
  return <div className="copy-control"><button type="button" className={className} onClick={() => void copy()} aria-label={label}>
    {status === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{status === 'copied' ? '已复制' : label}
  </button><span className="sr-only" role="status">{status === 'copied' ? '已复制到剪贴板' : ''}</span>
    {status === 'manual' && <div className="manual-copy"><p role="status">剪贴板暂不可用，请手动复制。</p><label htmlFor={id}>手动复制内容</label>
      <textarea id={id} ref={manual} readOnly value={text} rows={6} /><button className="text-button" type="button" onClick={() => setStatus('idle')}>收起</button></div>}
  </div>;
}
