import React, { useState, useRef, useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  content: React.ReactNode;
  side?: Side;
  align?: 'center' | 'start' | 'end';
  delay?: number;
  children: React.ReactElement;
  className?: string;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  side = 'top',
  align = 'center',
  delay = 380,
  children,
  className,
}) => {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; actualSide: Side }>({ top: 0, left: 0, actualSide: side });
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const id = useId();

  const show = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setOpen(false);
  };

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const update = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const tt = tooltipRef.current;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 8;
      const w = tt?.offsetWidth ?? 180;
      const h = tt?.offsetHeight ?? 28;
      let top = 0, left = 0;
      let actualSide: Side = side;

      // auto-flip if near viewport edge
      if (side === 'top' && rect.top - h - gap < 8) actualSide = 'bottom';
      if (side === 'bottom' && rect.bottom + h + gap > vh - 8) actualSide = 'top';

      if (actualSide === 'top') {
        top = rect.top - h - gap;
        left = align === 'center' ? rect.left + rect.width / 2 - w / 2 : align === 'start' ? rect.left : rect.right - w;
      } else if (actualSide === 'bottom') {
        top = rect.bottom + gap;
        left = align === 'center' ? rect.left + rect.width / 2 - w / 2 : align === 'start' ? rect.left : rect.right - w;
      } else if (actualSide === 'left') {
        top = rect.top + rect.height / 2 - h / 2;
        left = rect.left - w - gap;
      } else {
        top = rect.top + rect.height / 2 - h / 2;
        left = rect.right + gap;
      }
      // clamp horizontal
      left = Math.max(8, Math.min(left, vw - w - 8));
      top = Math.max(8, Math.min(top, vh - h - 8));
      setPos({ top, left, actualSide });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, side, align]);

  // a11y: show on focus
  const child = React.cloneElement(children as React.ReactElement<{ onMouseEnter?: () => void; onMouseLeave?: () => void; onFocus?: () => void; onBlur?: () => void; ref?: React.Ref<HTMLElement>; 'aria-describedby'?: string }>, {
    ref: triggerRef as unknown as React.Ref<HTMLElement>,
    onMouseEnter: () => show(),
    onMouseLeave: () => hide(),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    'aria-describedby': open ? id : undefined,
  });

  const tooltipNode = (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={tooltipRef}
          id={id}
          role="tooltip"
          initial={{ opacity: 0, y: pos.actualSide === 'top' ? 4 : pos.actualSide === 'bottom' ? -4 : 0, x: pos.actualSide === 'left' ? 4 : pos.actualSide === 'right' ? -4 : 0, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos.actualSide === 'top' ? 2 : pos.actualSide === 'bottom' ? -2 : 0, scale: 0.98 }}
          transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          style={{ top: pos.top, left: pos.left }}
          className={`fixed z-[100] pointer-events-none select-none ${className ?? ''}`}
        >
          <div className="relative bg-[#0e0e0f]/95 backdrop-blur-xl border border-white/[0.08] rounded-lg px-3 py-[7px] shadow-[0_8px_32px_rgba(0,0,0,0.6),0_1px_3px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.06)]">
            {/* top highlight */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.08] to-transparent rounded-t-lg pointer-events-none" />
            <div className="text-[11px] font-mono tracking-wide leading-none text-white/90 whitespace-nowrap flex items-center gap-1.5">
              {content}
            </div>
            {/* arrow */}
            <div
              className={`absolute w-2 h-2 bg-[#0e0e0f]/95 border border-white/[0.08] rotate-45 pointer-events-none
                ${pos.actualSide === 'top' ? ' -bottom-[5px] border-t-0 border-l-0' : ''}
                ${pos.actualSide === 'bottom' ? ' -top-[5px] border-b-0 border-r-0' : ''}
                ${pos.actualSide === 'left' ? ' -right-[5px] border-l-0 border-b-0' : ''}
                ${pos.actualSide === 'right' ? ' -left-[5px] border-r-0 border-t-0' : ''}
              `}
              style={{
                left: pos.actualSide === 'top' || pos.actualSide === 'bottom' ? '50%' : undefined,
                top: pos.actualSide === 'left' || pos.actualSide === 'right' ? '50%' : undefined,
                marginLeft: pos.actualSide === 'top' || pos.actualSide === 'bottom' ? '-4px' : undefined,
                marginTop: pos.actualSide === 'left' || pos.actualSide === 'right' ? '-4px' : undefined,
              }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <>
      {child}
      {typeof document !== 'undefined' ? createPortal(tooltipNode, document.body) : null}
    </>
  );
};

// Compact helper for icon-only buttons — adds subtle dot + mono prefix
export const TooltipMono: React.FC<{ label: string; hint?: string; icon?: React.ReactNode }> = ({ label, hint, icon }) => (
  <span className="inline-flex items-center gap-1.5">
    {icon ? <span className="opacity-60">{icon}</span> : <span className="w-1 h-1 rounded-full bg-white/20" />}
    <span className="text-white/90">{label}</span>
    {hint && <span className="text-white/35 font-normal">· {hint}</span>}
  </span>
);
