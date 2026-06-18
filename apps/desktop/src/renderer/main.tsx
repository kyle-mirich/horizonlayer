import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  Check,
  Database,
  ListTodo,
  NotebookPen,
  Play,
  Plus,
  RotateCw,
  Search,
  Settings,
  Square,
  Workflow,
} from 'lucide-react';
import { HorizonApiClient } from '../shared/apiClient.js';
import type {
  AgentRun,
  DashboardPayload,
  DesktopSettings,
  MemoryPage,
  ServerStatus,
  Task,
  Workspace,
} from '../shared/types.js';
import './styles.css';

type Section = 'dashboard' | 'memory' | 'tasks' | 'runs' | 'settings';

const fallbackSettings: DesktopSettings = {
  apiBaseUrl: 'http://127.0.0.1:3737',
  externalServerUrl: 'http://127.0.0.1:3737',
  localApiPort: 3737,
  localMcpPort: 3738,
  mode: 'managed',
  serverCommand: 'node ../../dist/launcher.js',
};

function formatTime(value?: string | null): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(value));
}

function useHorizonClient(settings: DesktopSettings): HorizonApiClient {
  return React.useMemo(() => new HorizonApiClient({
    baseUrl: settings.apiBaseUrl,
    bridge: window.horizon,
  }), [settings.apiBaseUrl]);
}

function App(): React.ReactElement {
  const [section, setSection] = React.useState<Section>('dashboard');
  const [settings, setSettings] = React.useState<DesktopSettings>(fallbackSettings);
  const [status, setStatus] = React.useState<ServerStatus>({
    apiBaseUrl: fallbackSettings.apiBaseUrl,
    mode: 'managed',
    running: false,
  });
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = React.useState('');
  const [dashboard, setDashboard] = React.useState<DashboardPayload | null>(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const client = useHorizonClient(settings);

  const loadSettings = React.useCallback(async () => {
    if (!window.horizon) return;
    const nextSettings = await window.horizon.getSettings();
    setSettings(nextSettings);
    setStatus(await window.horizon.serverStatus());
  }, []);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const loadedWorkspaces = await client.get<Workspace[]>('/api/workspaces');
      setWorkspaces(loadedWorkspaces);
      const selected = workspaceId || loadedWorkspaces[0]?.id || '';
      if (selected) {
        setWorkspaceId(selected);
        setDashboard(await client.get<DashboardPayload>(`/api/dashboard?workspace_id=${encodeURIComponent(selected)}`));
      } else {
        setDashboard(null);
      }
      if (window.horizon) {
        setStatus(await window.horizon.serverStatus());
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to refresh HorizonLayer');
    } finally {
      setBusy(false);
    }
  }, [client, workspaceId]);

  React.useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startServer(): Promise<void> {
    if (!window.horizon) return;
    setStatus(await window.horizon.startServer());
    setTimeout(() => void refresh(), 900);
  }

  async function stopServer(): Promise<void> {
    if (!window.horizon) return;
    setStatus(await window.horizon.stopServer());
  }

  async function saveSettings(nextSettings: DesktopSettings): Promise<void> {
    const normalized = window.horizon ? await window.horizon.saveSettings(nextSettings) : nextSettings;
    setSettings(normalized);
    setStatus(window.horizon ? await window.horizon.serverStatus() : {
      apiBaseUrl: normalized.apiBaseUrl,
      mode: normalized.mode,
      running: normalized.mode === 'external',
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Database size={18} /></div>
          <div>
            <strong>HorizonLayer</strong>
            <span>{status.running ? 'Online' : 'Offline'}</span>
          </div>
        </div>
        <nav className="nav-list">
          <NavButton active={section === 'dashboard'} icon={<Activity size={17} />} label="Dashboard" onClick={() => setSection('dashboard')} />
          <NavButton active={section === 'memory'} icon={<NotebookPen size={17} />} label="Memory" onClick={() => setSection('memory')} />
          <NavButton active={section === 'tasks'} icon={<ListTodo size={17} />} label="Tasks" onClick={() => setSection('tasks')} />
          <NavButton active={section === 'runs'} icon={<Workflow size={17} />} label="Runs" onClick={() => setSection('runs')} />
          <NavButton active={section === 'settings'} icon={<Settings size={17} />} label="Settings" onClick={() => setSection('settings')} />
        </nav>
        <div className="sidebar-footer">
          <button className="ghost-button" onClick={refresh} type="button"><RotateCw size={15} />Refresh</button>
          {status.running ? (
            <button className="ghost-button" onClick={stopServer} type="button"><Square size={14} />Stop</button>
          ) : (
            <button className="primary-button" onClick={startServer} type="button"><Play size={15} />Start</button>
          )}
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <h1>{section[0].toUpperCase() + section.slice(1)}</h1>
            <p>{status.apiBaseUrl}</p>
          </div>
          <div className="topbar-controls">
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              <option value="">No workspace</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
              ))}
            </select>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}
        {busy ? <div className="loading-line" /> : null}

        {section === 'dashboard' && (
          <DashboardView dashboard={dashboard} onRefresh={refresh} />
        )}
        {section === 'memory' && (
          <MemoryView client={client} dashboard={dashboard} onRefresh={refresh} workspaceId={workspaceId} />
        )}
        {section === 'tasks' && (
          <TasksView client={client} dashboard={dashboard} onRefresh={refresh} workspaceId={workspaceId} />
        )}
        {section === 'runs' && (
          <RunsView client={client} dashboard={dashboard} onRefresh={refresh} workspaceId={workspaceId} />
        )}
        {section === 'settings' && (
          <SettingsView
            onSave={saveSettings}
            settings={settings}
            status={status}
          />
        )}
      </main>
    </div>
  );
}

function NavButton(props: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button className={`nav-button ${props.active ? 'active' : ''}`} onClick={props.onClick} type="button">
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function DashboardView({ dashboard, onRefresh }: {
  dashboard: DashboardPayload | null;
  onRefresh: () => Promise<void>;
}): React.ReactElement {
  const openTasks = dashboard?.tasks.filter((task) => !['done', 'failed', 'cancelled'].includes(task.status)).length ?? 0;
  const runningRuns = dashboard?.runs.filter((run) => run.status === 'running').length ?? 0;
  return (
    <div className="content-stack">
      <section className="metric-grid">
        <Metric label="Sessions" value={dashboard?.sessions.length ?? 0} />
        <Metric label="Memories" value={dashboard?.pages.length ?? 0} />
        <Metric label="Open Tasks" value={openTasks} />
        <Metric label="Running Runs" value={runningRuns} />
      </section>
      <section className="split-grid">
        <DataPanel title="Recent Sessions">
          <SimpleRows rows={(dashboard?.sessions ?? []).map((session) => ({
            id: session.id,
            meta: formatTime(session.last_activity_at),
            status: session.status,
            title: session.title,
          }))} />
        </DataPanel>
        <DataPanel title="Open Tasks">
          <TaskRows tasks={dashboard?.tasks.slice(0, 8) ?? []} />
        </DataPanel>
      </section>
      <section className="split-grid">
        <DataPanel title="Recent Memory">
          <SimpleRows rows={(dashboard?.pages ?? []).map((page) => ({
            id: page.id,
            meta: formatTime(page.updated_at),
            status: page.tags?.join(', ') || 'memory',
            title: page.title,
          }))} />
        </DataPanel>
        <DataPanel title="Runs">
          <RunRows runs={dashboard?.runs.slice(0, 8) ?? []} />
        </DataPanel>
      </section>
      <div className="right-actions">
        <button className="ghost-button" onClick={onRefresh} type="button"><RotateCw size={15} />Refresh</button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DataPanel({ children, title }: { children: React.ReactNode; title: string }): React.ReactElement {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function SimpleRows({ rows }: { rows: Array<{ id: string; meta: string; status: string; title: string }> }): React.ReactElement {
  if (rows.length === 0) return <div className="empty-state">Empty</div>;
  return (
    <div className="rows">
      {rows.map((row) => (
        <div className="row" key={row.id}>
          <div>
            <strong>{row.title}</strong>
            <span>{row.meta}</span>
          </div>
          <small>{row.status}</small>
        </div>
      ))}
    </div>
  );
}

function TaskRows({ tasks }: { tasks: Task[] }): React.ReactElement {
  if (tasks.length === 0) return <div className="empty-state">Empty</div>;
  return (
    <div className="rows">
      {tasks.map((task) => (
        <div className="row" key={task.id}>
          <div>
            <strong>{task.title}</strong>
            <span>{task.owner_agent_name || task.lease_owner_agent_name || 'unassigned'}</span>
          </div>
          <small className={`status-chip ${task.status}`}>{task.status}</small>
        </div>
      ))}
    </div>
  );
}

function RunRows({ runs }: { runs: AgentRun[] }): React.ReactElement {
  if (runs.length === 0) return <div className="empty-state">Empty</div>;
  return (
    <div className="rows">
      {runs.map((run) => (
        <div className="row" key={run.id}>
          <div>
            <strong>{run.title || run.agent_name}</strong>
            <span>{formatTime(run.latest_checkpoint_at || run.started_at)}</span>
          </div>
          <small className={`status-chip ${run.status}`}>{run.status}</small>
        </div>
      ))}
    </div>
  );
}

function MemoryView({ client, dashboard, onRefresh, workspaceId }: {
  client: HorizonApiClient;
  dashboard: DashboardPayload | null;
  onRefresh: () => Promise<void>;
  workspaceId: string;
}): React.ReactElement {
  const [title, setTitle] = React.useState('');
  const [content, setContent] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<MemoryPage[]>([]);

  async function addMemory(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await client.post('/api/memory', {
      content,
      title: title || undefined,
      workspace_id: workspaceId,
    });
    setTitle('');
    setContent('');
    await onRefresh();
  }

  async function searchMemory(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const found = await client.get<MemoryPage[]>(`/api/memory?workspace_id=${workspaceId}&query=${encodeURIComponent(query)}`);
    setResults(found);
  }

  return (
    <div className="feature-grid">
      <DataPanel title="Add Memory">
        <form className="form-stack" onSubmit={addMemory}>
          <input onChange={(event) => setTitle(event.target.value)} placeholder="Title" value={title} />
          <textarea onChange={(event) => setContent(event.target.value)} placeholder="Content" rows={8} value={content} />
          <button className="primary-button" disabled={!workspaceId || !content} type="submit"><Plus size={15} />Add</button>
        </form>
      </DataPanel>
      <DataPanel title="Search Memory">
        <form className="inline-form" onSubmit={searchMemory}>
          <input onChange={(event) => setQuery(event.target.value)} placeholder="Search" value={query} />
          <button className="ghost-button" disabled={!workspaceId || !query} type="submit"><Search size={15} />Search</button>
        </form>
        <SimpleRows rows={(results.length ? results : dashboard?.pages ?? []).map((page) => ({
          id: page.id,
          meta: formatTime(page.updated_at),
          status: page.tags?.join(', ') || 'memory',
          title: page.title,
        }))} />
      </DataPanel>
    </div>
  );
}

function TasksView({ client, dashboard, onRefresh, workspaceId }: {
  client: HorizonApiClient;
  dashboard: DashboardPayload | null;
  onRefresh: () => Promise<void>;
  workspaceId: string;
}): React.ReactElement {
  const [title, setTitle] = React.useState('');
  const [agent, setAgent] = React.useState('codex');
  async function create(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await client.post('/api/tasks', {
      created_by_agent_name: agent,
      owner_agent_name: agent,
      priority: 10,
      title,
      workspace_id: workspaceId,
    });
    setTitle('');
    await onRefresh();
  }
  async function claim(task: Task): Promise<void> {
    await client.post(`/api/tasks/${task.id}/claim`, { agent_name: agent, workspace_id: workspaceId });
    await onRefresh();
  }
  async function complete(task: Task): Promise<void> {
    await client.post(`/api/tasks/${task.id}/complete`, { agent_name: agent });
    await onRefresh();
  }
  return (
    <div className="feature-grid">
      <DataPanel title="Create Task">
        <form className="form-stack" onSubmit={create}>
          <input onChange={(event) => setTitle(event.target.value)} placeholder="Task title" value={title} />
          <input onChange={(event) => setAgent(event.target.value)} placeholder="Agent" value={agent} />
          <button className="primary-button" disabled={!workspaceId || !title} type="submit"><Plus size={15} />Create</button>
        </form>
      </DataPanel>
      <DataPanel title="Task Queue">
        <div className="rows">
          {(dashboard?.tasks ?? []).map((task) => (
            <div className="action-row" key={task.id}>
              <div>
                <strong>{task.title}</strong>
                <span>{task.status} - priority {task.priority}</span>
              </div>
              <div>
                <button className="icon-button" onClick={() => void claim(task)} title="Claim" type="button"><Play size={14} /></button>
                <button className="icon-button" onClick={() => void complete(task)} title="Complete" type="button"><Check size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      </DataPanel>
    </div>
  );
}

function RunsView({ client, dashboard, onRefresh, workspaceId }: {
  client: HorizonApiClient;
  dashboard: DashboardPayload | null;
  onRefresh: () => Promise<void>;
  workspaceId: string;
}): React.ReactElement {
  const [title, setTitle] = React.useState('');
  const [agent, setAgent] = React.useState('codex');
  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    await client.post('/api/runs', {
      agent_name: agent,
      title,
      workspace_id: workspaceId,
    });
    setTitle('');
    await onRefresh();
  }
  async function checkpoint(run: AgentRun): Promise<void> {
    await client.post(`/api/runs/${run.id}/checkpoints`, {
      agent_name: run.agent_name,
      summary: `Manual checkpoint ${new Date().toISOString()}`,
    });
    await onRefresh();
  }
  async function complete(run: AgentRun): Promise<void> {
    await client.post(`/api/runs/${run.id}/complete`, { agent_name: run.agent_name, result: { status: 'ok' } });
    await onRefresh();
  }
  return (
    <div className="feature-grid">
      <DataPanel title="Start Run">
        <form className="form-stack" onSubmit={start}>
          <input onChange={(event) => setTitle(event.target.value)} placeholder="Run title" value={title} />
          <input onChange={(event) => setAgent(event.target.value)} placeholder="Agent" value={agent} />
          <button className="primary-button" disabled={!workspaceId || !agent} type="submit"><Play size={15} />Start</button>
        </form>
      </DataPanel>
      <DataPanel title="Run History">
        <div className="rows">
          {(dashboard?.runs ?? []).map((run) => (
            <div className="action-row" key={run.id}>
              <div>
                <strong>{run.title || run.agent_name}</strong>
                <span>{run.status} - {run.latest_checkpoint_sequence ?? 0} checkpoints</span>
              </div>
              <div>
                <button className="icon-button" onClick={() => void checkpoint(run)} title="Checkpoint" type="button"><Plus size={14} /></button>
                <button className="icon-button" onClick={() => void complete(run)} title="Complete" type="button"><Check size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      </DataPanel>
    </div>
  );
}

function SettingsView({ onSave, settings, status }: {
  onSave: (settings: DesktopSettings) => Promise<void>;
  settings: DesktopSettings;
  status: ServerStatus;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(settings);
  React.useEffect(() => setDraft(settings), [settings]);
  return (
    <div className="settings-grid">
      <DataPanel title="Connection">
        <form className="form-stack" onSubmit={(event) => {
          event.preventDefault();
          void onSave(draft);
        }}>
          <label>
            Mode
            <select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as DesktopSettings['mode'] })}>
              <option value="managed">Managed local</option>
              <option value="external">External API</option>
            </select>
          </label>
          <label>
            External URL
            <input onChange={(event) => setDraft({ ...draft, externalServerUrl: event.target.value })} value={draft.externalServerUrl} />
          </label>
          <label>
            Local API Port
            <input onChange={(event) => setDraft({ ...draft, localApiPort: Number(event.target.value) })} type="number" value={draft.localApiPort} />
          </label>
          <label>
            MCP Port
            <input onChange={(event) => setDraft({ ...draft, localMcpPort: Number(event.target.value) })} type="number" value={draft.localMcpPort} />
          </label>
          <label>
            Server Command
            <input onChange={(event) => setDraft({ ...draft, serverCommand: event.target.value })} value={draft.serverCommand} />
          </label>
          <button className="primary-button" type="submit"><Check size={15} />Save</button>
        </form>
      </DataPanel>
      <DataPanel title="Status">
        <div className="status-card">
          <strong>{status.running ? 'Online' : 'Offline'}</strong>
          <span>{status.mode}</span>
          <code>{status.apiBaseUrl}</code>
          {status.detail ? <p>{status.detail}</p> : null}
        </div>
      </DataPanel>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
