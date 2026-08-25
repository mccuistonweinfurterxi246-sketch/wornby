import { useState, useCallback } from 'react';

export function useClipboard(timeout = 2000) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (text: string, key = 'copied') => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove();
      }
      setCopied(key);
      setTimeout(() => setCopied(null), timeout);
      return true;
    } catch { return false; }
  }, [timeout]);
  return { copied, copy, setCopied };
}
