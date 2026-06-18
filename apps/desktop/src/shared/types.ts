export interface Workspace {
  id: string;
  name: string;
  description?: string | null;
  created_at?: string;
}

export interface Session {
  id: string;
  workspace_id: string;
  title: string;
  status: 'active' | 'closed';
  summary?: string | null;
  last_activity_at?: string;
}

export interface MemoryPage {
  id: string;
  workspace_id?: string | null;
  session_id?: string | null;
  title: string;
  tags?: string[];
  updated_at?: string;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  priority: number;
  owner_agent_name?: string | null;
  lease_owner_agent_name?: string | null;
  last_event_at?: string;
}

export interface AgentRun {
  id: string;
  agent_name: string;
  status: string;
  title?: string | null;
  latest_checkpoint_sequence?: number;
  latest_checkpoint_at?: string | null;
  started_at?: string;
}

export interface DashboardPayload {
  pages: MemoryPage[];
  runs: AgentRun[];
  sessions: Session[];
  tasks: Task[];
  workspace: Workspace | null;
}

export interface DesktopSettings {
  apiBaseUrl: string;
  externalServerUrl: string;
  localApiPort: number;
  localMcpPort: number;
  mode: 'managed' | 'external';
  serverCommand: string;
}

export interface ServerStatus {
  apiBaseUrl: string;
  detail?: string;
  mode: DesktopSettings['mode'];
  running: boolean;
}
