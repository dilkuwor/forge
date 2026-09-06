import React, { useState, useEffect } from 'react';
import { FileChangeItem } from '../types/index.js';
import { api } from '../lib/api.js';

interface DiffViewerProps {
  sessionId?: string | null;
  onRefresh?: () => void;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ sessionId, onRefresh }) => {
  const [files, setFiles] = useState<FileChangeItem[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const loadFiles = async () => {
    try {
      const list = await api.getFiles(sessionId || undefined);
      setFiles(list);
      if (list.length > 0 && !selectedFile) {
        setSelectedFile(list[0].path);
      }
    } catch {
      // ignore
    }
  };

  const loadDiff = async (file?: string) => {
    setLoading(true);
    try {
      const res = await api.getDiff(file, sessionId || undefined);
      setDiffText(res.diff);
    } catch (err: any) {
      setDiffText(`Error loading diff: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, [sessionId]);

  useEffect(() => {
    if (selectedFile) {
      loadDiff(selectedFile);
    } else {
      loadDiff();
    }
  }, [selectedFile, sessionId]);

  const handleCopy = () => {
    if (!diffText) return;
    navigator.clipboard.writeText(diffText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevertFile = async (file: string) => {
    if (!window.confirm(`Are you sure you want to revert changes in "${file}"?`)) return;
    try {
      const res = await api.revertFile(file);
      setActionMessage(res.message);
      await loadFiles();
      if (selectedFile === file) {
        setSelectedFile(null);
      }
      onRefresh?.();
      setTimeout(() => setActionMessage(null), 3000);
    } catch (err: any) {
      alert(`Failed to revert: ${err.message}`);
    }
  };

  const handleRevertForge = async () => {
    if (!window.confirm('Are you sure you want to revert only the changes introduced by this Forge session?')) return;
    try {
      const res = await api.revertForgeChanges();
      setActionMessage(res.message);
      await loadFiles();
      setSelectedFile(null);
      setDiffText('');
      onRefresh?.();
      setTimeout(() => setActionMessage(null), 3000);
    } catch (err: any) {
      alert(`Failed to revert: ${err.message}`);
    }
  };

  return (
    <div className="forge-card">
      <div className="card-title">
        <span>Files & Git Diff</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-sm" onClick={handleCopy} disabled={!diffText}>
            {copied ? '✓ Copied' : 'Copy Diff'}
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleRevertForge} disabled={files.length === 0}>
            Revert Forge Changes
          </button>
        </div>
      </div>

      {actionMessage && (
        <div style={{ padding: '8px 12px', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--green)', borderRadius: '6px', marginBottom: '12px', fontSize: '0.85rem' }}>
          {actionMessage}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '16px', minHeight: '350px' }}>
        {/* File List */}
        <div style={{ borderRight: '1px solid var(--border-subtle)', paddingRight: '12px' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
            CHANGED FILES ({files.length})
          </div>

          {files.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', padding: '8px 0' }}>
              Working tree is clean.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {files.map((f) => {
                let badgeColor = 'var(--cyan)';
                if (f.status === 'M') badgeColor = 'var(--yellow)';
                else if (f.status === 'A' || f.status === '??') badgeColor = 'var(--green)';
                else if (f.status === 'D') badgeColor = 'var(--red)';

                return (
                  <div
                    key={f.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '6px 8px',
                      borderRadius: '4px',
                      background: selectedFile === f.path ? '#21262d' : 'transparent',
                      cursor: 'pointer'
                    }}
                    onClick={() => setSelectedFile(f.path)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
                      <span style={{ color: badgeColor, fontWeight: 'bold', fontSize: '0.75rem', minWidth: '18px' }}>
                        {f.status}
                      </span>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                        {f.path}
                      </span>
                    </div>

                    <button
                      className="btn btn-sm btn-danger"
                      style={{ padding: '2px 6px', fontSize: '0.65rem' }}
                      title="Revert file"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRevertFile(f.path);
                      }}
                    >
                      Revert
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Diff Content */}
        <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px', fontFamily: 'var(--font-mono)' }}>
            {selectedFile ? `Diff for: ${selectedFile}` : 'Combined Workspace Diff'}
          </div>

          {loading ? (
            <div style={{ padding: '20px', color: 'var(--text-muted)' }}>Loading diff...</div>
          ) : !diffText ? (
            <div style={{ padding: '20px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              No diff available for this selection.
            </div>
          ) : (
            <div className="diff-container" style={{ flex: 1, maxHeight: '450px' }}>
              {diffText.split('\n').map((line, idx) => {
                let cls = '';
                if (line.startsWith('+') && !line.startsWith('+++')) cls = 'diff-line-add';
                else if (line.startsWith('-') && !line.startsWith('---')) cls = 'diff-line-del';
                else if (line.startsWith('@@') || line.startsWith('diff --git')) cls = 'diff-line-info';
                return (
                  <span key={idx} className={cls}>
                    {line}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
