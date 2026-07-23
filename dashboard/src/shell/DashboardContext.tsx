import { createContext, useContext } from 'react';

import type { DashboardApiClient } from '../api';
import type { Workspace } from '../types';
import type { DashboardRouteTarget } from './routing';

export type ToastTone = 'default' | 'error';

export interface DashboardViewContextValue {
  api: DashboardApiClient;
  navigate(route: DashboardRouteTarget): void;
  refreshWorkspaceData(): Promise<void>;
  showToast(message: string, options?: { tone?: ToastTone }): void;
  workspace: Workspace;
}

export const DashboardViewContext = createContext<DashboardViewContextValue | null>(null);

export function useDashboard(): DashboardViewContextValue {
  const value = useContext(DashboardViewContext);
  if (!value) throw new Error('useDashboard must be used inside the HorizonLayer dashboard');
  return value;
}
