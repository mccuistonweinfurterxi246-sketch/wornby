import React from 'react';

interface LogoProps {
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ className = "w-12 h-12" }) => (
  <svg 
    viewBox="0 0 200 200" 
    xmlns="http://www.w3.org/2000/svg" 
    className={className}
    style={{ display: 'block' }}
  >
    <circle cx="100" cy="100" r="100" fill="#000" />
    <text 
      x="100" 
      y="114" 
      fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" 
      fontWeight="900" 
      fontSize="72" 
      fill="#fff" 
      textAnchor="middle" 
      dominantBaseline="middle"
      letterSpacing="-3"
    >
      &gt;:#3
    </text>
  </svg>
);
