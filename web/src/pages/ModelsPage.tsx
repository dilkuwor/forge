import React, { useState, useEffect } from 'react';
import { ModelsDataResponse, ModelInfo } from '../types/index.js';
import { api } from '../lib/api.js';

export const ModelsPage: React.FC = () => {
  const [data, setData] = useState<ModelsDataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [fallbacks, setFallbacks] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const res = await api.getModels();
      setData(res);
      setSelectedModel(res.defaultModel);
      setFallbacks(res.fallbackModels);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSelectDefault = async () => {
    if (!selectedModel) return;
    try {
      await api.selectModel(selectedModel);
      setMessage(`Default model updated to ${selectedModel}`);
      await loadData();
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Error updating default model: ${err.message}`);
    }
  };

  const handleMoveFallback = async (index: number, direction: 'up' | 'down') => {
    const next = [...fallbacks];
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= next.length) return;

    const tmp = next[index];
    next[index] = next[targetIdx];
    next[targetIdx] = tmp;

    setFallbacks(next);
    try {
      await api.setFallbackModels(next);
      setMessage('Fallback chain updated.');
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Failed to save fallback sequence: ${err.message}`);
    }
  };

  const handleRemoveFallback = async (index: number) => {
    const next = fallbacks.filter((_, idx) => idx !== index);
    setFallbacks(next);
    try {
      await api.setFallbackModels(next);
      setMessage('Removed model from fallback chain.');
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Failed to remove model: ${err.message}`);
    }
  };

  const handleAddFallback = async (modelId: string) => {
    if (fallbacks.includes(modelId)) return;
    const next = [...fallbacks, modelId];
    setFallbacks(next);
    try {
      await api.setFallbackModels(next);
      setMessage(`Added ${modelId} to fallback sequence.`);
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      alert(`Failed to add fallback: ${err.message}`);
    }
  };

  const handleRefreshMetadata = async () => {
    setRefreshing(true);
    try {
      const res = await api.refreshModels();
      setMessage(`Refreshed metadata: ${res.openrouterCount} OpenRouter models, ${res.nvidiaCount} NVIDIA models.`);
      await loadData();
      setTimeout(() => setMessage(null), 4000);
    } catch (err: any) {
      alert(`Refresh failed: ${err.message}`);
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return <div className="forge-card" style={{ color: 'var(--text-muted)' }}>Loading models...</div>;
  }

  const allAvailable = [
    ...(data?.openrouter || []),
    ...(data?.nvidia || [])
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div className="forge-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '1.2rem', color: 'var(--text-primary)', marginBottom: '4px' }}>
            Model Routing & Fallbacks
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Configure default and fallback models used by Forge's ReAct loop.
          </p>
        </div>

        <button className="btn" onClick={handleRefreshMetadata} disabled={refreshing}>
          {refreshing ? 'Refreshing...' : '🔄 Refresh Model Metadata'}
        </button>
      </div>

      {message && (
        <div style={{ padding: '8px 14px', background: 'rgba(63, 185, 80, 0.15)', color: 'var(--green)', borderRadius: '6px', fontSize: '0.85rem' }}>
          {message}
        </div>
      )}

      {/* Default Model Selector */}
      <div className="forge-card">
        <h3 className="card-title">Default Model</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <select
            className="form-input"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            style={{ maxWidth: '400px' }}
          >
            {allAvailable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} ({m.provider})
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={handleSelectDefault}>
            Set as Default
          </button>
        </div>
      </div>

      {/* Fallback Chain */}
      <div className="forge-card">
        <h3 className="card-title">Fallback Sequence</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '12px' }}>
          If the active model returns 404, 410, or exhausts retries on rate limits, Forge automatically pivots to the next model in this chain.
        </p>

        {fallbacks.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '8px 0', fontSize: '0.85rem' }}>
            No fallbacks configured.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {fallbacks.map((fb, idx) => (
              <div
                key={fb}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '6px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem', width: '20px' }}>{idx + 1}.</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem', color: 'var(--cyan)' }}>{fb}</span>
                </div>

                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    className="btn btn-sm"
                    disabled={idx === 0}
                    onClick={() => handleMoveFallback(idx, 'up')}
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={idx === fallbacks.length - 1}
                    onClick={() => handleMoveFallback(idx, 'down')}
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleRemoveFallback(idx)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Available Models Explorer */}
      <div className="forge-card">
        <h3 className="card-title">Available Models Catalog</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
          {allAvailable.map((m) => (
            <div
              key={m.id}
              style={{
                padding: '12px',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '6px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between'
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                    {m.name || m.id}
                  </span>
                  <span
                    style={{
                      fontSize: '0.7rem',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      background: m.provider === 'nvidia' ? 'rgba(188, 140, 255, 0.15)' : 'rgba(88, 166, 255, 0.15)',
                      color: m.provider === 'nvidia' ? 'var(--magenta)' : 'var(--cyan)'
                    }}
                  >
                    {m.provider}
                  </span>
                </div>

                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {m.id}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                <button
                  className="btn btn-sm"
                  disabled={fallbacks.includes(m.id)}
                  onClick={() => handleAddFallback(m.id)}
                >
                  {fallbacks.includes(m.id) ? 'In Fallback' : '+ Add to Fallback'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
