export interface Account { login: string; id: number }
export interface Owner { login: string; kind: 'personal' | 'organization' | 'collaborator' }
export interface Repository { fullName: string; private: boolean; writable: boolean; defaultBranch: string }
export interface AutoSync { enabled: boolean; intervalMinutes: number; branch: string; account: string; lastSyncAt?: number; error?: ErrorCode }
export type Encryption = { mode: 'git-crypt'; keySource: 'gpg'; binaryPath?: string } | { mode: 'git-crypt'; keySource: 'file'; keyFile: string; binaryPath?: string }
export interface Project { fullName: string; path: string; workspaceId: string; account: string; autoSync?: AutoSync; encryption?: Encryption }
export interface ToolsState { status: 'checking' | 'downloading' | 'verifying' | 'ready' | 'failed'; source?: 'system' | 'managed'; progress?: number; error?: ErrorCode }
export type TaskPhase = 'checking' | 'cloning' | 'receiving' | 'resolving' | 'unlocking' | 'registering' | 'checkingRemote' | 'committing' | 'pushing' | 'complete'
export interface Task {
  id: string; fullName: string; kind: 'open' | 'sync'; status: 'running' | 'cancelling' | 'cancelled' | 'complete' | 'failed';
  phase: TaskPhase; startedAt: number; finishedAt?: number; progress?: number; error?: ErrorCode
}
export interface Activity { tasks: Task[]; projects: Project[]; login: Login | null; tools: ToolsState }
export interface Change { path: string; paths: string[]; status: string; blocked: boolean }
export interface ProjectStatus {
  project: Project; head: string; branch: string; ahead: number; behind: number;
  changes: Change[]; conflicted: boolean; remoteKnown: boolean
}
export interface Login { status: 'pending' | 'complete' | 'failed'; code?: string }
export interface State { account: Account | null; ghReady: boolean; gitReady: boolean; projects: Project[]; login: Login | null; tools: ToolsState }
export interface Preview { id: string; fullName: string; head: string; tree: string; paths: string[]; diff: string; message: string; expiresAt: number }
export const errorCodes = ['ghMissing', 'gitMissing', 'signIn', 'commandFailed', 'busy', 'stopped', 'invalidRequest', 'unknownProject', 'unsafeDirectory', 'wrongRemote', 'dirty', 'conflict', 'stalePreview', 'sensitiveFile', 'tooLarge', 'nothingToSave', 'pushFailed', 'pullFailed', 'indexRefresh', 'projectCommitFlow', 'projectPushFlow', 'branchChanged', 'accountChanged', 'remoteChanged', 'stagedChanges', 'autoDisabled', 'tooManyChanges', 'readOnly', 'toolDownload', 'toolIntegrity', 'toolUnsupported', 'cryptMissing', 'encryptionRequired', 'encryptionKey', 'encryptionUnlock', 'encryptionUnsafe', 'encryptionAuditLimit'] as const
export type ErrorCode = typeof errorCodes[number]
export class WorkspaceError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'WorkspaceError' }
}
export interface Remote {
  state(): Promise<State>; initialize(): Promise<ToolsState>; beginLogin(): Promise<Login>; cancelLogin(): Promise<void>;
  configureEncryption(fullName: string, encryption: Encryption | null): Promise<Project>;
  encryption(fullName: string): Promise<Encryption | null>;
  owners(): Promise<Owner[]>; repositories(page: number, owner?: Owner): Promise<Repository[]>; open(fullName: string): Promise<Project>;
  startOpen(fullName: string): Promise<Task>; activity(): Promise<Activity>; cancelTask(id: string): Promise<Task>;
  configureSync(fullName: string, enabled: boolean, intervalMinutes: number): Promise<Project>; startSync(fullName: string): Promise<Task>;
  status(fullName: string): Promise<ProjectStatus>; fetch(fullName: string): Promise<ProjectStatus>;
  pull(fullName: string): Promise<ProjectStatus>; preview(fullName: string, paths: string[]): Promise<Preview>;
  commit(id: string, message: string): Promise<ProjectStatus>; push(fullName: string, head: string): Promise<ProjectStatus>
}
