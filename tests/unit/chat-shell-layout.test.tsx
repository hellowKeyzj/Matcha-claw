import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ChatShell } from '@/pages/Chat/components/ChatShell';
import { ChatSidePanel } from '@/pages/Chat/components/ChatSidePanel';
import type { ArtifactPreviewTarget } from '@/components/file-preview/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'taskInbox.unfinishedCount') {
        return `count:${String(options?.count ?? 0)}`;
      }
      if (key === 'taskInbox.shortTitle') {
        return '任务';
      }
      if (key === 'taskInbox.planStatus.building') {
        return '执行中';
      }
      if (key === 'toolbar.skillShortLabel') {
        return '技能';
      }
      if (key === 'artifacts.sectionLabel') {
        return '产物';
      }
      return key;
    },
  }),
}));

const openTaskSessionMock = vi.fn(() => 'agent:main:main');
let taskRows: Array<{
  id: string;
  subject?: string;
  status: string;
  metadata?: Record<string, unknown>;
}> = [];

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: {
    currentSessionKey: string;
    openTaskSession: (sessionKey: string) => string;
  }) => unknown) => selector({
    currentSessionKey: 'agent:main:main',
    openTaskSession: openTaskSessionMock,
  }),
}));

vi.mock('@/stores/chat/task-snapshot-store', () => ({
  useTaskSnapshotStore: (selector: (state: {
    getPersistentTaskDataList: () => Array<{
      id: string;
      subject?: string;
      status: string;
      metadata?: Record<string, unknown>;
    }>;
  }) => unknown) => selector({
    getPersistentTaskDataList: () => taskRows,
  }),
}));

vi.mock('@/stores/task-center-store', () => ({
  useTaskCenterStore: (selector: (state: {
    initialLoading: boolean;
    refreshing: boolean;
    initialized: boolean;
    error: string | null;
    clearError: () => void;
    refreshTasks: () => Promise<void>;
  }) => unknown) => selector({
    initialLoading: false,
    refreshing: false,
    initialized: true,
    error: null,
    clearError: vi.fn(),
    refreshTasks: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: { status: { processState: string; gatewayReady: boolean; healthSummary: string; transportState: string; portReachable: boolean; diagnostics: { consecutiveHeartbeatMisses: number; consecutiveRpcFailures: number }; updatedAt: number } }) => unknown) => selector({
    status: {
      processState: 'running',
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

const mockShowItemInFolder = vi.fn().mockResolvedValue({ success: true });

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => mockShowItemInFolder(...args),
}));

vi.mock('@/components/file-preview/FilePreviewBody', () => ({
  FilePreviewBody: ({
    file,
    mode,
    headerAccessory,
    headerTrailingAccessory,
  }: {
    file: ArtifactPreviewTarget;
    mode: string;
    headerAccessory?: React.ReactNode;
    headerTrailingAccessory?: React.ReactNode;
  }) => (
    <div data-testid="artifact-preview-body">
      <span>{file.fileName}</span>
      <span>{mode}</span>
      <div>{headerAccessory}</div>
      <div>{headerTrailingAccessory}</div>
    </div>
  ),
}));

vi.mock('@/components/file-preview/WorkspaceBrowserBody', () => ({
  WorkspaceBrowserBody: ({
    selectedFilePath,
    onSelectFile,
  }: {
    selectedFilePath: string | null;
    onSelectFile: (file: ArtifactPreviewTarget) => void;
  }) => (
    <div data-testid="workspace-browser-body">
      <span>{selectedFilePath ?? 'none'}</span>
      <button
        type="button"
        onClick={() => onSelectFile({
          filePath: '/workspace/notes.md',
          fileName: 'notes.md',
          ext: '.md',
          mimeType: 'text/markdown',
          contentType: 'markdown',
        })}
      >
        select-workspace-file
      </button>
    </div>
  ),
}));

describe('chat shell task panel layout', () => {
  beforeEach(() => {
    mockShowItemInFolder.mockClear();
    openTaskSessionMock.mockClear();
    taskRows = [];
  });

  const skillConfigProps = {
    artifactWorkbenchFullscreen: false,
    skillConfigLabel: '技能配置',
    skillConfigTitle: 'skill-config · main',
    skillOptions: [
      { id: 'skill-a', name: 'Skill A', icon: 'A' },
      { id: 'skill-b', name: 'Skill B', icon: 'B' },
    ],
    skillsLoading: false,
    selectedSkillIds: ['skill-a'],
    onToggleSkill: vi.fn(),
    skillPreview: null,
    onClearSkillPreview: vi.fn(),
    onToggleArtifactWorkbenchFullscreen: vi.fn(),
    derivedPlanStatus: null,
    artifactGroups: [],
    artifactFocusedGroupFiles: [],
    artifactFocusedFile: null,
    artifactActiveSection: 'workspace' as const,
    artifactViewMode: 'preview' as const,
    artifactWorkspaceRoot: null,
    onArtifactFocusFile: vi.fn(),
    onOpenGeneratedArtifactFile: vi.fn(),
    onOpenArtifactGroup: vi.fn(),
    onArtifactSectionChange: vi.fn(),
    onArtifactViewModeChange: vi.fn(),
    onArtifactRevealInFileManager: vi.fn(),
  };

  it('uses a single-column stage when the chat side panel is closed', () => {
    const { container } = render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen={false}
        sidePanelMode="hidden"
        sidePanelWidth={0}
        artifactWorkbenchFullscreen={false}
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain('[grid-template-columns:minmax(0,1fr)]');
    expect(shell?.className).not.toContain('_52px]');
    expect(screen.queryByTestId('chat-side-panel')).toBeNull();
    expect(screen.getByTestId('chat-stage-header-overlay').firstElementChild?.className).toContain('pointer-events-none');
    expect(screen.getByTestId('chat-header').parentElement?.className).toContain('pointer-events-auto');
  });

  it('adds a right panel column only when the chat side panel is docked open', () => {
    const { container } = render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen
        sidePanelMode="docked"
        sidePanelWidth={360}
        artifactWorkbenchFullscreen={false}
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" data-mode="docked" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain('[grid-template-columns:minmax(0,1fr)_var(--chat-side-panel-resizer-width)_var(--chat-side-panel-width)]');
    expect(shell?.style.getPropertyValue('--chat-side-panel-resizer-width')).toBe('6px');
    expect(screen.getByTestId('chat-side-panel')).toHaveAttribute('data-mode', 'docked');
    expect(screen.getByTestId('chat-side-panel-resizer')).toBeInTheDocument();
  });

  it('renders the chat side panel as an overlay when requested', () => {
    render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen
        sidePanelMode="overlay"
        sidePanelWidth={320}
        artifactWorkbenchFullscreen={false}
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" data-mode="overlay" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    expect(screen.getByTestId('chat-side-panel-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('chat-side-panel')).toHaveAttribute('data-mode', 'overlay');
    expect(screen.queryByTestId('chat-side-panel-resizer')).toBeNull();
  });

  it('renders task and skill tabs inside one shared side panel shell', () => {
    const onTabChange = vi.fn();
    render(
      <ChatSidePanel
        mode="docked"
        width={520}
        activeTab="tasks"
        onTabChange={onTabChange}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(screen.getByRole('tab', { name: 'taskInbox.title' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '技能配置' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'artifacts.title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'taskInbox.collapse' })).toBeInTheDocument();
    expect(screen.queryByTitle('taskInbox.expand')).toBeNull();
    expect(screen.getByTestId('chat-side-panel').className).toContain('border-l');
    expect(screen.queryByText(/workspace/i)).toBeNull();
    expect(screen.queryByText(/mr\.key/i)).toBeNull();
    expect(within(screen.getByTestId('chat-side-panel-tab-tasks')).getByText('任务')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-side-panel-tab-skills')).getByText('技能')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-side-panel-tab-artifacts')).getByText('产物')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '技能配置' }));
    expect(onTabChange).toHaveBeenCalledWith('skills');
  });

  it('renders the task refresh action inside the task panel header instead of the top bar', () => {
    render(
      <ChatSidePanel
        mode="docked"
        width={520}
        activeTab="tasks"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    const taskPanel = screen.getByRole('tabpanel');
    expect(within(taskPanel).getByRole('button', { name: 'taskInbox.refresh' })).toBeInTheDocument();
  });

  it('renders only persistent task rows and opens the task execution session', () => {
    taskRows = [{
      id: 'task-1',
      subject: '执行任务',
      status: 'in_progress',
      metadata: { sessionKey: 'agent:worker:session-1' },
    }];

    render(
      <ChatSidePanel
        mode="docked"
        width={520}
        activeTab="tasks"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={1}
        {...skillConfigProps}
      />,
    );

    const taskPanel = screen.getByRole('tabpanel');
    expect(within(taskPanel).getByText('执行任务')).toBeInTheDocument();
    expect(within(taskPanel).queryByText('分析页面结构')).toBeNull();

    fireEvent.click(within(taskPanel).getByRole('button', { name: /执行任务/ }));

    expect(openTaskSessionMock).toHaveBeenCalledWith('agent:worker:session-1');
  });

  it('renders derived plan status from the task snapshot pipeline', () => {
    render(
      <ChatSidePanel
        mode="docked"
        width={520}
        activeTab="tasks"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        derivedPlanStatus="building"
      />,
    );

    const taskPanel = screen.getByRole('tabpanel');
    expect(within(taskPanel).getByText('执行中')).toBeInTheDocument();
  });

  it('switches the top tab strip to icon-only mode when per-tab space is not enough for labels', () => {
    render(
      <ChatSidePanel
        mode="docked"
        width={220}
        activeTab="tasks"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    const tasksTab = screen.getByTestId('chat-side-panel-tab-tasks');
    const skillsTab = screen.getByTestId('chat-side-panel-tab-skills');
    const artifactsTab = screen.getByTestId('chat-side-panel-tab-artifacts');

    expect(tasksTab).toHaveAttribute('title', 'taskInbox.title');
    expect(skillsTab).toHaveAttribute('title', '技能配置');
    expect(artifactsTab).toHaveAttribute('title', 'artifacts.title');
    expect(within(tasksTab).queryByText('任务')).toBeNull();
    expect(within(skillsTab).queryByText('技能')).toBeNull();
    expect(within(artifactsTab).queryByText('产物')).toBeNull();
  });

  it('keeps top tab labels visible at medium side panel widths', () => {
    render(
      <ChatSidePanel
        mode="docked"
        width={360}
        activeTab="tasks"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(within(screen.getByTestId('chat-side-panel-tab-tasks')).getByText('任务')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-side-panel-tab-skills')).getByText('技能')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-side-panel-tab-artifacts')).getByText('产物')).toBeInTheDocument();
  });

  it('keeps top tab labels visible when the side panel is wide enough', () => {
    render(
      <ChatSidePanel
        mode="docked"
        width={520}
        activeTab="tasks"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(within(screen.getByTestId('chat-side-panel-tab-tasks')).getByText('任务')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-side-panel-tab-skills')).getByText('技能')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-side-panel-tab-artifacts')).getByText('产物')).toBeInTheDocument();
  });

  it('switches artifact section buttons to icon-only mode when per-tab space is not enough for labels', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={220}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    const changesButton = screen.getByTestId('chat-artifact-section-changes');
    const previewButton = screen.getByTestId('chat-artifact-section-preview');
    const workspaceButton = screen.getByTestId('chat-artifact-section-workspace');

    expect(within(changesButton).queryByText('artifacts.changesTab')).toBeNull();
    expect(within(previewButton).queryByText('artifacts.previewTab')).toBeNull();
    expect(within(workspaceButton).queryByText('artifacts.workspaceTab')).toBeNull();
  });

  it('keeps artifact section labels visible at medium side panel widths', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={360}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(within(screen.getByTestId('chat-artifact-section-changes')).getByText('artifacts.changesTab')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-artifact-section-preview')).getByText('artifacts.previewTab')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-artifact-section-workspace')).getByText('artifacts.workspaceTab')).toBeInTheDocument();
  });

  it('shows artifact section labels when the side panel is wide enough', () => {
    render(
      <ChatSidePanel
        mode="docked"
        width={520}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(within(screen.getByTestId('chat-artifact-section-changes')).getByText('artifacts.changesTab')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-artifact-section-preview')).getByText('artifacts.previewTab')).toBeInTheDocument();
    expect(within(screen.getByTestId('chat-artifact-section-workspace')).getByText('artifacts.workspaceTab')).toBeInTheDocument();
  });

  it('lets the artifact workbench take over the chat shell in fullscreen mode', () => {
    render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen
        sidePanelMode="docked"
        sidePanelWidth={960}
        artifactWorkbenchFullscreen
        isEmptyState={false}
        emptyState={null}
        sidePanel={<div data-testid="chat-side-panel" data-mode="docked" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-input" />}
      />,
    );

    expect(screen.getByTestId('chat-artifact-workbench-fullscreen')).toBeInTheDocument();
    expect(screen.getByTestId('chat-side-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-panel')).toBeNull();
    expect(screen.queryByTestId('chat-side-panel-resizer')).toBeNull();
    expect(screen.queryByTestId('chat-side-panel-overlay')).toBeNull();
  });

  it('renders artifact summaries inside the shared side panel shell', () => {
    const onOpenGeneratedArtifactFile = vi.fn();
    const onOpenArtifactGroup = vi.fn();
    const onArtifactSectionChange = vi.fn();
    const onArtifactViewModeChange = vi.fn();
    const onToggleArtifactWorkbenchFullscreen = vi.fn();
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactWorkbenchFullscreen={false}
        onToggleArtifactWorkbenchFullscreen={onToggleArtifactWorkbenchFullscreen}
        onOpenGeneratedArtifactFile={onOpenGeneratedArtifactFile}
        onOpenArtifactGroup={onOpenArtifactGroup}
        onArtifactSectionChange={onArtifactSectionChange}
        onArtifactViewModeChange={onArtifactViewModeChange}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [{
            filePath: '/workspace/demo.ts',
            fileName: 'demo.ts',
            ext: '.ts',
            mimeType: 'text/typescript',
            contentType: 'code',
            sourceTool: 'edit',
            action: 'modified',
            baseline: 'const value = 1;\n',
            content: 'const value = 2;\n',
            lineStats: { added: 1, removed: 1 },
            toolId: 'edit-1',
          }],
        }]}
        artifactFocusedGroupFiles={[{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }]}
        artifactFocusedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        artifactActiveSection="changes"
        artifactViewMode="diff"
        artifactWorkspaceRoot="/workspace"
        artifactFocusedGroupKey="graph-1"
      />,
    );

    expect(screen.getByRole('tab', { name: 'artifacts.title' })).toBeInTheDocument();
    expect(screen.getAllByText('demo.ts').length).toBeGreaterThan(0);
    expect(screen.queryByText('/workspace/demo.ts')).toBeNull();
    expect(screen.getByText('+1 / -1')).toBeInTheDocument();
    expect(screen.getByTestId('artifact-preview-body')).toHaveTextContent('demo.ts');
    expect(screen.getByTestId('artifact-preview-body')).toHaveTextContent('diff');
    expect(screen.getByTestId('chat-artifact-workbench')).toHaveAttribute('data-layout', 'stacked');
    fireEvent.click(screen.getByTestId('artifact-group-open-graph-1'));
    expect(onOpenArtifactGroup).toHaveBeenCalledWith('graph-1', { preserveSection: 'current' });
    fireEvent.click(screen.getByTestId('chat-artifact-section-preview'));
    expect(onArtifactSectionChange).toHaveBeenCalledWith('preview');
    expect(onArtifactViewModeChange).toHaveBeenCalledWith('preview');
    fireEvent.click(screen.getByTestId('chat-side-panel-artifact-fullscreen-toggle'));
    expect(onToggleArtifactWorkbenchFullscreen).toHaveBeenCalled();
  });

  it('opens artifact groups through group-level actions', () => {
    const onOpenArtifactGroup = vi.fn();
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        onOpenArtifactGroup={onOpenArtifactGroup}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [{
            filePath: '/workspace/demo.ts',
            fileName: 'demo.ts',
            ext: '.ts',
            mimeType: 'text/typescript',
            contentType: 'code',
            sourceTool: 'edit',
            action: 'modified',
            baseline: 'const value = 1;\n',
            content: 'const value = 2;\n',
            lineStats: { added: 1, removed: 1 },
            toolId: 'edit-1',
          }],
        }]}
        artifactFocusedGroupFiles={[{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }]}
        artifactFocusedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        artifactFocusedGroupKey="graph-1"
        artifactActiveSection="preview"
        artifactViewMode="preview"
        artifactWorkspaceRoot="/workspace"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'artifacts.openLatest' }));
    expect(onOpenArtifactGroup).toHaveBeenCalledWith('graph-1', { preserveSection: 'current' });
  });

  it('uses relative artifact navigation without resetting the user section choice', () => {
    const onOpenGeneratedArtifactFile = vi.fn();
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        onOpenGeneratedArtifactFile={onOpenGeneratedArtifactFile}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [
            {
              filePath: '/workspace/demo.ts',
              fileName: 'demo.ts',
              ext: '.ts',
              mimeType: 'text/typescript',
              contentType: 'code',
              sourceTool: 'edit',
              action: 'modified',
              baseline: 'const value = 1;\n',
              content: 'const value = 2;\n',
              lineStats: { added: 1, removed: 1 },
              toolId: 'edit-1',
            },
            {
              filePath: '/tmp/report.pdf',
              fileName: 'report.pdf',
              ext: '.pdf',
              mimeType: 'application/pdf',
              contentType: 'pdf',
              sourceTool: 'write',
              action: 'created',
              baseline: '',
              content: '',
              lineStats: { added: 0, removed: 0 },
              toolId: 'write-1',
            },
          ],
        }]}
        artifactFocusedGroupFiles={[
          {
            filePath: '/workspace/demo.ts',
            fileName: 'demo.ts',
            ext: '.ts',
            mimeType: 'text/typescript',
            contentType: 'code',
            sourceTool: 'edit',
            action: 'modified',
            baseline: 'const value = 1;\n',
            content: 'const value = 2;\n',
            lineStats: { added: 1, removed: 1 },
            toolId: 'edit-1',
          },
          {
            filePath: '/tmp/report.pdf',
            fileName: 'report.pdf',
            ext: '.pdf',
            mimeType: 'application/pdf',
            contentType: 'pdf',
            sourceTool: 'write',
            action: 'created',
            baseline: '',
            content: '',
            lineStats: { added: 0, removed: 0 },
            toolId: 'write-1',
          },
        ]}
        artifactFocusedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        artifactActiveSection="changes"
        artifactViewMode="diff"
        artifactWorkspaceRoot="/workspace"
      />,
    );

    fireEvent.click(screen.getByTestId('artifact-preview-next-file'));
    expect(onOpenGeneratedArtifactFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/tmp/report.pdf',
    }), { preserveSection: 'current' });
  });

  it('scopes artifact prev-next navigation to the current group instead of crossing groups', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactGroups={[
          {
            graphItemKey: 'graph-1',
            files: [{
              filePath: '/workspace/demo.ts',
              fileName: 'demo.ts',
              ext: '.ts',
              mimeType: 'text/typescript',
              contentType: 'code',
              sourceTool: 'edit',
              action: 'modified',
              baseline: 'const value = 1;\n',
              content: 'const value = 2;\n',
              lineStats: { added: 1, removed: 1 },
              toolId: 'edit-1',
            }],
          },
          {
            graphItemKey: 'graph-2',
            files: [{
              filePath: '/tmp/report.pdf',
              fileName: 'report.pdf',
              ext: '.pdf',
              mimeType: 'application/pdf',
              contentType: 'pdf',
              sourceTool: 'write',
              action: 'created',
              baseline: '',
              content: '',
              lineStats: { added: 0, removed: 0 },
              toolId: 'write-1',
            }],
          },
        ]}
        artifactFocusedGroupFiles={[{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }]}
        artifactFocusedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        artifactActiveSection="changes"
        artifactViewMode="diff"
        artifactWorkspaceRoot="/workspace"
      />,
    );

    expect(screen.getByTestId('artifact-preview-next-file')).toBeDisabled();
  });

  it('disables changes when the focused artifact does not support inline diff', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [{
            filePath: '/tmp/report.pdf',
            fileName: 'report.pdf',
            ext: '.pdf',
            mimeType: 'application/pdf',
            contentType: 'pdf',
            sourceTool: 'write',
            action: 'created',
            baseline: '',
            content: '',
            lineStats: { added: 0, removed: 0 },
            toolId: 'write-1',
          }],
        }]}
        artifactFocusedFile={{
          filePath: '/tmp/report.pdf',
          fileName: 'report.pdf',
          ext: '.pdf',
          mimeType: 'application/pdf',
          contentType: 'pdf',
          sourceTool: 'write',
          action: 'created',
          baseline: '',
          content: '',
          lineStats: { added: 0, removed: 0 },
          toolId: 'write-1',
        }}
        artifactActiveSection="preview"
        artifactViewMode="preview"
        artifactWorkspaceRoot="/workspace"
      />,
    );

    expect(screen.getByTestId('chat-artifact-section-changes')).toBeDisabled();
  });

  it('shows a reveal-folder toolbar action for rich preview files instead of diff toggle', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [{
            filePath: '/tmp/report.pdf',
            fileName: 'report.pdf',
            ext: '.pdf',
            mimeType: 'application/pdf',
            contentType: 'pdf',
            sourceTool: 'write',
            action: 'created',
            baseline: '',
            content: '',
            lineStats: { added: 0, removed: 0 },
            toolId: 'write-1',
          }],
        }]}
        artifactFocusedFile={{
          filePath: '/tmp/report.pdf',
          fileName: 'report.pdf',
          ext: '.pdf',
          mimeType: 'application/pdf',
          contentType: 'pdf',
          sourceTool: 'write',
          action: 'created',
          baseline: '',
          content: '',
          lineStats: { added: 0, removed: 0 },
          toolId: 'write-1',
        }}
        artifactActiveSection="preview"
        artifactViewMode="preview"
        artifactWorkspaceRoot="/workspace"
      />,
    );

    expect(screen.getByTestId('chat-artifact-section-changes')).toBeDisabled();
    const revealButtons = screen.getAllByRole('button', { name: 'artifacts.reveal' });
    fireEvent.click(revealButtons[revealButtons.length - 1]!);
    expect(mockShowItemInFolder).toHaveBeenCalledWith('shell:showItemInFolder', '/tmp/report.pdf');
  });

  it('keeps the diff toolbar action for diff-capable files', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [{
            filePath: '/workspace/demo.ts',
            fileName: 'demo.ts',
            ext: '.ts',
            mimeType: 'text/typescript',
            contentType: 'code',
            sourceTool: 'edit',
            action: 'modified',
            baseline: 'const value = 1;\n',
            content: 'const value = 2;\n',
            lineStats: { added: 1, removed: 1 },
            toolId: 'edit-1',
          }],
        }]}
        artifactFocusedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        artifactActiveSection="preview"
        artifactViewMode="preview"
        artifactWorkspaceRoot="/workspace"
      />,
    );

    expect(screen.getAllByRole('button', { name: 'artifacts.changesTab' }).length).toBeGreaterThan(0);
  });

  it('keeps workspace section active when selecting a file from the workspace browser', () => {
    const onArtifactFocusFile = vi.fn();
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactGroups={[{
          graphItemKey: 'graph-1',
          files: [{
            filePath: '/workspace/demo.ts',
            fileName: 'demo.ts',
            ext: '.ts',
            mimeType: 'text/typescript',
            contentType: 'code',
            sourceTool: 'edit',
            action: 'modified',
            baseline: 'const value = 1;\n',
            content: 'const value = 2;\n',
            lineStats: { added: 1, removed: 1 },
            toolId: 'edit-1',
          }],
        }]}
        artifactFocusedFile={{
          filePath: '/workspace/demo.ts',
          fileName: 'demo.ts',
          ext: '.ts',
          mimeType: 'text/typescript',
          contentType: 'code',
          sourceTool: 'edit',
          action: 'modified',
          baseline: 'const value = 1;\n',
          content: 'const value = 2;\n',
          lineStats: { added: 1, removed: 1 },
          toolId: 'edit-1',
        }}
        artifactActiveSection="workspace"
        artifactViewMode="preview"
        artifactWorkspaceRoot="/workspace"
        onArtifactFocusFile={onArtifactFocusFile}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-workspace-file' }));
    expect(onArtifactFocusFile).toHaveBeenCalledWith(expect.objectContaining({
      filePath: '/workspace/notes.md',
    }), { preserveSection: 'workspace' });
  });

  it('keeps workspace root stable when a directory is focused from the workspace browser', () => {
    const onArtifactFocusFile = vi.fn();
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="artifacts"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
        artifactActiveSection="workspace"
        artifactViewMode="preview"
        artifactWorkspaceRoot="/workspace"
        onArtifactFocusFile={onArtifactFocusFile}
      />,
    );

    expect(screen.getByTestId('workspace-browser-body')).toHaveTextContent('none');
  });

  it('renders the inline skill configuration content inside the shared side panel', () => {
    render(
      <ChatSidePanel
        mode="overlay"
        width={320}
        activeTab="skills"
        onTabChange={vi.fn()}
        onClose={vi.fn()}
        unfinishedTaskCount={0}
        {...skillConfigProps}
      />,
    );

    expect(screen.getByText('skill-config · main')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Skill A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'skillConfigDialog.save' })).toBeNull();
    expect(screen.getByRole('tabpanel').className).toContain('data-[state=active]:flex');
  });

  it('renders empty-state content in the stage center instead of the bottom composer overlay', () => {
    render(
      <ChatShell
        chatLayoutRef={{ current: null }}
        sidePanelOpen={false}
        sidePanelMode="hidden"
        sidePanelWidth={0}
        artifactWorkbenchFullscreen={false}
        isEmptyState
        emptyState={<div data-testid="chat-empty-state"><div data-testid="chat-input" /></div>}
        sidePanel={<div data-testid="chat-side-panel" />}
        header={<div data-testid="chat-header" />}
        viewportPane={<div data-testid="thread-panel" />}
        errorBanner={null}
        approvalDock={null}
        input={<div data-testid="chat-bottom-input" />}
      />,
    );

    expect(screen.getByTestId('chat-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('thread-panel')).toBeNull();
    expect(screen.queryByTestId('chat-stage-bottom-fade')).toBeNull();
    const centeredHost = screen.getByTestId('chat-empty-state').parentElement as HTMLElement | null;
    expect(centeredHost?.className).toContain('items-center');
    expect(screen.queryByTestId('chat-bottom-input')).toBeNull();
  });

  it('recomputes composer safe offset when the stage switches from empty state back to normal chat mode', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
      if (this.dataset.testid === 'chat-stage-header-overlay') {
        return DOMRect.fromRect({
          x: 0,
          y: 0,
          width: 640,
          height: 56,
        });
      }
      if (typeof this.className === 'string' && this.className.includes('absolute inset-x-0 bottom-0 z-20')) {
        return DOMRect.fromRect({
          x: 0,
          y: 0,
          width: 640,
          height: 132,
        });
      }
      return DOMRect.fromRect({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      });
    });

    try {
      const { container, rerender } = render(
        <ChatShell
          chatLayoutRef={{ current: null }}
          sidePanelOpen={false}
          sidePanelMode="hidden"
          sidePanelWidth={0}
          artifactWorkbenchFullscreen={false}
          isEmptyState
          emptyState={<div data-testid="chat-empty-state"><div data-testid="chat-input" /></div>}
          sidePanel={<div data-testid="chat-side-panel" />}
          header={<div data-testid="chat-header" />}
          viewportPane={<div data-testid="thread-panel" />}
          errorBanner={null}
          approvalDock={null}
          input={<div data-testid="chat-bottom-input" />}
        />,
      );

      const stage = container.querySelector('.chat-scroll-sync') as HTMLElement | null;
      expect(stage?.style.getPropertyValue('--chat-header-safe-offset')).toBe('0px');
      expect(stage?.style.getPropertyValue('--chat-thread-top-padding')).toBe('8px');
      expect(stage?.style.getPropertyValue('--chat-composer-safe-offset')).toBe('0px');
      expect(stage?.style.getPropertyValue('--chat-thread-bottom-padding')).toBe('12px');

      rerender(
        <ChatShell
          chatLayoutRef={{ current: null }}
          sidePanelOpen={false}
          sidePanelMode="hidden"
          sidePanelWidth={0}
          artifactWorkbenchFullscreen={false}
          isEmptyState={false}
          emptyState={null}
          sidePanel={<div data-testid="chat-side-panel" />}
          header={<div data-testid="chat-header" />}
          viewportPane={<div data-testid="thread-panel" />}
          errorBanner={null}
          approvalDock={null}
          input={<div data-testid="chat-bottom-input" />}
        />,
      );

      expect(stage?.style.getPropertyValue('--chat-header-safe-offset')).toBe('56px');
      expect(stage?.style.getPropertyValue('--chat-thread-top-padding')).toBe('64px');
      expect(stage?.style.getPropertyValue('--chat-composer-safe-offset')).toBe('132px');
      expect(stage?.style.getPropertyValue('--chat-thread-bottom-padding')).toBe('144px');
    } finally {
      rectSpy.mockRestore();
    }
  });
});
