import { notes } from '@serenity-js/core';
import { Attribute, Text } from '@serenity-js/web';
import { TasksLifecyclePage } from '../pages/tasks-lifecycle.page.js';

type LifecycleNotes = {
  tasksLifecyclePrivateMarker: string;
  tasksLifecycleRejections: { rejected: boolean[]; privateDataWasExposed: boolean };
  tasksLifecycleOwnedTask: { id: string; subject: string; description: string; status: string };
  tasksLifecycleUpdateRejection: { rejected: boolean; privateDataWasExposed: boolean };
  tasksLifecycleCompleted: boolean;
  tasksLifecycleDeleted: boolean;
  tasksLifecycleCleanupTarget: boolean;
  tasksLifecycleRuntime: string;
  tasksLifecycleOwnDialog: boolean;
};

export const LifecyclePrivateMarker = () => notes<LifecycleNotes>().get('tasksLifecyclePrivateMarker');
export const InvalidTaskRejections = () => notes<LifecycleNotes>().get('tasksLifecycleRejections').rejected;
export const TaskRequestExposedPrivateData = () => notes<LifecycleNotes>().get('tasksLifecycleRejections').privateDataWasExposed;
export const OwnedLifecycleTask = () => notes<LifecycleNotes>().get('tasksLifecycleOwnedTask');
export const LifecycleCompletionWasApplied = () => notes<LifecycleNotes>().get('tasksLifecycleCompleted');
export const LifecycleDeletionWasConfirmed = () => notes<LifecycleNotes>().get('tasksLifecycleDeleted');
export const TaskCenterOwnedStatus = () => Attribute.called('aria-label').of(TasksLifecyclePage.rowStatus(OwnedLifecycleTask().subject));
export const TaskCenterOwnedId = () => Text.of(TasksLifecyclePage.detailId(OwnedLifecycleTask().subject));
export const TaskCenterOwnedDetail = () => Text.of(TasksLifecyclePage.detail(OwnedLifecycleTask().subject));
export const TaskCenterErrorCount = () => TasksLifecyclePage.errors.count();
export const InvalidLifecycleUpdateWasRejected = () => notes<LifecycleNotes>().get('tasksLifecycleUpdateRejection').rejected;
export const LifecycleUpdateExposedPrivateData = () => notes<LifecycleNotes>().get('tasksLifecycleUpdateRejection').privateDataWasExposed;
export const OwnedTaskTitleIsVisible = () => TasksLifecyclePage.title(OwnedLifecycleTask().subject).isVisible();
export const LifecycleHasCleanupTarget = () => notes<LifecycleNotes>().get('tasksLifecycleCleanupTarget');
export const LifecyclePreviousRuntime = () => notes<LifecycleNotes>().get('tasksLifecycleRuntime');
export const LifecycleRuntimeWasSaved = () => notes<LifecycleNotes>().has('tasksLifecycleRuntime');
export const LifecycleOpenedOwnDialog = () => notes<LifecycleNotes>().has('tasksLifecycleOwnDialog');
