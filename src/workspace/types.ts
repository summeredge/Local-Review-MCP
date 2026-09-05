export interface WorkspaceIdentity {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export type WorkspaceRegistryEntry = WorkspaceIdentity;

export interface WorkspaceSummary {
  readonly id: string;
  readonly name: string;
}
