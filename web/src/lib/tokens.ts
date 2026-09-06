export type ContextStatusLevel = 'normal' | 'approaching' | 'compaction' | 'high' | 'critical';

export interface ContextStatusInfo {
  level: ContextStatusLevel;
  label: string;
  color: string;
  badgeBg: string;
}

export function formatTokens(count: number): string {
  if (count == null || isNaN(count)) return '0';
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1000) {
    const k = count / 1000;
    return k >= 10 ? `${Math.round(k)}K` : `${k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  return String(count);
}

export function getContextStatus(utilizationPercent: number): ContextStatusInfo {
  if (utilizationPercent >= 95) {
    return {
      level: 'critical',
      label: 'Critical',
      color: 'var(--red)',
      badgeBg: 'rgba(248, 81, 73, 0.15)'
    };
  }
  if (utilizationPercent >= 85) {
    return {
      level: 'high',
      label: 'High Context Usage',
      color: 'var(--orange)',
      badgeBg: 'rgba(240, 136, 62, 0.15)'
    };
  }
  if (utilizationPercent >= 70) {
    return {
      level: 'compaction',
      label: 'Compaction Territory',
      color: 'var(--yellow)',
      badgeBg: 'rgba(210, 153, 34, 0.15)'
    };
  }
  if (utilizationPercent >= 60) {
    return {
      level: 'approaching',
      label: 'Approaching Limit',
      color: 'var(--cyan)',
      badgeBg: 'rgba(88, 166, 255, 0.15)'
    };
  }
  return {
    level: 'normal',
    label: 'Normal',
    color: 'var(--green)',
    badgeBg: 'rgba(63, 185, 80, 0.15)'
  };
}
