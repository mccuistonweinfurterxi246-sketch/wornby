import React from 'react';

export const NoiseOverlay: React.FC = () => {
  return (
    <div 
      className="fixed inset-0 pointer-events-none z-50 opacity-[0.035] mix-blend-screen"
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
        backgroundRepeat: 'repeat',
      }}
      aria-hidden="true"
    />
  );
};
