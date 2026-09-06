import React, { useState, useEffect } from 'react';
import { ProviderStatus } from '../types/index.js';
import { api } from '../lib/api.js';

export const ProvidersPage: React.FC = () => {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<'openrouter' | 'nvidia' | null>(null);
  const [newKey, setNewKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  const loadProviders = async () => {
    try {
      const list = await api.getProviders();
      setProviders(list);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const handleSaveKey = async () => {
    if (!editingProvider || !newKey.trim()) return;
    try {
      await api.setProviderKey(editingProvider, newKey.trim());
      setMessage(`API key for ${editingProvider} updated.`);
      setEditingProvider(null);
      setNewKey('');
      await loadProviders();
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Failed to save key: ${err.message}`);
    }
  };

  const handleTestConnection = async (p: 'openrouter' | 'nvidia') => {
    setTestResults((prev) => ({ ...prev, [p]: { ok: true, message: 'Testing connection...' } }));
    try {
      const res = await api.testProvider(p);
      setTestResults((prev) => ({ ...prev, [p]: res }));
    } catch (err: any) {
      setTestResults((prev) => ({ ...prev, [p]: { ok: false, message: err.message } }));
    }
  };

  if (loading) {
    return <div className="forge-card" style={{ color: 'var(--text-muted)' }}>Loading providers...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="forge-card">
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
          Providers & API Credentials
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          Manage credentials for OpenRouter and NVIDIA NIM. Keys are encrypted at rest in ~/.forge/auth.json and never exposed in plain text.
        </p>
      </div>

      {message && (
        <div style={{ padding: '8px 14px', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--green)', borderRadius: '6px', fontSize: '0.85rem' }}>
          {message}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '20px' }}>
        {providers.map((p) => {
          const test = testResults[p.provider];
          return (
            <div key={p.provider} className="forge-card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                  <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', textTransform: 'capitalize' }}>
                    {p.provider === 'openrouter' ? 'OpenRouter API' : 'NVIDIA NIM API'}
                  </h3>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      color: p.configured ? 'var(--green)' : 'var(--text-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    {p.configured ? '● Connected' : '○ Not Configured'}
                  </span>
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    API KEY
                  </div>
                  <div
                    style={{
                      background: 'var(--bg-input)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '6px',
                      padding: '8px 12px',
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.85rem',
                      color: p.configured ? 'var(--text-primary)' : 'var(--text-muted)'
                    }}
                  >
                    {p.keyMasked || 'No key configured'}
                  </div>
                </div>

                {test && (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      fontSize: '0.8rem',
                      marginBottom: '12px',
                      background: test.ok ? 'rgba(63, 185, 80, 0.15)' : 'rgba(248, 81, 73, 0.15)',
                      color: test.ok ? 'var(--green)' : 'var(--red)'
                    }}
                  >
                    {test.message}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
                <button
                  className="btn"
                  onClick={() => handleTestConnection(p.provider)}
                  disabled={!p.configured}
                >
                  Test Connection
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setEditingProvider(p.provider);
                    setNewKey('');
                  }}
                >
                  {p.configured ? 'Change Key' : 'Add Key'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Edit Modal */}
      {editingProvider && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: '12px' }}>
              Set {editingProvider === 'openrouter' ? 'OpenRouter' : 'NVIDIA'} API Key
            </h3>

            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '12px' }}>
              Enter your API key below. It will be stored in your local ~/.forge/auth.json.
            </p>

            <input
              type="password"
              className="form-input"
              placeholder="Paste API key (e.g. nvapi-... or sk-or-...)"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              style={{ marginBottom: '16px' }}
              autoFocus
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button className="btn" onClick={() => setEditingProvider(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveKey} disabled={!newKey.trim()}>
                Save Key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
