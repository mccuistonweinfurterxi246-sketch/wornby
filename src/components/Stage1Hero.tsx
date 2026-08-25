import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { AudioHaptics } from './AudioHaptics';
import { SearchButton } from './SearchButton';
import Balatro from './ui/Balatro';

interface Stage1HeroProps {
  onSearch: (query: string) => void;
  isLoading: boolean;
  errorMessage: string | null;
}

export const Stage1Hero: React.FC<Stage1HeroProps> = ({ onSearch, isLoading, errorMessage }) => {
  const [query, setQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || isLoading) return;
    AudioHaptics.playTransitionSubtle();
    onSearch(query.trim());
  };

  return (
    <div className="relative min-h-[100dvh] w-full flex flex-col items-center justify-center overflow-hidden px-4 sm:px-6">
      {/* Balatro Background */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <Balatro
          spinRotation={-4}
          spinSpeed={20}
          color1="#ffffff"
          color2="#7f8182"
          color3="#000000"
          contrast={5.5}
          lighting={0.5}
          spinAmount={0.15}
          pixelFilter={800}
        />
        {/* Vignette Overlay */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.6)_100%)]" />
      </div>

      {/* Floating Center Search Station (Zero Clutter / Richard Sancho Aesthetic) */}
      <div className="relative z-10 w-full max-w-xl flex flex-col items-center">
        {/* Syntax3 Logo */}
        <motion.div 
          className="mb-6 sm:mb-8 flex items-center justify-center w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-black/40 backdrop-blur-xl shadow-2xl border border-white/10 pointer-events-none select-none relative overflow-hidden"
          initial={{ opacity: 0, scale: 0.8, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <span className="text-white font-mono font-bold text-3xl sm:text-4xl tracking-tighter ml-1">
            {'>:#3'}
          </span>
        </motion.div>

        {/* Search Wrapper — ONE unified shell system */}
        <div className="w-full">
          <form 
            onSubmit={handleSubmit}
            className={`w-full relative rounded-2xl p-2 sm:p-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 shadow-2xl transition-all duration-300 ${
              isFocused
                ? 'bg-black/40 backdrop-blur-xl border border-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]'
                : 'bg-black/35 backdrop-blur-xl border border-white/[0.05] shadow-[0_8px_32px_rgba(0,0,0,0.35)]'
            }`}
          >
            {/* Unified cutout: fieldset gap perfectly matches pill width — no back line */}
            <fieldset 
              aria-hidden="true"
              className={`absolute inset-0 m-0 p-0 rounded-2xl pointer-events-none transition-all duration-300 border ${
                isFocused ? 'border-white/10' : 'border-transparent'
              }`}
            >
              <legend 
                className="ml-[18px] sm:ml-[20px] h-0 overflow-hidden transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{ 
                  maxWidth: (isFocused || query) ? '100%' : '0.01px',
                  padding: (isFocused || query) ? '0 6px' : '0 0'
                }}
              >
                <span className="opacity-0 font-mono tracking-wide inline-block text-[10px] sm:text-[11.5px]" style={{ paddingRight: (isFocused || query) ? '0px' : '0' }}>
                  {typeof window !== 'undefined' && window.innerWidth < 640 ? 'roblox user or id...' : 'roblox username or user id...'}
                </span>
              </legend>
            </fieldset>
            <div className="relative flex-1 flex items-center h-11 min-w-0">
              {/* Floating Pill — now ONE with shell: same bg/blur/border family, sits exactly in gap */}
              <motion.div 
                className="absolute left-3 right-3 sm:right-auto flex items-center pointer-events-none z-20 overflow-visible"
                initial={false}
                animate={{
                  y: (isFocused || query) ? -30 : 0,
                  scale: (isFocused || query) ? 0.74 : 1,
                  color: (isFocused || query) ? 'rgb(255 255 255 / 0.75)' : 'var(--muted-foreground)',
                  textShadow: 'none',
                }}
                style={{ originX: 0, originY: 0.5 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              >
                {/* Unified Pill — same material as shell */}
                <div 
                  className={`absolute inset-0 transition-all duration-300 pointer-events-none -z-10 rounded-full ${
                    (isFocused || query)
                      ? 'bg-black/40 backdrop-blur-xl border border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] opacity-100'
                      : 'bg-transparent border border-transparent opacity-0'
                  }`}
                  style={{ inset: (isFocused || query) ? '0px -33px 0px -5px' : '0' }}
                />
                
                <motion.div
                  className={`font-mono tracking-wide transition-all duration-300 whitespace-nowrap truncate max-w-full text-[13px] xs:text-sm sm:text-[14px] ${
                    (isFocused || query) ? 'px-1 sm:px-1.5 py-0.5' : ''
                  }`}
                  initial="hidden"
                  animate="visible"
                  variants={{
                    visible: { transition: { staggerChildren: 0.02, delayChildren: 0.2 } },
                    hidden: { }
                  }}
                >
                  {/* Desktop: full text, Mobile: shortened to avoid wrapping — hidden via CSS */}
                  <span className="hidden sm:inline">
                    {"roblox username or user id...".split('').map((char, index) => (
                      <motion.span
                        key={`d-${index}`}
                        variants={{ hidden: { opacity: 0, y: 4 }, visible: { opacity: 1, y: 0 } }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                        style={{ display: 'inline-block', whiteSpace: 'pre' }}
                      >
                        {char}
                      </motion.span>
                    ))}
                  </span>
                  <span className="sm:hidden">
                    {"roblox user or id...".split('').map((char, index) => (
                      <motion.span
                        key={`m-${index}`}
                        variants={{ hidden: { opacity: 0, y: 4 }, visible: { opacity: 1, y: 0 } }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                        style={{ display: 'inline-block', whiteSpace: 'pre' }}
                      >
                        {char}
                      </motion.span>
                    ))}
                  </span>
                </motion.div>
              </motion.div>

              {/* Minimal Text Input */}
              <input
                id="roblox-search-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder="" // Removed native placeholder
                aria-label="Roblox username or user ID"
                autoComplete="off"
                spellCheck="false"
                disabled={isLoading}
                className="w-full h-full bg-transparent text-foreground text-sm sm:text-lg focus:outline-none font-mono tracking-wide px-3 relative z-10 min-w-0"
              />
            </div>

            {/* Inspect Button - Clean with flying cursors on hover */}
            <div className="w-full sm:w-auto flex-shrink-0">
              <SearchButton 
                isLoading={isLoading} 
                disabled={isLoading || !query.trim()} 
              />
            </div>
          </form>
        </div>

        {/* Error Notification Pill */}
        {errorMessage && (
          <div role="alert" aria-live="polite" className="mt-4 px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-mono flex items-center gap-2 motion-safe:animate-bounce">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 motion-safe:animate-ping" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
};
