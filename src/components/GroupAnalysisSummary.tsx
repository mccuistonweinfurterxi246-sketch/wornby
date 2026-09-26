import React from 'react';
import { ViewedGroup } from '../hooks/useViewedGroups';

function statusLabel(group?: ViewedGroup, analyzing = false): string {
  if (!group || group.analysisVersion !== 2) return analyzing ? 'Checking…' : 'To check';
  if (analyzing && group.complete) return 'Checking…';
  if (group.category === 'mixed') return `Mixed · ${group.totalCount}${group.complete ? '' : '+'}${analyzing ? ' · scanning' : ''}`;
  if (analyzing) return `Checking · ${group.totalCount}+`;
  if (!group.complete) return `Incomplete · ${group.totalCount}+`;
  if (group.category === 'clothing') return `Clothing · ${group.totalCount}`;
  if (group.category === 'items') return `Items · ${group.totalCount}`;
  if (group.category === 'empty') return 'Empty';
  return `Unknown · ${group.unknownCount} unclassified`;
}

export const GroupAnalysisSummary: React.FC<{ group?: ViewedGroup; analyzing?: boolean; compact?: boolean }> = ({ group, analyzing = false, compact = false }) => {
  const tone = group?.category === 'mixed' ? 'text-amber-300'
    : analyzing ? 'text-cyan-300'
    : group?.category === 'clothing' && group.complete ? 'text-cyan-300'
    : group?.category === 'items' && group.complete ? 'text-violet-300'
    : 'text-white/50';
  return <span className={`block truncate font-mono ${compact ? 'text-[10px]' : 'text-xs'} ${tone}`} aria-live={analyzing ? 'polite' : undefined}>{statusLabel(group, analyzing)}</span>;
};
