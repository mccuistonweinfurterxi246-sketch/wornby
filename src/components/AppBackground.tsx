import React from 'react';
import GradientASCII from './ui/GradientASCII';

// App background: "Atmosphere" preset of React Bits GradientASCII. dpr 1 keeps the full-screen
// passes cheap on any GPU (it sits under a vignette, so the softer glyphs on retina don't show).
export const AppBackground: React.FC<{ paused?: boolean }> = ({ paused = false }) => (
  <GradientASCII
    colors={['#fafafa', '#676767', '#6d7379', '#dce7eb']}
    shape="horizon"
    characters=" .:-=+*#%@"
    cellSize={17}
    density={0.58}
    glyphOpacity={0.85}
    glow={0.95}
    depthOfField={0.2}
    flicker={0.25}
    softness={0.93}
    scale={1}
    flow={0}
    speed={0.35}
    gradientOpacity={0.87}
    grain={0.08}
    variation={0}
    mouseInteraction
    scrambleRadius={0.19}
    clickEffect="wave"
    intro
    lightMode={false}
    dpr={1}
    paused={paused}
  />
);
