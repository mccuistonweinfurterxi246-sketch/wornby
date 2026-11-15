import React from 'react';

type Kind = 'player' | 'group' | 'worn' | 'saved';

const TONE: Record<Kind, string> = {
  player: 'border-cyan-300/30 text-cyan-200/85',
  group: 'border-violet-300/30 text-violet-200/85',
  worn: 'border-white/20 text-white/65',
  saved: 'border-emerald-300/30 text-emerald-200/80',
};

/** Where content comes from: made by the player, made by their group, worn, or saved. */
export const SourceChip: React.FC<{ kind: Kind; name?: string }> = ({ kind, name }) => {
  const label = kind === 'player' ? `MADE BY @${name}` : kind === 'group' ? `MADE BY ${name}` : kind === 'worn' ? 'WORN' : 'SAVED';
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-wide ${TONE[kind]}`}>{label}</span>;
};
