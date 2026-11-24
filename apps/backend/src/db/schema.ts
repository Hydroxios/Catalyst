import type { ProjectConfig } from '../config/projects.js';

export type DeploymentStatus =
  | 'queued'
  | 'fetching'
  | 'building'
  | 'starting'
  | 'healthchecking'
  | 'live'
  | 'failed'
  | 'cancelled'
  | 'superseded'
  | 'rolled_back';

export type DeploymentTrigger = 'webhook' | 'poll' | 'manual' | 'rollback';

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type CancelReason = 'superseded' | 'cancelled';

export const TERMINAL_STATUSES: readonly DeploymentStatus[] = [
  'live',
  'failed',
  'cancelled',
  'superseded',
  'rolled_back',
];

export interface ProjectRow {
  id: number;
  slug: string;
  repo: string;
  branch: string;
  config: ProjectConfig;
  enabled: boolean;
  paused: boolean;
  /** Site arrêté volontairement (conteneur stoppé, pas de relance ni d'auto-déploiement). */
  stopped: boolean;
  managed_by: 'file' | 'ui';
  last_seen_sha: string | null;
  github_etag: string | null;
  current_deployment_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeploymentRow {
  id: number;
  project_id: number;
  sha: string;
  commit_message: string | null;
  commit_author: string | null;
  trigger: DeploymentTrigger;
  status: DeploymentStatus;
  image_tag: string | null;
  container_name: string | null;
  error: string | null;
  queued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  went_live_at: Date | null;
}

export interface JobRow {
  id: number;
  deployment_id: number;
  project_id: number;
  state: JobState;
  attempts: number;
  cancel_requested: CancelReason | null;
  locked_at: Date | null;
  created_at: Date;
}

export interface BuildLogRow {
  id: string; // BIGSERIAL → string avec pg
  deployment_id: number;
  ts: Date;
  stream: 'system' | 'stdout' | 'stderr';
  line: string;
}
