import { useEffect, useState } from 'react';

import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import type { DashboardApiClient } from '../api';
import type { DashboardStatus } from '../types';

interface StatusDialogProps {
  api: DashboardApiClient;
  onClose(): void;
  status: DashboardStatus;
}

export function StatusDialog({ api, onClose, status }: StatusDialogProps) {
  const [copyState, setCopyState] = useState<'copied' | 'error' | 'idle'>('idle');
  const [liveStatus, setLiveStatus] = useState(status);

  useEffect(() => {
    const controller = new AbortController();
    void api.status({ signal: controller.signal })
      .then(setLiveStatus)
      .catch(() => {
        if (!controller.signal.aborted) {
          setLiveStatus((current) => ({ ...current, database: 'unavailable' }));
        }
      });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const timer = window.setTimeout(() => setCopyState('idle'), 2_400);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copyCommand() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable');
      await navigator.clipboard.writeText(liveStatus.mcp.command);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return (
    <Modal
      description="The dashboard and your agents read and write the same local knowledge."
      onClose={onClose}
      title="Local connection"
    >
      <div className="status-dialog">
        <div className="status-line">
          <span className={`status-line__mark${liveStatus.database === 'connected' ? ' status-line__mark--ready' : ''}`}>
            <Icon name={liveStatus.database === 'connected' ? 'check' : 'warning'} size={15} />
          </span>
          <span>
            <strong>PostgreSQL</strong>
            <small>{liveStatus.database === 'connected' ? 'Connected to this dashboard' : 'Connection unavailable'}</small>
          </span>
          <span className={`status-pill${liveStatus.database === 'connected' ? '' : ' status-pill--muted'}`}>
            {liveStatus.database === 'connected' ? 'Connected' : 'Unavailable'}
          </span>
        </div>
        <div className="status-line">
          <span className="status-line__mark"><Icon name="spark" size={15} /></span>
          <span><strong>MCP</strong><small>Available when a local agent launches it</small></span>
          <span className="status-pill status-pill--available">Available</span>
        </div>
        <div className="status-line">
          <span className="status-line__mark"><Icon name="search" size={15} /></span>
          <span><strong>Passage search</strong><small>Open-source embeddings and vector retrieval</small></span>
          <span className={`status-pill${liveStatus.rag.enabled ? ' status-pill--available' : ' status-pill--muted'}`}>
            {liveStatus.rag.enabled ? 'Enabled' : 'Not configured'}
          </span>
        </div>
        <section className="mcp-command" aria-labelledby="mcp-command-heading">
          <p id="mcp-command-heading">Agent command</p>
          <div className="mcp-command__value">
            <code>{liveStatus.mcp.command}</code>
            <button className="button button--quiet button--small" onClick={() => void copyCommand()} type="button">
              {copyState === 'copied' ? <Icon name="check" size={14} /> : null}
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <small>MCP is available, not a persistent connection. Your agent starts this command when it needs HorizonLayer.</small>
          <span className="sr-only" role="status" aria-live="polite">
            {copyState === 'copied' ? 'Agent command copied.' : copyState === 'error' ? 'Agent command could not be copied.' : ''}
          </span>
          {copyState === 'error' ? <p className="mcp-command__error">Clipboard unavailable. Select the command to copy it.</p> : null}
        </section>
        <footer className="status-dialog__footer">
          <span>HorizonLayer {liveStatus.version}</span>
          <span>Loopback only</span>
        </footer>
      </div>
    </Modal>
  );
}
