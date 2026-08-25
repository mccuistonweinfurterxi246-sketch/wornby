import React, { useRef, useCallback } from 'react';

interface TiltCardProps {
  children: React.ReactNode;
  className?: string;
  maxTilt?: number;
  scale?: number;
  glare?: boolean;
}

export const TiltCard: React.FC<TiltCardProps> = ({
  children,
  className = '',
  maxTilt = 8,
  scale = 1.015,
  glare = true,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const isHoveringRef = useRef(false);

  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const applyTilt = useCallback(() => {
    const p = pendingRef.current;
    const el = cardRef.current;
    const glareEl = glareRef.current;
    rafRef.current = null;
    if (!p || !el) return;
    const centerX = p.w / 2;
    const centerY = p.h / 2;
    // clamp to avoid jump on fast exit
    const rx = ((p.y - centerY) / centerY) * -maxTilt;
    const ry = ((p.x - centerX) / centerX) * maxTilt;
    // direct DOM write — no React state, no re-render, 60fps
    el.style.transform = `perspective(1000px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale3d(${scale}, ${scale}, ${scale})`;
    el.style.transition = 'transform 0.08s linear';
    if (glare && glareEl) {
      const gx = (p.x / p.w) * 100;
      const gy = (p.y / p.h) * 100;
      glareEl.style.opacity = '0.12';
      glareEl.style.background = `radial-gradient(circle at ${gx}% ${gy}%, rgba(255,255,255,0.25) 0%, rgba(255,255,255,0) 60%)`;
    }
  }, [maxTilt, scale, glare]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (prefersReduced) return;
      const el = cardRef.current;
      if (!el) return;
      isHoveringRef.current = true;
      const rect = el.getBoundingClientRect();
      pendingRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(applyTilt);
    },
    [applyTilt, prefersReduced]
  );

  const handleMouseLeave = useCallback(() => {
    isHoveringRef.current = false;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const el = cardRef.current;
    const glareEl = glareRef.current;
    if (el) {
      el.style.transform = 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)';
      el.style.transition = 'transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)';
    }
    if (glareEl) glareEl.style.opacity = '0';
  }, []);

  return (
    <div
      ref={cardRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseLeave}
      tabIndex={-1}
      style={{
        transform: 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)',
        transition: 'transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      className={`relative will-change-transform transform-gpu backface-hidden ${className}`}
    >
      {children}
      {glare && (
        <div
          ref={glareRef}
          className="pointer-events-none absolute inset-0 rounded-[inherit] overflow-hidden"
          style={{
            opacity: 0,
            background: `radial-gradient(circle at 50% 50%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 60%)`,
            transition: 'opacity 0.35s ease',
          }}
          aria-hidden="true"
        />
      )}
    </div>
  );
};
