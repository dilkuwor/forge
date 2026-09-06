import React, { useState } from 'react';

interface TerminalOutputProps {
  output: string;
}

export const TerminalOutput: React.FC<TerminalOutputProps> = ({ output }) => {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleCopy = () => {
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="forge-card">
      <div className="card-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>💻</span>
          <span>Terminal Output</span>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-sm" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Collapse' : 'Expand'}
          </button>
          <button className="btn btn-sm" onClick={handleCopy} disabled={!output}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <pre
        style={{
          background: '#090d13',
          border: '1px solid var(--border-subtle)',
          borderRadius: '6px',
          padding: '12px 14px',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.85rem',
          color: 'var(--text-secondary)',
          maxHeight: expanded ? '600px' : '220px',
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
      >
        {output || '// No terminal commands executed yet...'}
      </pre>
    </div>
  );
};
