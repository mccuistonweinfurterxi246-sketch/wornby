import React, { useState, useMemo } from 'react';
import { motion, useMotionValue, useSpring, useTransform, AnimatePresence } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

interface SearchButtonProps {
  isLoading: boolean;
  disabled: boolean;
  onClick?: () => void;
}

export const SearchButton: React.FC<SearchButtonProps> = ({ isLoading, disabled, onClick }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [viewport, setViewport] = useState<'mobile' | 'tablet' | 'desktop'>(() => {
    if (typeof window === 'undefined') return 'desktop';
    if (window.innerWidth < 640) return 'mobile';
    if (window.innerWidth < 1024) return 'tablet';
    return 'desktop';
  });

  React.useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 640) setViewport('mobile');
      else if (window.innerWidth < 1024) setViewport('tablet');
      else setViewport('desktop');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isTouch = typeof window !== 'undefined' && (('ontouchstart' in window) || window.matchMedia?.('(pointer: coarse)').matches);
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Mouse tracking for the flying effect
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const springX = useSpring(mouseX, { stiffness: 150, damping: 25 });
  const springY = useSpring(mouseY, { stiffness: 150, damping: 25 });

  const wrapperX = useTransform(springX, (val) => `calc(-50% + ${val}px)`);
  const wrapperY = useTransform(springY, (val) => `calc(-50% + ${val}px)`);

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isTouch || prefersReduced) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    mouseX.set(x);
    mouseY.set(y);
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    mouseX.set(0);
    mouseY.set(0);
  };

  // UNIQUE IDEA: Phyllotaxis Spiral — adaptive for mobile/tablet/desktop
  const cursors = useMemo(() => {
    const nodes: Array<{
      id: string;
      finalX: number;
      finalY: number;
      delay: number;
      rotation: number;
    }> = [];
    
    // Adaptive: mobile = compact, less clutter; desktop = full bloom
    const cfg = viewport === 'mobile'
      ? { total: 14, base: 28, growth: 12, maxR: 90 }
      : viewport === 'tablet'
        ? { total: 24, base: 40, growth: 18, maxR: 140 }
        : { total: 42, base: 60, growth: 25, maxR: 220 };
    const totalNodes = prefersReduced ? Math.min(cfg.total, 8) : cfg.total;
    const goldenAngle = 137.508 * (Math.PI / 180);
    
    for (let i = 1; i <= totalNodes; i++) {
      let radius = cfg.base + cfg.growth * Math.sqrt(i);
      radius = Math.min(radius, cfg.maxR);
      // on mobile, clamp Y to avoid flying over logo/input — flatten vertical spread
      const angle = i * goldenAngle;
      
      let x = Math.cos(angle) * radius;
      let y = Math.sin(angle) * radius;
      if (viewport === 'mobile') {
        // compress vertical by 0.6, keep within button orbit
        y *= 0.55;
        // also keep inside viewport padding
        x = Math.max(-75, Math.min(75, x));
        y = Math.max(-50, Math.min(50, y));
      }
      
      const rotationOutward = (angle * (180 / Math.PI)) - 45;

      nodes.push({
        id: `cursor-node-${i}`,
        finalX: x,
        finalY: y,
        delay: Math.sqrt(i) * 0.06,
        rotation: rotationOutward
      });
    }
    
    return nodes;
  }, [viewport, prefersReduced]);

  // Effect is active if hovered, clicked, OR currently loading.
  // Disable flying cursors on touch devices (hover not meaningful) — only show on loading pulse
  // We ignore `disabled` if it's disabled *because* of loading.
  const isEffectActive = !prefersReduced && !isTouch
    ? (isHovered || isActive || isLoading) && (isLoading || !disabled)
    : isLoading && !disabled;

  return (
    <button
      type="submit"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onMouseDown={() => setIsActive(true)}
      onMouseUp={() => setIsActive(false)}
      aria-label="Inspect Roblox Outfit"
      className={`relative overflow-visible h-11 px-6 rounded-xl font-mono text-sm font-semibold tracking-wider uppercase transition-all duration-300 flex items-center justify-center gap-2 group flex-shrink-0 z-20 border w-full sm:w-auto ${
        !disabled
          ? 'bg-white/5 backdrop-blur-md text-foreground border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] hover:bg-white/10 hover:border-white/[0.15] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_15px_rgba(255,255,255,0.03)] active:scale-95'
          : 'bg-black/20 backdrop-blur-md text-muted-foreground border-transparent cursor-not-allowed'
      }`}
    >

      {/* Desktop: full bloom Phyllotaxis */}
      <AnimatePresence>
        {isEffectActive && viewport !== 'mobile' && (
          <motion.div
            className="absolute pointer-events-none z-[-1]"
            style={{ 
              left: '50%', 
              top: '50%',
              x: wrapperX,
              y: wrapperY
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, rotate: -360 }}
            exit={{ opacity: 0 }}
            transition={{
              rotate: {
                duration: 40,
                repeat: Infinity,
                ease: "linear"
              },
              opacity: {
                duration: 0.6,
                ease: "easeInOut"
              }
            }}
          >
            {cursors.map((cursor) => (
              <motion.div
                key={cursor.id}
                className="absolute pointer-events-none will-change-transform"
                initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
                animate={{
                  x: cursor.finalX,
                  y: cursor.finalY,
                  opacity: [0, 1, 0.5, 1],
                  scale: 1
                }}
                exit={{
                  x: 0,
                  y: 0,
                  opacity: 0,
                  scale: 0,
                  transition: { duration: 0.5, ease: "easeIn" }
                }}
                transition={{
                  duration: 0.8,
                  delay: cursor.delay,
                  ease: "easeOut",
                  type: "spring",
                  damping: 20,
                  stiffness: 150,
                  opacity: {
                    duration: 3,
                    repeat: Infinity,
                    repeatType: "mirror",
                    delay: cursor.delay
                  }
                }}
              >
                <svg 
                  xmlns="http://www.w3.org/2000/svg" 
                  viewBox="0 0 50 50"
                  className="w-5 h-5 text-foreground drop-shadow-lg fill-current" 
                  style={{ 
                    filter: 'drop-shadow(0 0 6px var(--primary))',
                    transform: `rotate(${cursor.rotation}deg)`
                  }}
                >
                  <path d="M 21 3 C 11.601563 3 4 10.601563 4 20 C 4 29.398438 11.601563 37 21 37 C 24.355469 37 27.460938 36.015625 30.09375 34.34375 L 42.375 46.625 L 46.625 42.375 L 34.5 30.28125 C 36.679688 27.421875 38 23.878906 38 20 C 38 10.601563 30.398438 3 21 3 Z M 21 7 C 28.199219 7 34 12.800781 34 20 C 34 27.199219 28.199219 33 21 33 C 13.800781 33 8 27.199219 8 20 C 8 12.800781 13.800781 7 21 7 Z"></path>
                </svg>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {/* Mobile: compact inline shimmer (confined, no overflow) */}
      <AnimatePresence>
        {isLoading && viewport === 'mobile' && (
          <motion.div
            className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl sm:hidden flex items-center justify-center gap-1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <motion.div
                key={`m-dot-${i}`}
                className="w-1.5 h-1.5 rounded-full bg-white/40"
                animate={{ opacity: [0.2, 1, 0.2], scale: [0.8, 1.2, 0.8] }}
                transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.1 }}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      
      {/* Button Content */}
      <span className="relative z-10 drop-shadow-sm flex items-center gap-2">
        <span>{isLoading ? 'SCANNING' : 'INSPECT'}</span>
        <ArrowRight className="w-4 h-4 stroke-[2.5]" />
      </span>
    </button>
  );
};
